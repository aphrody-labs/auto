// SPDX-License-Identifier: Apache-2.0
//! `oxc_parser`-backed chunker for `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs`
//! files: one chunk per top-level function, class (expanded per-method when
//! large), exported const holding an arrow/function expression, interface,
//! type alias, or enum. Falls back to [`crate::structural_chunker`] on a
//! parse error or when the extension can't be mapped to an oxc
//! [`oxc_span::SourceType`].
//!
//! Gated behind the `oxc` feature: `oxc_parser`'s wasm32 story is not
//! verified by this crate, so a `wasm32-unknown-unknown` consumer builds
//! with `--no-default-features` and loses JS/TS-aware chunking in favour of
//! [`crate::structural_chunker::StructuralChunker`].

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, ClassElement, Declaration, ExportDefaultDeclarationKind, Expression, Statement,
};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

use crate::{
    chunk::{Chunk, ChunkKind, ChunkOptions, Chunker, Language},
    structural_chunker::StructuralChunker,
    text::{gap_fill_ranges, measure, normalize_newlines, pack_lines_with_overlap, slice_lines},
};

pub struct JsTsChunker;

fn source_type_for(path: &str) -> Option<SourceType> {
    SourceType::from_path(path).ok()
}

impl Chunker for JsTsChunker {
    fn chunk(&self, path: &str, source: &str, opts: &ChunkOptions) -> Vec<Chunk> {
        let normalized = normalize_newlines(source);
        let Some(source_type) = source_type_for(path) else {
            return StructuralChunker::new(Language::Unknown).chunk(path, &normalized, opts);
        };
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, &normalized, source_type).parse();
        if ret.fatal_error || ret.program.body.is_empty() {
            return StructuralChunker::new(Language::Unknown).chunk(path, &normalized, opts);
        }

        let lines: Vec<&str> = normalized.split('\n').collect();
        let total_lines = u32::try_from(lines.len()).unwrap_or(u32::MAX).max(1);

        // Leaf units: (symbol, start_line, end_line, is_class_for_expansion).
        let mut leaves: Vec<(Option<String>, u32, u32)> = Vec::new();
        for stmt in &ret.program.body {
            collect_statement(stmt, &lines, opts, &mut leaves);
        }
        if leaves.is_empty() {
            return StructuralChunker::new(Language::Unknown).chunk(path, &normalized, opts);
        }
        leaves.sort_by_key(|l| l.1);
        let natural: Vec<(u32, u32)> = leaves.iter().map(|(_, s, e)| (*s, *e)).collect();
        let filled = gap_fill_ranges(&natural, total_lines);

        let mut out = Vec::new();
        let mut ord = 0u32;
        for ((symbol, ..), (start_line, end_line)) in leaves.iter().zip(filled) {
            let text = slice_lines(&lines, start_line, end_line);
            if text.trim().is_empty() {
                continue;
            }
            if measure(&text, opts.length_unit) <= opts.max_chars {
                out.push(Chunk::new(
                    ord,
                    ChunkKind::Code,
                    symbol.clone(),
                    start_line,
                    end_line,
                    text,
                ));
                ord += 1;
            } else {
                let unit_lines: Vec<&str> = text.split('\n').collect();
                for packed in pack_lines_with_overlap(
                    &unit_lines,
                    start_line,
                    opts.max_chars,
                    opts.overlap_pct,
                    opts.length_unit,
                ) {
                    out.push(Chunk::new(
                        ord,
                        ChunkKind::Code,
                        symbol.clone(),
                        packed.start_line,
                        packed.end_line,
                        packed.text,
                    ));
                    ord += 1;
                }
            }
        }
        out
    }
}

fn byte_to_line(lines: &[&str], byte_offset: u32) -> u32 {
    let mut offset = 0u32;
    for (i, line) in lines.iter().enumerate() {
        let line_len = u32::try_from(line.len()).unwrap_or(0) + 1;
        if byte_offset < offset + line_len {
            return u32::try_from(i + 1).unwrap_or(1);
        }
        offset += line_len;
    }
    u32::try_from(lines.len()).unwrap_or(1).max(1)
}

fn span_to_lines(lines: &[&str], span: oxc_span::Span) -> (u32, u32) {
    (
        byte_to_line(lines, span.start),
        byte_to_line(lines, span.end.saturating_sub(1)),
    )
}

/// Best-effort symbol name for a top-level statement. `None` for statements
/// this chunker does not try to name (imports, bare expressions…) — they
/// still get a chunk via `gap_fill_ranges`, just without a `symbol`.
fn collect_statement(
    stmt: &Statement,
    lines: &[&str],
    opts: &ChunkOptions,
    out: &mut Vec<(Option<String>, u32, u32)>,
) {
    let (start, end) = span_to_lines(lines, stmt.span());
    match stmt {
        Statement::FunctionDeclaration(f) => {
            let name = f.id.as_ref().map(|id| id.name.to_string());
            out.push((name, start, end));
        }
        Statement::ClassDeclaration(c) => {
            let class_name =
                c.id.as_ref()
                    .map_or_else(|| "default".to_string(), |id| id.name.to_string());
            let text_len = end.saturating_sub(start) as usize;
            if text_len < opts.max_chars / 40 || c.body.body.is_empty() {
                // Small class: keep as a single unit.
                out.push((Some(class_name), start, end));
            } else {
                for el in &c.body.body {
                    let (es, ee) = span_to_lines(lines, el.span());
                    let method_name = class_element_name(el);
                    out.push((Some(format!("{class_name}::{method_name}")), es, ee));
                }
            }
        }
        Statement::VariableDeclaration(decl) => {
            let mut named = false;
            for d in &decl.declarations {
                if let BindingPattern::BindingIdentifier(id) = &d.id
                    && matches!(
                        d.init,
                        Some(Expression::ArrowFunctionExpression(_))
                            | Some(Expression::FunctionExpression(_))
                    )
                {
                    out.push((Some(id.name.to_string()), start, end));
                    named = true;
                }
            }
            if !named {
                out.push((None, start, end));
            }
        }
        Statement::TSInterfaceDeclaration(i) => out.push((Some(i.id.name.to_string()), start, end)),
        Statement::TSTypeAliasDeclaration(t) => out.push((Some(t.id.name.to_string()), start, end)),
        Statement::TSEnumDeclaration(e) => out.push((Some(e.id.name.to_string()), start, end)),
        Statement::ExportDeclaration(export) => {
            out.push((declaration_name(&export.declaration), start, end));
        }
        Statement::ExportNamedDeclaration(_) => out.push((None, start, end)),
        Statement::ExportDefaultDeclaration(export) => {
            let name = match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                    f.id.as_ref().map(|id| id.name.to_string())
                }
                ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                    c.id.as_ref().map(|id| id.name.to_string())
                }
                _ => None,
            };
            out.push((name.or_else(|| Some("default".to_string())), start, end));
        }
        _ => out.push((None, start, end)),
    }
}

fn declaration_name(decl: &Declaration) -> Option<String> {
    match decl {
        Declaration::FunctionDeclaration(f) => f.id.as_ref().map(|id| id.name.to_string()),
        Declaration::ClassDeclaration(c) => c.id.as_ref().map(|id| id.name.to_string()),
        Declaration::TSInterfaceDeclaration(i) => Some(i.id.name.to_string()),
        Declaration::TSTypeAliasDeclaration(t) => Some(t.id.name.to_string()),
        Declaration::TSEnumDeclaration(e) => Some(e.id.name.to_string()),
        Declaration::VariableDeclaration(v) => v.declarations.first().and_then(|d| {
            if let BindingPattern::BindingIdentifier(id) = &d.id {
                Some(id.name.to_string())
            } else {
                None
            }
        }),
        _ => None,
    }
}

fn class_element_name(el: &ClassElement) -> String {
    match el {
        ClassElement::MethodDefinition(m) => m
            .key
            .name()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "method".to_string()),
        ClassElement::PropertyDefinition(p) => p
            .key
            .name()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "field".to_string()),
        _ => "member".to_string(),
    }
}

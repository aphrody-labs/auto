// SPDX-License-Identifier: Apache-2.0
//! `syn`-backed chunker for `.rs` files: one chunk per top-level item, with
//! `impl` blocks expanded into one chunk per method and inline `mod { .. }`
//! expanded recursively. Falls back to [`crate::structural_chunker`] on a
//! parse error so a syntactically broken file still gets chunked instead of
//! being dropped.

use syn::spanned::Spanned;

use crate::{
    chunk::{Chunk, ChunkKind, ChunkOptions, Chunker, Language},
    structural_chunker::StructuralChunker,
    text::{gap_fill_ranges, measure, normalize_newlines, pack_lines_with_overlap, slice_lines},
};

pub struct RustChunker;

/// A leaf unit collected by the walk below, before line-range gap-filling.
struct RawUnit {
    symbol: Option<String>,
    start_line: u32,
    end_line: u32,
}

impl Chunker for RustChunker {
    fn chunk(&self, path: &str, source: &str, opts: &ChunkOptions) -> Vec<Chunk> {
        let normalized = normalize_newlines(source);
        let Ok(file) = syn::parse_file(&normalized) else {
            return StructuralChunker::new(Language::Unknown).chunk(path, &normalized, opts);
        };
        let lines: Vec<&str> = normalized.split('\n').collect();
        let total_lines = u32::try_from(lines.len()).unwrap_or(u32::MAX).max(1);

        let mut units = Vec::new();
        collect_items(&file.items, &mut Vec::new(), &mut units);
        if units.is_empty() {
            return StructuralChunker::new(Language::Unknown).chunk(path, &normalized, opts);
        }
        units.sort_by_key(|u| u.start_line);
        let natural: Vec<(u32, u32)> = units.iter().map(|u| (u.start_line, u.end_line)).collect();
        let bounded = gap_fill_ranges(&natural, total_lines);

        let mut out = Vec::new();
        let mut ord = 0u32;
        for (unit, (start_line, end_line)) in units.iter().zip(bounded) {
            let text = slice_lines(&lines, start_line, end_line);
            if text.trim().is_empty() {
                continue;
            }
            if measure(&text, opts.length_unit) <= opts.max_chars {
                out.push(Chunk::new(
                    ord,
                    ChunkKind::Code,
                    unit.symbol.clone(),
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
                        unit.symbol.clone(),
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

fn qualify(prefix: &[String], name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{}::{name}", prefix.join("::"))
    }
}

fn span_lines(spanned: &impl Spanned) -> (u32, u32) {
    let span = spanned.span();
    let start = span.start().line;
    let end = span.end().line;
    (
        u32::try_from(start).unwrap_or(1).max(1),
        u32::try_from(end).unwrap_or(1).max(1),
    )
}

fn collect_items(items: &[syn::Item], prefix: &mut Vec<String>, out: &mut Vec<RawUnit>) {
    for item in items {
        match item {
            syn::Item::Impl(item_impl) => {
                let self_ty = type_name(&item_impl.self_ty);
                if item_impl.items.is_empty() {
                    let (start_line, end_line) = span_lines(item_impl);
                    out.push(RawUnit {
                        symbol: Some(qualify(prefix, &self_ty)),
                        start_line,
                        end_line,
                    });
                    continue;
                }
                for impl_item in &item_impl.items {
                    let (name, (start_line, end_line)) = match impl_item {
                        syn::ImplItem::Fn(f) => (f.sig.ident.to_string(), span_lines(f)),
                        syn::ImplItem::Const(c) => (c.ident.to_string(), span_lines(c)),
                        syn::ImplItem::Type(t) => (t.ident.to_string(), span_lines(t)),
                        syn::ImplItem::Macro(m) => ("macro_invocation".to_string(), span_lines(m)),
                        other => ("item".to_string(), span_lines(other)),
                    };
                    out.push(RawUnit {
                        symbol: Some(qualify(prefix, &format!("{self_ty}::{name}"))),
                        start_line,
                        end_line,
                    });
                }
            }
            syn::Item::Mod(item_mod) => {
                if let Some((_, inner)) = &item_mod.content {
                    let name = item_mod.ident.to_string();
                    prefix.push(name);
                    collect_items(inner, prefix, out);
                    prefix.pop();
                } else {
                    let (start_line, end_line) = span_lines(item_mod);
                    out.push(RawUnit {
                        symbol: Some(qualify(prefix, &item_mod.ident.to_string())),
                        start_line,
                        end_line,
                    });
                }
            }
            syn::Item::Fn(f) => {
                let (start_line, end_line) = span_lines(f);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &f.sig.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Struct(s) => {
                let (start_line, end_line) = span_lines(s);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &s.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Enum(e) => {
                let (start_line, end_line) = span_lines(e);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &e.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Trait(t) => {
                let (start_line, end_line) = span_lines(t);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &t.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Union(u) => {
                let (start_line, end_line) = span_lines(u);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &u.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Macro(m) => {
                let (start_line, end_line) = span_lines(m);
                let name = m
                    .ident
                    .as_ref()
                    .map_or_else(|| "macro_rules".to_string(), ToString::to_string);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &name)),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Const(c) => {
                let (start_line, end_line) = span_lines(c);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &c.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Static(s) => {
                let (start_line, end_line) = span_lines(s);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &s.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            syn::Item::Type(t) => {
                let (start_line, end_line) = span_lines(t);
                out.push(RawUnit {
                    symbol: Some(qualify(prefix, &t.ident.to_string())),
                    start_line,
                    end_line,
                });
            }
            other => {
                let (start_line, end_line) = span_lines(other);
                out.push(RawUnit {
                    symbol: None,
                    start_line,
                    end_line,
                });
            }
        }
    }
}

fn type_name(ty: &syn::Type) -> String {
    if let syn::Type::Path(p) = ty
        && let Some(seg) = p.path.segments.last()
    {
        return seg.ident.to_string();
    }
    "impl".to_string()
}

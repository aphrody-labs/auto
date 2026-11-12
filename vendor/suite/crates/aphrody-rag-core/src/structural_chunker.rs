// SPDX-License-Identifier: Apache-2.0
//! Language-agnostic structural splitter: a per-language declaration regex
//! locates top-level boundaries, then either column-0 indentation (Python,
//! YAML, TOML) or brace/bracket depth (Go, Java, C#, C, C++, Kotlin, Swift,
//! shell functions, JSON) decides where each declaration's block ends. This
//! is the fallback [`crate::Chunker`] for every language that does not have
//! a dedicated AST-backed chunker, and the safety net `RustChunker` falls
//! back to on a `syn` parse error.

use std::sync::LazyLock;

use regex::Regex;

use crate::{
    chunk::{Chunk, ChunkKind, ChunkOptions, Chunker, Language},
    text::{gap_fill_ranges, measure, normalize_newlines, pack_lines_with_overlap, slice_lines},
};

pub struct StructuralChunker {
    lang: Language,
}

impl StructuralChunker {
    #[must_use]
    pub fn new(lang: Language) -> Self {
        Self { lang }
    }
}

static PY_DECL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:def|class)\s+([A-Za-z_]\w*)").unwrap());
static YAML_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_.\-]+)\s*:").unwrap());
static TOML_TABLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[\[?([^\]]+)\]\]?").unwrap());
static GO_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^type\s+([A-Za-z_]\w*)").unwrap()
});
static JVM_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)").unwrap()
});
static C_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:struct|class|enum|union)\s+([A-Za-z_]\w*)|^[A-Za-z_][\w:<>,\*&\s]*\s([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{?\s*$")
        .unwrap()
});
static SWIFT_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:func|class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)").unwrap()
});
static SHELL_FN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{?").unwrap());
static JSON_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*"([^"]+)"\s*:"#).unwrap());

fn first_capture(re: &Regex, line: &str) -> Option<Option<String>> {
    re.captures(line).map(|c| {
        c.iter()
            .skip(1)
            .flatten()
            .next()
            .map(|m| m.as_str().to_string())
    })
}

fn leading_ws(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Column-0 declaration boundaries (Python `def`/`class`, YAML top-level
/// keys, TOML `[table]` headers): a boundary is any line with zero
/// indentation matching `re`; its block runs until the line before the next
/// such boundary.
fn indent_based(lines: &[&str], re: &Regex) -> Vec<(Option<String>, u32, u32)> {
    let mut starts: Vec<(Option<String>, u32)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.trim().is_empty()
            && leading_ws(line) == 0
            && let Some(name) = first_capture(re, line)
        {
            starts.push((name, u32::try_from(i + 1).unwrap_or(u32::MAX)));
        }
    }
    finish_boundaries(starts, lines.len())
}

/// Brace/bracket-depth declaration boundaries: a boundary starts where
/// `depth_before(line) == target_depth` and `re` matches; its block runs to
/// the first following line whose depth returns to `target_depth`.
fn brace_based(
    lines: &[&str],
    re: &Regex,
    target_depth: i32,
    open: &[char],
    close: &[char],
) -> Vec<(Option<String>, u32, u32)> {
    let mut depth = 0i32;
    let mut depth_before = Vec::with_capacity(lines.len());
    let mut depth_after = Vec::with_capacity(lines.len());
    for line in lines {
        depth_before.push(depth);
        for ch in line.chars() {
            if open.contains(&ch) {
                depth += 1;
            } else if close.contains(&ch) {
                depth -= 1;
            }
        }
        depth_after.push(depth);
    }

    let mut starts: Vec<(Option<String>, u32)> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if depth_before[i] == target_depth
            && let Some(name) = first_capture(re, lines[i])
        {
            let start = u32::try_from(i + 1).unwrap_or(u32::MAX);
            starts.push((name, start));
            let mut j = i;
            while j < lines.len() - 1 && depth_after[j] != target_depth {
                j += 1;
            }
            i = j + 1;
            continue;
        }
        i += 1;
    }
    finish_boundaries(starts, lines.len())
}

/// Turn a list of `(name, start_line)` boundaries into `(name, natural_start,
/// natural_end)` triples ready for [`gap_fill_ranges`], collapsing to an
/// empty result (triggering the whole-file fallback) when nothing matched.
fn finish_boundaries(
    starts: Vec<(Option<String>, u32)>,
    line_count: usize,
) -> Vec<(Option<String>, u32, u32)> {
    if starts.is_empty() {
        return Vec::new();
    }
    let total = u32::try_from(line_count).unwrap_or(u32::MAX).max(1);
    let mut out = Vec::with_capacity(starts.len());
    for (idx, (name, start)) in starts.iter().enumerate() {
        let natural_end = if idx + 1 < starts.len() {
            starts[idx + 1].1.saturating_sub(1).max(*start)
        } else {
            total
        };
        out.push((name.clone(), *start, natural_end));
    }
    out
}

impl Chunker for StructuralChunker {
    fn chunk(&self, _path: &str, source: &str, opts: &ChunkOptions) -> Vec<Chunk> {
        let normalized = normalize_newlines(source);
        let lines: Vec<&str> = normalized.split('\n').collect();
        let total_lines = u32::try_from(lines.len()).unwrap_or(u32::MAX).max(1);

        let (boundaries, kind) = match self.lang {
            Language::Python => (indent_based(&lines, &PY_DECL), ChunkKind::Code),
            Language::Yaml => (indent_based(&lines, &YAML_KEY), ChunkKind::Config),
            Language::Toml => (indent_based(&lines, &TOML_TABLE), ChunkKind::Config),
            Language::Go => (
                brace_based(&lines, &GO_DECL, 0, &['{'], &['}']),
                ChunkKind::Code,
            ),
            Language::Java | Language::CSharp | Language::Kotlin => (
                brace_based(&lines, &JVM_DECL, 0, &['{'], &['}']),
                ChunkKind::Code,
            ),
            Language::C | Language::Cpp => (
                brace_based(&lines, &C_DECL, 0, &['{'], &['}']),
                ChunkKind::Code,
            ),
            Language::Swift => (
                brace_based(&lines, &SWIFT_DECL, 0, &['{'], &['}']),
                ChunkKind::Code,
            ),
            Language::Shell => (
                brace_based(&lines, &SHELL_FN, 0, &['{'], &['}']),
                ChunkKind::Code,
            ),
            Language::Json => (
                brace_based(&lines, &JSON_KEY, 1, &['{', '['], &['}', ']']),
                ChunkKind::Config,
            ),
            _ => (Vec::new(), ChunkKind::Code),
        };

        let mut out = Vec::new();
        let mut ord = 0u32;
        if boundaries.is_empty() {
            for packed in pack_lines_with_overlap(
                &lines,
                1,
                opts.max_chars,
                opts.overlap_pct,
                opts.length_unit,
            ) {
                if packed.text.trim().is_empty() {
                    continue;
                }
                out.push(Chunk::new(
                    ord,
                    kind,
                    None,
                    packed.start_line,
                    packed.end_line,
                    packed.text,
                ));
                ord += 1;
            }
            return out;
        }

        let natural: Vec<(u32, u32)> = boundaries.iter().map(|(_, s, e)| (*s, *e)).collect();
        let filled = gap_fill_ranges(&natural, total_lines);
        for ((name, ..), (start_line, end_line)) in boundaries.iter().zip(filled) {
            let text = slice_lines(&lines, start_line, end_line);
            if text.trim().is_empty() {
                continue;
            }
            if measure(&text, opts.length_unit) <= opts.max_chars {
                out.push(Chunk::new(
                    ord,
                    kind,
                    name.clone(),
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
                        kind,
                        name.clone(),
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

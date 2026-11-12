// SPDX-License-Identifier: Apache-2.0
//! Markdown chunker: splits on ATX (`#`) and Setext (`===`/`---`) headings,
//! carrying the heading trail (`Install > Linux`) as `symbol`; front-matter
//! is kept as a single [`crate::chunk::ChunkKind::Config`] chunk; fenced
//! code blocks are never split mid-fence; long sections fall through to the
//! same sentence-packing algorithm as [`crate::prose_chunker::ProseChunker`].

use std::sync::LazyLock;

use regex::Regex;

use crate::{
    chunk::{Chunk, ChunkKind, ChunkOptions, Chunker},
    text::{
        Sentence, normalize_newlines, pack_sentences_with_overlap, split_sentences_with_offsets,
    },
};

pub struct MarkdownChunker;

static ATX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*#*$").unwrap());
static SETEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(=+|-+)\s*$").unwrap());

struct Section {
    trail: String,
    /// 1-based line number of the section's first content line (excludes the
    /// heading line itself, matching `_rag-chunk.ts`'s `emitSectionChunks`).
    base_line: u32,
    lines: Vec<String>,
    /// 1-based line number of the heading line(s) immediately above this
    /// section's content (the ATX `#` line, or the Setext title+underline
    /// pair's *first* line), if any. `_rag-chunk.ts` never emits the heading
    /// line as part of any chunk's `content`; this crate's line-coverage
    /// invariant instead folds it into the section's *first* emitted
    /// chunk's `start_line` — the text is unaffected, only the line range.
    heading_start_line: Option<u32>,
}

impl Chunker for MarkdownChunker {
    fn chunk(&self, _path: &str, source: &str, opts: &ChunkOptions) -> Vec<Chunk> {
        let normalized = normalize_newlines(source);
        let mut lines: Vec<&str> = normalized.split('\n').collect();
        let mut ord = 0u32;
        let mut out = Vec::new();
        let mut line_no = 1u32;

        // Front-matter: a `---` delimited block at the very top of the file.
        if lines.first().is_some_and(|l| l.trim() == "---")
            && let Some(close) = lines.iter().skip(1).position(|l| l.trim() == "---")
        {
            let end = close + 1; // index of the closing `---`
            let text = lines[..=end].join("\n");
            out.push(Chunk::new(
                ord,
                ChunkKind::Config,
                None,
                1,
                u32::try_from(end + 1).unwrap_or(1),
                text,
            ));
            ord += 1;
            line_no = u32::try_from(end + 2).unwrap_or(line_no);
            lines = lines.split_off(end + 1);
        }

        let mut sections: Vec<Section> = Vec::new();
        let mut hierarchy: Vec<String> = Vec::new();
        let mut current_trail = String::new();
        let mut current_base = line_no;
        let mut current_heading_start: Option<u32> = None;
        let mut current_lines: Vec<String> = Vec::new();
        let mut fence: Option<&'static str> = None;
        let mut prev_line: Option<&str> = None;

        let flush = |sections: &mut Vec<Section>,
                     trail: &str,
                     base: u32,
                     heading_start: Option<u32>,
                     lines: &[String]| {
            if !lines.is_empty() {
                sections.push(Section {
                    trail: trail.to_string(),
                    base_line: base,
                    lines: lines.to_vec(),
                    heading_start_line: heading_start,
                });
            }
        };

        let mut i = 0usize;
        while i < lines.len() {
            let line = lines[i];
            let this_line_no = line_no + u32::try_from(i).unwrap_or(0);
            let trimmed_start = line.trim_start();
            if let Some(marker) = fence {
                current_lines.push(line.to_string());
                if trimmed_start.starts_with(marker) {
                    fence = None;
                }
                prev_line = Some(line);
                i += 1;
                continue;
            }
            if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
                fence = Some(if trimmed_start.starts_with("```") {
                    "```"
                } else {
                    "~~~"
                });
                current_lines.push(line.to_string());
                prev_line = Some(line);
                i += 1;
                continue;
            }
            if let Some(caps) = ATX.captures(line) {
                flush(
                    &mut sections,
                    &current_trail,
                    current_base,
                    current_heading_start,
                    &current_lines,
                );
                current_lines.clear();
                let level = caps[1].len();
                let title = caps[2].trim().to_string();
                set_heading(&mut hierarchy, level, title);
                current_trail = hierarchy
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" > ");
                current_base = this_line_no + 1;
                current_heading_start = Some(this_line_no);
                prev_line = None;
                i += 1;
                continue;
            }
            if let (Some(prev), true) = (prev_line, SETEXT.is_match(line))
                && !prev.trim().is_empty()
            {
                // The previous line was a heading title, not content:
                // pull it back out of the accumulated section lines.
                current_lines.pop();
                flush(
                    &mut sections,
                    &current_trail,
                    current_base,
                    current_heading_start,
                    &current_lines,
                );
                current_lines.clear();
                let level = if line.trim_start().starts_with('=') {
                    1
                } else {
                    2
                };
                set_heading(&mut hierarchy, level, prev.trim().to_string());
                current_trail = hierarchy
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" > ");
                current_base = this_line_no + 1;
                current_heading_start = Some(this_line_no.saturating_sub(1));
                prev_line = None;
                i += 1;
                continue;
            }
            current_lines.push(line.to_string());
            prev_line = Some(line);
            i += 1;
        }
        flush(
            &mut sections,
            &current_trail,
            current_base,
            current_heading_start,
            &current_lines,
        );

        for section in sections {
            let borrowed: Vec<&str> = section.lines.iter().map(String::as_str).collect();
            let units = build_units(&borrowed, section.base_line, opts.cjk_sentence_breaks);
            if units.is_empty() {
                continue;
            }
            let prefix = if section.trail.is_empty() {
                String::new()
            } else {
                format!("[{}] ", section.trail)
            };
            let mut packed = pack_sentences_with_overlap(
                &units,
                opts.max_chars,
                opts.overlap_pct,
                &prefix,
                opts.length_unit,
                opts.cjk_sentence_breaks,
            );
            let kind = if packed.len() <= 1 {
                ChunkKind::Heading
            } else {
                ChunkKind::Prose
            };
            let symbol = if section.trail.is_empty() {
                None
            } else {
                Some(section.trail.clone())
            };
            // The heading line(s) above this section are never part of any
            // chunk's `content` (matching `_rag-chunk.ts`), but must still be
            // covered by *some* chunk's line range: fold them into the
            // section's first emitted chunk.
            if let (Some(first), Some(heading_start)) =
                (packed.first_mut(), section.heading_start_line)
            {
                first.start_line = first.start_line.min(heading_start);
            }
            for p in packed {
                if p.text.trim().is_empty() {
                    continue;
                }
                out.push(Chunk::new(
                    ord,
                    kind,
                    symbol.clone(),
                    p.start_line,
                    p.end_line,
                    p.text,
                ));
                ord += 1;
            }
        }
        out
    }
}

fn set_heading(hierarchy: &mut Vec<String>, level: usize, title: String) {
    hierarchy.truncate(level.saturating_sub(1));
    while hierarchy.len() < level.saturating_sub(1) {
        hierarchy.push(String::new());
    }
    if hierarchy.len() == level - 1 {
        hierarchy.push(title);
    } else {
        hierarchy[level - 1] = title;
    }
}

/// Build the ordered sequence of packable units for a section: fenced code
/// blocks become one atomic, unsplittable [`Sentence`]-shaped unit each;
/// everything else is sentence-split as usual.
fn build_units(lines: &[&str], base_line: u32, cjk_sentence_breaks: bool) -> Vec<Sentence> {
    let mut units = Vec::new();
    let mut i = 0usize;
    let mut plain_start = 0usize;

    let flush_plain = |units: &mut Vec<Sentence>, start_idx: usize, end_idx: usize| {
        if start_idx >= end_idx {
            return;
        }
        let joined = lines[start_idx..end_idx].join("\n");
        let sub_base = base_line + u32::try_from(start_idx).unwrap_or(0);
        units.extend(split_sentences_with_offsets(
            &joined,
            sub_base,
            cjk_sentence_breaks,
        ));
    };

    while i < lines.len() {
        let trimmed = lines[i].trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            flush_plain(&mut units, plain_start, i);
            let marker = if trimmed.starts_with("```") {
                "```"
            } else {
                "~~~"
            };
            let fence_start = i;
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with(marker) {
                i += 1;
            }
            let fence_end = i.min(lines.len().saturating_sub(1));
            let text = lines[fence_start..=fence_end].join("\n");
            units.push(Sentence {
                text,
                start_line: base_line + u32::try_from(fence_start).unwrap_or(0),
                end_line: base_line + u32::try_from(fence_end).unwrap_or(0),
            });
            i = fence_end + 1;
            plain_start = i;
            continue;
        }
        i += 1;
    }
    flush_plain(&mut units, plain_start, lines.len());
    units
}

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::Arc;

use craft_pdf::cos::{Dict, Document, ObjRef, Object, PdfString, SaveOptions, Stream, write_full};
use serde::{Deserialize, Serialize};

use crate::FileError;
use crate::pdf_ops::{FontDecoder, ShowOperand, collect_pages, extract_stream_lines, page_content_parts, page_fonts};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionPattern {
    Iban,
    Email,
    Phone,
    CreditCard,
    Date,
}

impl RedactionPattern {
    fn label(self) -> &'static str {
        match self {
            RedactionPattern::Iban => "pattern:iban",
            RedactionPattern::Email => "pattern:email",
            RedactionPattern::Phone => "pattern:phone",
            RedactionPattern::CreditCard => "pattern:credit_card",
            RedactionPattern::Date => "pattern:date",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionOptions {
    #[serde(default)]
    pub texts: Vec<String>,
    #[serde(default)]
    pub patterns: Vec<RedactionPattern>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_words: bool,
    #[serde(default)]
    pub overlay_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCount {
    pub query: String,
    pub occurrences: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionReport {
    pub occurrences: usize,
    pub pages: Vec<usize>,
    pub by_query: Vec<QueryCount>,
    pub glyphs: usize,
    pub images: usize,
    pub paths: usize,
    pub annotations: usize,
    pub fields: usize,
}

struct MatchSpan {
    query: String,
    start: usize,
    end: usize,
}

pub fn redact_pdf(pdf: &[u8], opts: &RedactionOptions) -> Result<(Vec<u8>, RedactionReport), FileError> {
    let mut doc = Document::open(Arc::new(pdf.to_vec()))?;
    let pages = collect_pages(&doc)?;

    let mut report = RedactionReport::default();
    let mut pages_touched = BTreeSet::new();
    let mut query_counts: BTreeMap<String, usize> = BTreeMap::new();

    for (page_idx, page) in pages.iter().enumerate() {
        let fonts = page_fonts(&doc, page);
        let parts = page_content_parts(&doc, page.page_ref)?;
        let mut page_hit = false;

        let mut replacement_streams: Vec<(Option<ObjRef>, Vec<u8>)> = Vec::with_capacity(parts.len());
        let mut inline_dirty = false;

        for part in parts {
            let lines = extract_stream_lines(&part.bytes, &fonts);
            let mut op_redacted_slices: HashMap<usize, HashSet<usize>> = HashMap::new();
            let mut stream_ops: Vec<&ShowOperand> = Vec::new();
            let mut overlay_boxes: Vec<(f32, f32, f32, f32)> = Vec::new();

            for line in &lines {
                let matches = find_matches(&line.text, opts);
                if matches.is_empty() {
                    continue;
                }
                page_hit = true;
                for m in &matches {
                    report.occurrences += 1;
                    *query_counts.entry(m.query.clone()).or_insert(0) += 1;
                }

                let mut matched_chars = vec![false; line.text.len()];
                for m in &matches {
                    for b in &mut matched_chars[m.start..m.end] {
                        *b = true;
                    }
                }

                let mut per_line_ops = Vec::new();
                for (op_idx, slice_idx, gs, ge) in &line.char_map {
                    let hit = *gs < *ge && matched_chars[*gs..*ge].iter().any(|&v| v);
                    if hit {
                        let global_op_idx = stream_ops.len() + *op_idx;
                        if op_redacted_slices.entry(global_op_idx).or_default().insert(*slice_idx) {
                            report.glyphs += 1;
                        }
                        if per_line_ops.last() != Some(op_idx) {
                            per_line_ops.push(*op_idx);
                        }
                    }
                }
                for op_idx in per_line_ops {
                    if let Some(op) = line.operands.get(op_idx) {
                        let approx_w = ((op.slices.len().max(1) as f32) * op.font_size * 0.5).max(18.0);
                        overlay_boxes.push((op.x, op.y - 2.0, approx_w, op.font_size + 4.0));
                    }
                }
                stream_ops.extend(line.operands.iter());
            }

            if op_redacted_slices.is_empty() {
                replacement_streams.push((part.stream_ref, part.bytes));
                continue;
            }

            let mut splices: Vec<(usize, usize, Vec<u8>)> = Vec::new();
            for (global_op_idx, slice_set) in &op_redacted_slices {
                let op = stream_ops[*global_op_idx];
                let decoder = fonts.get(&op.font_name);
                let rebuilt = rewrite_operand(op, slice_set, decoder, opts.overlay_text.as_deref());
                splices.push((op.start, op.end, rebuilt));
            }
            splices.sort_by_key(|a| std::cmp::Reverse(a.0));

            let mut updated = part.bytes;
            for (s, e, rep) in splices {
                if s <= e && e <= updated.len() {
                    updated.splice(s..e, rep);
                }
            }
            if !overlay_boxes.is_empty() {
                let mut box_ops = String::from("\nq 0 0 0 rg ");
                for (x, y, w, h) in overlay_boxes {
                    let _ = write!(box_ops, "{x:.2} {y:.2} {w:.2} {h:.2} re f ");
                    report.paths += 1;
                }
                box_ops.push_str("Q\n");
                updated.extend_from_slice(box_ops.as_bytes());
            }

            inline_dirty = true;
            replacement_streams.push((part.stream_ref, updated));
        }

        if inline_dirty {
            apply_updated_streams(&mut doc, page.page_ref, &replacement_streams);
        }

        // Redact text inside page annotations if any match.
        let annot_hits = redact_page_annotations(&mut doc, page.page_ref, opts, &mut query_counts)?;
        if annot_hits > 0 {
            page_hit = true;
            report.annotations += annot_hits;
            report.occurrences += annot_hits;
        }

        if page_hit {
            pages_touched.insert(page_idx + 1);
        }
    }

    report.fields = redact_acroform_fields(&mut doc, opts, &mut query_counts)?;
    report.occurrences += report.fields;
    report.pages = pages_touched.into_iter().collect();
    report.by_query = query_counts.into_iter().map(|(query, occurrences)| QueryCount { query, occurrences }).collect();

    doc.require_full_save_with_new_id();
    let save_opts = SaveOptions { object_streams: false, ..Default::default() };
    Ok((write_full(&doc, &save_opts)?, report))
}

fn rewrite_operand(
    op: &ShowOperand,
    redacted: &HashSet<usize>,
    decoder: Option<&FontDecoder>,
    overlay_text: Option<&str>,
) -> Vec<u8> {
    let mut new_raw = Vec::new();
    let mut emitted_overlay = false;
    for (idx, sl) in op.slices.iter().enumerate() {
        if redacted.contains(&idx) {
            if !emitted_overlay {
                emitted_overlay = true;
                if let Some(overlay) = overlay_text
                    && let Some(dec) = decoder
                {
                    for ch in overlay.chars() {
                        if let Some(encoded) = dec.encode_char(ch) {
                            new_raw.extend_from_slice(encoded);
                        }
                    }
                } else if let Some(dec) = decoder
                    && let Some(sp) = dec.encode_char(' ')
                {
                    new_raw.extend_from_slice(sp);
                }
            }
        } else {
            new_raw.extend_from_slice(&sl.raw_bytes);
        }
    }

    if op.is_hex {
        let mut hex = Vec::with_capacity(new_raw.len() * 2 + 2);
        hex.push(b'<');
        for b in new_raw {
            write_hex_byte(&mut hex, b);
        }
        hex.push(b'>');
        hex
    } else {
        let mut lit = Vec::with_capacity(new_raw.len() + 2);
        lit.push(b'(');
        for b in new_raw {
            if matches!(b, b'(' | b')' | b'\\') {
                lit.push(b'\\');
            }
            lit.push(b);
        }
        lit.push(b')');
        lit
    }
}

fn write_hex_byte(out: &mut Vec<u8>, b: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push(HEX[(b >> 4) as usize]);
    out.push(HEX[(b & 0x0F) as usize]);
}

fn apply_updated_streams(doc: &mut Document, page_ref: ObjRef, updated: &[(Option<ObjRef>, Vec<u8>)]) {
    if updated.iter().all(|(r, _)| r.is_some()) {
        for (opt_ref, bytes) in updated {
            if let Some(r) = opt_ref {
                doc.set(*r, Stream::flate(Dict::new(), bytes));
            }
        }
        return;
    }
    let streams: Vec<Object> =
        updated.iter().map(|(_, bytes)| Object::Ref(doc.add(Stream::flate(Dict::new(), bytes)))).collect();
    let _ = doc.update_dict(page_ref, |d| {
        if streams.len() == 1 {
            d.set(b"Contents".to_vec(), streams[0].clone());
        } else {
            d.set(b"Contents".to_vec(), Object::Array(streams));
        }
    });
}

fn redact_page_annotations(
    doc: &mut Document,
    page_ref: ObjRef,
    opts: &RedactionOptions,
    query_counts: &mut BTreeMap<String, usize>,
) -> Result<usize, FileError> {
    let page_obj = doc.get(page_ref);
    let Some(page_dict) = doc.dict(&page_obj) else {
        return Ok(0);
    };
    let Some(annots_obj) = page_dict.get(b"Annots") else {
        return Ok(0);
    };
    let resolved = doc.resolve(annots_obj);
    let Some(arr) = resolved.as_array() else {
        return Ok(0);
    };
    let refs: Vec<ObjRef> = arr.iter().filter_map(Object::as_ref).collect();
    let replacement = opts.overlay_text.as_deref().unwrap_or("[REDACTED]");
    let mut hits = 0usize;
    for r in refs {
        let obj = doc.get(r);
        let Some(mut d) = doc.dict(&obj) else {
            continue;
        };
        let mut modified = false;
        for key in [b"Contents".as_slice(), b"V".as_slice(), b"RC".as_slice()] {
            if let Some(val_obj) = d.get(key)
                && let Some(ps) = val_obj.as_string()
            {
                let text = ps.to_text();
                let matches = find_matches(&text, opts);
                if !matches.is_empty() {
                    hits += matches.len();
                    for m in &matches {
                        *query_counts.entry(m.query.clone()).or_insert(0) += 1;
                    }
                    let scrubbed = mask_matches(&text, &matches, replacement);
                    d.set(key.to_vec(), PdfString::text(&scrubbed));
                    modified = true;
                }
            }
        }
        if modified {
            doc.set(r, d);
        }
    }
    Ok(hits)
}

fn redact_acroform_fields(
    doc: &mut Document,
    opts: &RedactionOptions,
    query_counts: &mut BTreeMap<String, usize>,
) -> Result<usize, FileError> {
    let Some(root_ref) = doc.root() else {
        return Ok(0);
    };
    let root_obj = doc.get(root_ref);
    let Some(root) = doc.dict(&root_obj) else {
        return Ok(0);
    };
    let Some(acro_obj) = root.get(b"AcroForm") else {
        return Ok(0);
    };
    let Some(acro) = doc.dict(acro_obj) else {
        return Ok(0);
    };
    let Some(fields_obj) = acro.get(b"Fields") else {
        return Ok(0);
    };
    let resolved = doc.resolve(fields_obj);
    let Some(fields) = resolved.as_array() else {
        return Ok(0);
    };
    let refs: Vec<ObjRef> = fields.iter().filter_map(Object::as_ref).collect();
    let replacement = opts.overlay_text.as_deref().unwrap_or("[REDACTED]");
    let mut hits = 0usize;
    let mut visited = HashSet::new();
    for r in refs {
        hits += redact_field_tree(doc, r, opts, replacement, query_counts, &mut visited);
    }
    Ok(hits)
}

fn redact_field_tree(
    doc: &mut Document,
    r: ObjRef,
    opts: &RedactionOptions,
    replacement: &str,
    query_counts: &mut BTreeMap<String, usize>,
    visited: &mut HashSet<ObjRef>,
) -> usize {
    if !visited.insert(r) {
        return 0;
    }
    let obj = doc.get(r);
    let Some(mut d) = doc.dict(&obj) else {
        return 0;
    };
    let mut hits = 0usize;
    if let Some(val_obj) = d.get(b"V")
        && let Some(ps) = val_obj.as_string()
    {
        let text = ps.to_text();
        let matches = find_matches(&text, opts);
        if !matches.is_empty() {
            hits += matches.len();
            for m in &matches {
                *query_counts.entry(m.query.clone()).or_insert(0) += 1;
            }
            d.set(b"V".to_vec(), PdfString::text(&mask_matches(&text, &matches, replacement)));
            doc.set(r, d.clone());
        }
    }
    if let Some(kids_obj) = d.get(b"Kids") {
        let resolved = doc.resolve(kids_obj);
        if let Some(kids) = resolved.as_array() {
            for kid in kids {
                if let Some(kr) = kid.as_ref() {
                    hits += redact_field_tree(doc, kr, opts, replacement, query_counts, visited);
                }
            }
        }
    }
    hits
}

fn mask_matches(text: &str, matches: &[MatchSpan], replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cur = 0usize;
    for m in matches {
        if m.start > cur {
            out.push_str(&text[cur..m.start]);
        }
        out.push_str(replacement);
        cur = cur.max(m.end);
    }
    if cur < text.len() {
        out.push_str(&text[cur..]);
    }
    out
}

fn find_matches(text: &str, opts: &RedactionOptions) -> Vec<MatchSpan> {
    let mut raw = Vec::new();
    for needle in &opts.texts {
        if needle.is_empty() {
            continue;
        }
        collect_literal_matches(text, needle, opts.case_sensitive, opts.whole_words, &mut raw);
    }
    for &pat in &opts.patterns {
        match pat {
            RedactionPattern::Email => collect_email_matches(text, pat.label(), &mut raw),
            RedactionPattern::Iban => collect_iban_matches(text, pat.label(), &mut raw),
            RedactionPattern::Phone => collect_phone_matches(text, pat.label(), &mut raw),
            RedactionPattern::CreditCard => collect_credit_card_matches(text, pat.label(), &mut raw),
            RedactionPattern::Date => collect_date_matches(text, pat.label(), &mut raw),
        }
    }
    raw.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut non_overlapping: Vec<MatchSpan> = Vec::new();
    for span in raw {
        if non_overlapping.last().is_none_or(|prev| span.start >= prev.end) {
            non_overlapping.push(span);
        }
    }
    non_overlapping
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn collect_literal_matches(
    text: &str,
    needle: &str,
    case_sensitive: bool,
    whole_words: bool,
    out: &mut Vec<MatchSpan>,
) {
    if case_sensitive {
        let mut from = 0usize;
        while let Some(pos) = text[from..].find(needle) {
            let start = from + pos;
            let end = start + needle.len();
            if !whole_words || word_boundary(text, start, end) {
                out.push(MatchSpan { query: needle.to_owned(), start, end });
            }
            from = end;
        }
        return;
    }
    // ASCII case-insensitive substring scan aligned to byte offsets.
    let hay = text.as_bytes();
    let ndl = needle.as_bytes();
    if ndl.len() > hay.len() {
        return;
    }
    let mut i = 0usize;
    while i + ndl.len() <= hay.len() {
        if text.is_char_boundary(i)
            && text.is_char_boundary(i + ndl.len())
            && hay[i..i + ndl.len()].eq_ignore_ascii_case(ndl)
            && (!whole_words || word_boundary(text, i, i + ndl.len()))
        {
            out.push(MatchSpan { query: needle.to_owned(), start: i, end: i + ndl.len() });
            i += ndl.len();
        } else {
            i += 1;
        }
    }
}

fn word_boundary(text: &str, start: usize, end: usize) -> bool {
    let bytes = text.as_bytes();
    let left_ok = start == 0 || !is_word_char(bytes[start - 1]);
    let right_ok = end == bytes.len() || !is_word_char(bytes[end]);
    left_ok && right_ok
}

fn collect_email_matches(text: &str, label: &str, out: &mut Vec<MatchSpan>) {
    let b = text.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'@' && i > 0 && i + 3 < b.len() {
            let mut start = i;
            while start > 0 && is_email_local(b[start - 1]) {
                start -= 1;
            }
            let mut end = i + 1;
            while end < b.len() && is_email_domain(b[end]) {
                end += 1;
            }
            while end > i + 1 && b[end - 1] == b'.' {
                end -= 1;
            }
            if start < i
                && end > i + 3
                && text[i + 1..end].contains('.')
                && text[i + 1..end].split('.').all(|seg| !seg.is_empty())
            {
                out.push(MatchSpan { query: label.to_owned(), start, end });
                i = end;
                continue;
            }
        }
        i += 1;
    }
}

fn is_email_local(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'+' | b'%')
}

fn is_email_domain(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')
}

fn collect_iban_matches(text: &str, label: &str, out: &mut Vec<MatchSpan>) {
    let b = text.as_bytes();
    let mut i = 0usize;
    while i + 14 <= b.len() {
        if (i == 0 || !b[i - 1].is_ascii_alphanumeric())
            && b[i].is_ascii_uppercase()
            && b[i + 1].is_ascii_uppercase()
            && b[i + 2].is_ascii_digit()
            && b[i + 3].is_ascii_digit()
        {
            let mut j = i + 4;
            let mut compact_len = 4usize;
            let mut last_alnum_end = i + 4;
            while j < b.len() && compact_len < 34 {
                if b[j].is_ascii_alphanumeric() {
                    compact_len += 1;
                    last_alnum_end = j + 1;
                    j += 1;
                } else if b[j] == b' ' && j + 1 < b.len() && b[j + 1].is_ascii_alphanumeric() {
                    j += 1;
                } else {
                    break;
                }
            }
            let right_ok = last_alnum_end == b.len() || !b[last_alnum_end].is_ascii_alphanumeric();
            if compact_len >= 15 && right_ok && iban_mod97_valid(&text[i..last_alnum_end]) {
                out.push(MatchSpan { query: label.to_owned(), start: i, end: last_alnum_end });
                i = last_alnum_end;
                continue;
            }
        }
        i += 1;
    }
}

fn iban_mod97_valid(raw: &str) -> bool {
    let compact: Vec<u8> = raw.bytes().filter(u8::is_ascii_alphanumeric).collect();
    if compact.len() < 15 || compact.len() > 34 {
        return false;
    }
    let mut rem: u32 = 0;
    for &c in compact[4..].iter().chain(&compact[..4]) {
        if c.is_ascii_digit() {
            rem = (rem * 10 + u32::from(c - b'0')) % 97;
        } else if c.is_ascii_alphabetic() {
            let val = u32::from(c.to_ascii_uppercase() - b'A' + 10);
            rem = (rem * 100 + val) % 97;
        } else {
            return false;
        }
    }
    rem == 1
}

fn collect_phone_matches(text: &str, label: &str, out: &mut Vec<MatchSpan>) {
    let b = text.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if (b[i] == b'+' && i + 1 < b.len() && b[i + 1].is_ascii_digit())
            || (b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_alphanumeric()))
        {
            let mut j = if b[i] == b'+' { i + 1 } else { i };
            let mut digits = 0usize;
            let mut last_digit_end = i;
            let mut has_sep = false;
            while j < b.len() && digits < 15 {
                if b[j].is_ascii_digit() {
                    digits += 1;
                    last_digit_end = j + 1;
                    j += 1;
                } else if matches!(b[j], b' ' | b'-' | b'.') && j + 1 < b.len() && b[j + 1].is_ascii_digit() {
                    has_sep = true;
                    j += 1;
                } else {
                    break;
                }
            }
            if (b[i] == b'+' && (8..=15).contains(&digits)) || (digits == 10 && b[i] == b'0' && has_sep) {
                out.push(MatchSpan { query: label.to_owned(), start: i, end: last_digit_end });
                i = last_digit_end;
                continue;
            }
        }
        i += 1;
    }
}

fn collect_credit_card_matches(text: &str, label: &str, out: &mut Vec<MatchSpan>) {
    let b = text.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit()) {
            let mut j = i;
            let mut digits = Vec::new();
            let mut last_end = i;
            while j < b.len() && digits.len() < 19 {
                if b[j].is_ascii_digit() {
                    digits.push(b[j] - b'0');
                    last_end = j + 1;
                    j += 1;
                } else if matches!(b[j], b' ' | b'-') && j + 1 < b.len() && b[j + 1].is_ascii_digit() {
                    j += 1;
                } else {
                    break;
                }
            }
            let right_ok = last_end == b.len() || !b[last_end].is_ascii_digit();
            if (13..=19).contains(&digits.len()) && right_ok && luhn_valid(&digits) {
                out.push(MatchSpan { query: label.to_owned(), start: i, end: last_end });
                i = last_end;
                continue;
            }
        }
        i += 1;
    }
}

fn luhn_valid(digits: &[u8]) -> bool {
    let mut sum = 0u32;
    for (idx, &d) in digits.iter().rev().enumerate() {
        let mut v = u32::from(d);
        if idx % 2 == 1 {
            v *= 2;
            if v > 9 {
                v -= 9;
            }
        }
        sum += v;
    }
    sum.is_multiple_of(10)
}

fn collect_date_matches(text: &str, label: &str, out: &mut Vec<MatchSpan>) {
    let b = text.as_bytes();
    let mut i = 0usize;
    while i + 10 <= b.len() {
        let left_ok = i == 0 || !b[i - 1].is_ascii_digit();
        if left_ok {
            // YYYY-MM-DD or YYYY/MM/DD
            if b[i..i + 4].iter().all(u8::is_ascii_digit)
                && matches!(b[i + 4], b'-' | b'/')
                && b[i + 5..i + 7].iter().all(u8::is_ascii_digit)
                && b[i + 7] == b[i + 4]
                && b[i + 8..i + 10].iter().all(u8::is_ascii_digit)
                && (i + 10 == b.len() || !b[i + 10].is_ascii_digit())
            {
                out.push(MatchSpan { query: label.to_owned(), start: i, end: i + 10 });
                i += 10;
                continue;
            }
            // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
            if b[i..i + 2].iter().all(u8::is_ascii_digit)
                && matches!(b[i + 2], b'/' | b'-' | b'.')
                && b[i + 3..i + 5].iter().all(u8::is_ascii_digit)
                && b[i + 5] == b[i + 2]
                && b[i + 6..i + 10].iter().all(u8::is_ascii_digit)
                && (i + 10 == b.len() || !b[i + 10].is_ascii_digit())
            {
                out.push(MatchSpan { query: label.to_owned(), start: i, end: i + 10 });
                i += 10;
                continue;
            }
        }
        i += 1;
    }
}

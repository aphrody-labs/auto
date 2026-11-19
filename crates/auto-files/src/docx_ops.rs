use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use auto_docs::{DocParagraphStyle, DocPdfParagraph, render_docx_pdf};
use craft_wordmodel::{Block, CharProps, Document, ParaProps, Paragraph, StoryRef, para_block};
use serde::{Deserialize, Serialize};

use crate::FileError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphInput {
    pub text: String,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleDocx {
    #[serde(default)]
    pub title: Option<String>,
    pub paragraphs: Vec<ParagraphInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextReplacement {
    pub find: String,
    pub replace: String,
}

fn map_word_style(style: Option<&str>) -> Option<String> {
    match style?.trim().to_ascii_lowercase().as_str() {
        "title" => Some("Title".to_owned()),
        "heading1" | "heading 1" | "h1" => Some("Heading1".to_owned()),
        "heading2" | "heading 2" | "h2" => Some("Heading2".to_owned()),
        "heading3" | "heading 3" | "h3" => Some("Heading3".to_owned()),
        _ => None,
    }
}

fn make_paragraph(text: &str, style: Option<&str>, bold: bool) -> Paragraph {
    let char_props = CharProps { bold: bold.then_some(true), ..Default::default() };
    let mut para = Paragraph::with_text(text, char_props);
    if let Some(style_id) = map_word_style(style) {
        para.props = ParaProps { style: Some(style_id), ..Default::default() };
    }
    para
}

pub fn create_docx(input: &SimpleDocx) -> Result<Vec<u8>, FileError> {
    let mut doc = Document::new();
    let mut body = Vec::new();
    if let Some(title) = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        doc.core.title = title.to_owned();
        body.push(para_block(make_paragraph(title, Some("title"), true)));
    }
    for p in &input.paragraphs {
        body.push(para_block(make_paragraph(&p.text, p.style.as_deref(), p.bold.unwrap_or(false))));
    }
    doc.body = body;
    doc.ensure_nonempty();
    Ok(craft_docx::write(&doc)?)
}

pub fn read_docx(bytes: &[u8]) -> Result<Vec<String>, FileError> {
    let doc = craft_docx::read(bytes)?;
    let mut out = Vec::new();
    visit_blocks(&doc.body, &mut |p| out.push(p.plain_text()));
    Ok(out)
}

pub fn docx_text(bytes: &[u8]) -> Result<String, FileError> {
    let doc = craft_docx::read(bytes)?;
    Ok(doc.plain_text(StoryRef::Body))
}

pub fn template_fields_docx(bytes: &[u8]) -> Result<Vec<String>, FileError> {
    let doc = craft_docx::read(bytes)?;
    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    visit_doc_paragraphs(&doc, &mut |p| extract_placeholders(&p.text, &mut fields, &mut seen));
    Ok(fields)
}

pub fn fill_template_docx(bytes: &[u8], values: &BTreeMap<String, String>) -> Result<Vec<u8>, FileError> {
    let mut doc = craft_docx::read(bytes)?;
    let replacements: Vec<(String, String)> = values
        .iter()
        .flat_map(|(k, v)| [(format!("{{{{ {k} }}}}"), v.clone()), (format!("{{{{{k}}}}}"), v.clone())])
        .collect();
    mutate_doc_paragraphs(&mut doc, &|p| {
        apply_exact_replacements(p, &replacements)?;
        replace_trimmed_placeholders(p, values)
    })?;
    Ok(craft_docx::write(&doc)?)
}

pub fn replace_docx(bytes: &[u8], replacements: &[TextReplacement]) -> Result<Vec<u8>, FileError> {
    let mut doc = craft_docx::read(bytes)?;
    let pairs: Vec<(String, String)> =
        replacements.iter().filter(|r| !r.find.is_empty()).map(|r| (r.find.clone(), r.replace.clone())).collect();
    mutate_doc_paragraphs(&mut doc, &|p| apply_exact_replacements(p, &pairs))?;
    Ok(craft_docx::write(&doc)?)
}

pub fn docx_to_pdf(bytes: &[u8]) -> Result<Vec<u8>, FileError> {
    let doc = craft_docx::read(bytes)?;
    let mut paragraphs = Vec::new();
    collect_blocks_pdf(&doc.body, &mut paragraphs);
    if paragraphs.is_empty() {
        paragraphs.push(DocPdfParagraph { text: String::new(), style: DocParagraphStyle::Normal, bold: false });
    }
    let title = (!doc.core.title.trim().is_empty()).then_some(doc.core.title.as_str());
    Ok(render_docx_pdf(title, &paragraphs)?)
}

fn extract_placeholders(text: &str, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            break;
        };
        let key = after[..end].trim();
        if !key.is_empty() && seen.insert(key.to_owned()) {
            out.push(key.to_owned());
        }
        rest = &after[end + 2..];
    }
}

fn replace_trimmed_placeholders(p: &mut Paragraph, values: &BTreeMap<String, String>) -> Result<(), FileError> {
    let mut cursor = 0usize;
    while let Some(rel_start) = p.text[cursor..].find("{{") {
        let start = cursor + rel_start;
        let Some(rel_end) = p.text[start + 2..].find("}}") else {
            break;
        };
        let end = start + 2 + rel_end + 2;
        let key = p.text[start + 2..start + 2 + rel_end].trim().to_owned();
        if let Some(val) = values.get(&key) {
            let props = p.props_of_char(start).clone();
            p.delete(start, end)?;
            let inserted = p.insert_text(start, val, &props)?;
            cursor = start + inserted;
        } else {
            cursor = end;
        }
    }
    Ok(())
}

fn apply_exact_replacements(p: &mut Paragraph, pairs: &[(String, String)]) -> Result<(), FileError> {
    for (needle, replacement) in pairs {
        if needle.is_empty() {
            continue;
        }
        let mut cursor = 0usize;
        while let Some(rel) = p.text[cursor..].find(needle.as_str()) {
            let start = cursor + rel;
            let end = start + needle.len();
            let props = p.props_of_char(start).clone();
            p.delete(start, end)?;
            let inserted = p.insert_text(start, replacement, &props)?;
            cursor = start + inserted;
        }
    }
    Ok(())
}

fn collect_blocks_pdf(blocks: &[Arc<Block>], out: &mut Vec<DocPdfParagraph>) {
    for block in blocks {
        match block.as_ref() {
            Block::Para(p) => {
                let text = p.plain_text();
                let style = match p.props.style.as_deref() {
                    Some(s) if s.eq_ignore_ascii_case("title") => DocParagraphStyle::Title,
                    Some(s) if s.eq_ignore_ascii_case("heading1") => DocParagraphStyle::Heading1,
                    Some(s) if s.eq_ignore_ascii_case("heading2") => DocParagraphStyle::Heading2,
                    Some(s) if s.eq_ignore_ascii_case("heading3") => DocParagraphStyle::Heading3,
                    _ => DocParagraphStyle::Normal,
                };
                let bold = !p.runs.is_empty() && p.runs.iter().all(|r| r.props.bold == Some(true));
                out.push(DocPdfParagraph { text, style, bold });
            }
            Block::Table(t) => {
                for row in &t.rows {
                    let row_text: Vec<String> = row
                        .cells
                        .iter()
                        .map(|c| {
                            let mut parts = Vec::new();
                            visit_blocks(&c.blocks, &mut |p| parts.push(p.plain_text()));
                            parts.join(" ")
                        })
                        .collect();
                    out.push(DocPdfParagraph {
                        text: row_text.join(" | "),
                        style: DocParagraphStyle::Normal,
                        bold: false,
                    });
                }
            }
        }
    }
}

fn visit_doc_paragraphs(doc: &Document, f: &mut dyn FnMut(&Paragraph)) {
    visit_blocks(&doc.body, f);
    for part in doc.parts.values() {
        visit_blocks(&part.blocks, f);
    }
}

fn visit_blocks(blocks: &[Arc<Block>], f: &mut dyn FnMut(&Paragraph)) {
    for block in blocks {
        match block.as_ref() {
            Block::Para(p) => f(p),
            Block::Table(t) => {
                for row in &t.rows {
                    for cell in &row.cells {
                        visit_blocks(&cell.blocks, f);
                    }
                }
            }
        }
    }
}

fn mutate_doc_paragraphs(
    doc: &mut Document,
    f: &dyn Fn(&mut Paragraph) -> Result<(), FileError>,
) -> Result<(), FileError> {
    mutate_blocks(&mut doc.body, f)?;
    for part in doc.parts.values_mut() {
        mutate_blocks(&mut part.blocks, f)?;
    }
    Ok(())
}

fn mutate_blocks(
    blocks: &mut [Arc<Block>],
    f: &dyn Fn(&mut Paragraph) -> Result<(), FileError>,
) -> Result<(), FileError> {
    for block in blocks {
        match Arc::make_mut(block) {
            Block::Para(p) => f(p)?,
            Block::Table(t) => {
                for row in &mut t.rows {
                    for cell in &mut row.cells {
                        mutate_blocks(&mut cell.blocks, f)?;
                    }
                }
            }
        }
    }
    Ok(())
}

//! PDF document rendering for commercial invoices/quotes (`auto-model`), plus A4 DOCX and 16:9 PPTX exports.

pub mod pdf_writer;

use auto_model::{
    Document, DocumentType, RECOVERY_FEE_NOTICE_FR, VAT_EXEMPT_NOTICE_FR, format_date, format_eur, format_percent,
    format_percent_bp,
};
use auto_theme::LIGHT_PALETTE;
use pdf_writer::{PdfBuildError, PdfCanvas, decode_logo_image};
use thiserror::Error;

const A4_W: f32 = 595.28;
const A4_H: f32 = 841.89;
const SLIDE_W: f32 = 960.0;
const SLIDE_H: f32 = 540.0;
const MARGIN: f32 = 42.0;
const FOOTER_TOP: f32 = A4_H - 42.0;
const PAGE_BODY_BOTTOM: f32 = A4_H - 68.0;

const TEXT_DARK: [f32; 3] = [0.09, 0.11, 0.10];
const TEXT_MUTED: [f32; 3] = [0.32, 0.39, 0.37];
const BORDER_GRAY: [f32; 3] = [0.85, 0.88, 0.87];
const ROW_STRIPE: [f32; 3] = [0.97, 0.98, 0.98];

/// Rendering error emitted by `auto-docs`.
#[derive(Debug, Error)]
pub enum RenderError {
    #[error(transparent)]
    Pdf(#[from] PdfBuildError),
    #[error("document contains no renderable content")]
    EmptyDocument,
}

/// Paragraph style for selectable-text Word-to-PDF rendering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DocParagraphStyle {
    #[default]
    Normal,
    Title,
    Heading1,
    Heading2,
    Heading3,
}

/// Normalized paragraph input for [`render_docx_pdf`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocPdfParagraph {
    pub text: String,
    pub style: DocParagraphStyle,
    pub bold: bool,
}

/// Normalized slide input for [`render_pptx_pdf`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlidePdf {
    pub title: Option<String>,
    pub bullets: Vec<(String, u8)>,
    pub notes: Option<String>,
}

/// Renders an A4 commercial PDF (`Quote`, `Invoice`, `Deposit`, or `CreditNote`) localized via `auto-i18n`.
pub fn render(doc: &Document) -> Result<Vec<u8>, RenderError> {
    let lang = doc.resolved_locale();
    let accent = parse_hex_color(doc.template.as_ref().and_then(|t| t.color.as_deref()))
        .unwrap_or_else(|| LIGHT_PALETTE.primary.to_f32());
    let header_tint = tint_color(accent, 0.12);

    let mut canvas = PdfCanvas::new(A4_W, A4_H)?;
    let mut logo_dims: Option<(f32, f32)> = None;
    if let Some(logo) = doc.template.as_ref().and_then(|t| t.logo.as_ref()) {
        let img = decode_logo_image(&logo.mime, &logo.data_base64)?;
        let req_w = doc.template.as_ref().and_then(|t| t.width).unwrap_or(96.0).clamp(24.0, 180.0);
        let req_h = doc
            .template
            .as_ref()
            .and_then(|t| t.height)
            .unwrap_or_else(|| req_w * (img.height as f32 / img.width.max(1) as f32))
            .clamp(16.0, 96.0);
        canvas.add_image("Im0", img);
        logo_dims = Some((req_w, req_h));
    }

    let totals = doc.totals();
    let content_w = A4_W - 2.0 * MARGIN;
    let right_x = A4_W - MARGIN;

    // Top accent bar.
    canvas.fill_rect_top(0.0, 0.0, A4_W, 6.0, accent);

    let mut y = 34.0;
    let type_label = doc.doc_type.label(lang);
    let title_str = format!("{type_label} {}", doc.number);

    // Optional brand logo + document title on the header row.
    if let Some((lw, lh)) = logo_dims {
        canvas.draw_image_top("Im0", MARGIN, y, lw, lh);
        canvas.draw_text_right_top(right_x, y + 18.0, true, 18.0, accent, &title_str);
        canvas.draw_text_right_top(
            right_x,
            y + 34.0,
            false,
            9.5,
            TEXT_MUTED,
            &format!("{}: {}", tr_pdf(lang, "Date"), format_date(&doc.date, lang)),
        );
        y += lh.max(44.0) + 18.0;
    } else {
        canvas.draw_text_top(MARGIN, y + 16.0, true, 20.0, accent, &title_str);
        canvas.draw_text_right_top(
            right_x,
            y + 16.0,
            false,
            9.5,
            TEXT_MUTED,
            &format!("{}: {}", tr_pdf(lang, "Date"), format_date(&doc.date, lang)),
        );
        y += 38.0;
    }

    // Secondary document dates / validity / origin metadata.
    let mut meta_items: Vec<String> = Vec::new();
    if let Some(d) = doc.service_date.as_deref() {
        meta_items.push(format!("{}: {}", tr_pdf(lang, "Service date"), format_date(d, lang)));
    }
    if let Some(d) = doc.due_date.as_deref() {
        meta_items.push(format!("{}: {}", tr_pdf(lang, "Due date"), format_date(d, lang)));
    }
    if let Some(days) = doc.validity_days {
        meta_items.push(format!(
            "{}: {}",
            tr_pdf(lang, "Validity"),
            auto_i18n::tr_plural(lang, "{n} day", "{n} days", u64::from(days), &[])
        ));
    }
    if let Some(orig) = doc.origin.as_deref() {
        meta_items.push(format!("{}: {orig}", tr_pdf(lang, "Origin")));
    }
    if !meta_items.is_empty() {
        canvas.draw_text_top(MARGIN, y, false, 8.8, TEXT_MUTED, &meta_items.join("   |   "));
        y += 18.0;
    }

    // Issuer (left) and Customer (right) boxes.
    let box_gap = 20.0;
    let box_w = (content_w - box_gap) / 2.0;
    let issuer_lines = format_party_lines(&doc.issuer, lang);
    let customer_lines = format_party_lines(&doc.customer, lang);
    let max_party_lines = issuer_lines.len().max(customer_lines.len()) as f32;
    let box_h = 26.0 + max_party_lines * 13.0 + 10.0;

    canvas.fill_rect_top(MARGIN, y, box_w, box_h, ROW_STRIPE);
    canvas.fill_rect_top(MARGIN + box_w + box_gap, y, box_w, box_h, ROW_STRIPE);

    canvas.draw_text_top(MARGIN + 10.0, y + 15.0, true, 8.5, accent, tr_pdf(lang, "Issuer"));
    canvas.draw_text_top(MARGIN + box_w + box_gap + 10.0, y + 15.0, true, 8.5, accent, tr_pdf(lang, "Bill to"));

    draw_party_block(&mut canvas, MARGIN + 10.0, y + 29.0, box_w - 20.0, &issuer_lines);
    draw_party_block(&mut canvas, MARGIN + box_w + box_gap + 10.0, y + 29.0, box_w - 20.0, &customer_lines);
    y += box_h + 22.0;

    // Table columns layout.
    let col_desc_x = MARGIN + 8.0;
    let col_desc_w = 248.0;
    let col_qty_r = MARGIN + 312.0;
    let col_unit_r = MARGIN + 392.0;
    let col_vat_r = MARGIN + 440.0;
    let col_net_r = right_x - 8.0;

    let draw_table_header = |c: &mut PdfCanvas<'_>, top_y: f32| -> f32 {
        c.fill_rect_top(MARGIN, top_y, content_w, 22.0, header_tint);
        let base_y = top_y + 14.5;
        c.draw_text_top(col_desc_x, base_y, true, 8.8, TEXT_DARK, tr_pdf(lang, "Description"));
        c.draw_text_right_top(col_qty_r, base_y, true, 8.8, TEXT_DARK, tr_pdf(lang, "Qty"));
        c.draw_text_right_top(col_unit_r, base_y, true, 8.8, TEXT_DARK, tr_pdf(lang, "Unit price"));
        c.draw_text_right_top(col_vat_r, base_y, true, 8.8, TEXT_DARK, tr_pdf(lang, "VAT"));
        c.draw_text_right_top(col_net_r, base_y, true, 8.8, TEXT_DARK, tr_pdf(lang, "Net amount"));
        top_y + 24.0
    };

    y = draw_table_header(&mut canvas, y);

    for (idx, line) in doc.lines.iter().enumerate() {
        let mut desc_lines = canvas.wrap_text(false, 9.2, col_desc_w, &line.description);
        if let Some(bp) = line.discount_bp.filter(|&v| v > 0) {
            let pct = format_percent_bp(bp, lang);
            desc_lines.push(auto_i18n::tr_args(lang, Some("pdf"), "Discount {rate}", &[("rate", &pct)]));
        }
        let row_h = (desc_lines.len() as f32 * 12.5 + 10.0).max(22.0);
        if y + row_h > PAGE_BODY_BOTTOM {
            canvas.next_page();
            canvas.fill_rect_top(0.0, 0.0, A4_W, 4.0, accent);
            y = draw_table_header(&mut canvas, 36.0);
        }

        if idx % 2 == 1 {
            canvas.fill_rect_top(MARGIN, y, content_w, row_h, ROW_STRIPE);
        }

        let mut text_y = y + 14.0;
        for (li, text) in desc_lines.iter().enumerate() {
            let color = if li == 0 { TEXT_DARK } else { TEXT_MUTED };
            let size = if li == 0 { 9.2 } else { 8.0 };
            canvas.draw_text_top(col_desc_x, text_y, false, size, color, text);
            text_y += 12.5;
        }

        let qty_str = match line.unit.as_deref() {
            Some(u) if !u.trim().is_empty() => format!("{} {u}", trim_qty(line.quantity)),
            _ => trim_qty(line.quantity),
        };
        let unit_str = format_eur(line.unit_price_excl_vat_cents, lang);
        let vat_str = if doc.vat_exempt { format_percent(0, lang) } else { format_percent(line.vat, lang) };
        let net_str = format_eur(line.net_excl_vat_cents(), lang);

        let num_y = y + 14.0;
        canvas.draw_text_right_top(col_qty_r, num_y, false, 9.0, TEXT_DARK, &qty_str);
        canvas.draw_text_right_top(col_unit_r, num_y, false, 9.0, TEXT_DARK, &unit_str);
        canvas.draw_text_right_top(col_vat_r, num_y, false, 9.0, TEXT_DARK, &vat_str);
        canvas.draw_text_right_top(col_net_r, num_y, true, 9.0, TEXT_DARK, &net_str);

        canvas.hline_top(MARGIN, right_x, y + row_h, 0.5, BORDER_GRAY);
        y += row_h;
    }

    y += 14.0;
    let totals_h = 54.0 + (totals.by_rate.len() as f32) * 15.0;
    if y + totals_h > PAGE_BODY_BOTTOM {
        canvas.next_page();
        canvas.fill_rect_top(0.0, 0.0, A4_W, 4.0, accent);
        y = 42.0;
    }

    // Totals summary box aligned on the right half.
    let sum_x = MARGIN + 275.0;
    let sum_w = right_x - sum_x;
    canvas.fill_rect_top(sum_x, y, sum_w, totals_h, ROW_STRIPE);

    let mut sy = y + 17.0;
    canvas.draw_text_top(sum_x + 12.0, sy, false, 9.5, TEXT_DARK, tr_pdf(lang, "Total excl. VAT"));
    canvas.draw_text_right_top(
        right_x - 12.0,
        sy,
        true,
        9.5,
        TEXT_DARK,
        &format_eur(totals.total_excl_vat_cents, lang),
    );
    sy += 16.0;

    for row in &totals.by_rate {
        let rate_str = format_percent(row.rate, lang);
        let label = auto_i18n::tr_args(lang, Some("pdf"), "VAT {rate}", &[("rate", &rate_str)]);
        canvas.draw_text_top(sum_x + 12.0, sy, false, 9.0, TEXT_MUTED, &label);
        canvas.draw_text_right_top(right_x - 12.0, sy, false, 9.0, TEXT_MUTED, &format_eur(row.vat_cents, lang));
        sy += 15.0;
    }

    canvas.hline_top(sum_x + 10.0, right_x - 10.0, sy - 4.0, 0.75, accent);
    sy += 12.0;
    canvas.draw_text_top(sum_x + 12.0, sy, true, 11.0, accent, tr_pdf(lang, "Total incl. VAT"));
    canvas.draw_text_right_top(right_x - 12.0, sy, true, 11.0, accent, &format_eur(totals.total_incl_vat_cents, lang));

    y += totals_h + 18.0;

    // Legal notices and document notes.
    let mut notes_blocks: Vec<String> = Vec::new();
    if doc.vat_exempt {
        let msg = if lang == "fr" {
            auto_i18n::tr_ctx(lang, "pdf", VAT_EXEMPT_NOTICE_FR)
        } else {
            auto_i18n::tr_ctx(lang, "pdf", "VAT not applicable (Art. 293 B CGI)")
        };
        notes_blocks.push(msg.into_owned());
    }
    if let Some(terms) = doc.payment_terms.as_deref() {
        notes_blocks.push(format!("{}: {terms}", tr_pdf(lang, "Payment terms")));
    }
    if let Some(pen) = doc.late_penalties.as_deref() {
        notes_blocks.push(format!("{}: {pen}", tr_pdf(lang, "Late penalties")));
    } else if doc.doc_type != DocumentType::Quote {
        notes_blocks.push(auto_i18n::tr_ctx(lang, "pdf", RECOVERY_FEE_NOTICE_FR).into_owned());
    }
    if let Some(disc) = doc.early_discount.as_deref() {
        notes_blocks.push(format!("{}: {disc}", tr_pdf(lang, "Early discount")));
    }
    if let Some(n) = doc.notes.as_deref() {
        notes_blocks.push(n.to_owned());
    }
    if let Some(foot) = doc.template.as_ref().and_then(|t| t.footer.as_deref()) {
        notes_blocks.push(foot.to_owned());
    }

    for block in notes_blocks {
        let wrapped = canvas.wrap_text(false, 8.5, content_w, &block);
        let needed = wrapped.len() as f32 * 11.5 + 4.0;
        if y + needed > PAGE_BODY_BOTTOM {
            canvas.next_page();
            canvas.fill_rect_top(0.0, 0.0, A4_W, 4.0, accent);
            y = 42.0;
        }
        for line in wrapped {
            canvas.draw_text_top(MARGIN, y, false, 8.5, TEXT_MUTED, &line);
            y += 11.5;
        }
        y += 3.0;
    }

    // Draw final page footer with document number.
    canvas.hline_top(MARGIN, right_x, FOOTER_TOP - 12.0, 0.5, BORDER_GRAY);
    canvas.draw_text_top(
        MARGIN,
        FOOTER_TOP,
        false,
        8.0,
        TEXT_MUTED,
        &format!("{} — {} {}", doc.issuer.name, type_label, doc.number),
    );
    canvas.draw_text_right_top(right_x, FOOTER_TOP, false, 8.0, TEXT_MUTED, &format_date(&doc.date, lang));

    Ok(canvas.finish(Some(&title_str))?)
}

/// Renders styled paragraphs from a DOCX document to an A4 PDF with selectable embedded fonts.
pub fn render_docx_pdf(title: Option<&str>, paragraphs: &[DocPdfParagraph]) -> Result<Vec<u8>, RenderError> {
    let mut canvas = PdfCanvas::new(A4_W, A4_H)?;
    let accent = LIGHT_PALETTE.primary.to_f32();
    let content_w = A4_W - 2.0 * MARGIN;
    let right_x = A4_W - MARGIN;
    let mut y = 52.0;

    canvas.fill_rect_top(0.0, 0.0, A4_W, 4.0, accent);

    if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
        for line in canvas.wrap_text(true, 18.0, content_w, t) {
            canvas.draw_text_top(MARGIN, y, true, 18.0, accent, &line);
            y += 24.0;
        }
        y += 6.0;
    }

    for para in paragraphs {
        let (bold, size, line_h, space_after, color) = match para.style {
            DocParagraphStyle::Title => (true, 18.0, 24.0, 8.0, accent),
            DocParagraphStyle::Heading1 => (true, 14.5, 20.0, 6.0, accent),
            DocParagraphStyle::Heading2 => (true, 12.5, 17.5, 5.0, TEXT_DARK),
            DocParagraphStyle::Heading3 => (true, 11.0, 15.5, 4.0, TEXT_DARK),
            DocParagraphStyle::Normal => (para.bold, 10.2, 14.5, 5.0, TEXT_DARK),
        };
        let wrapped = canvas.wrap_text(bold, size, content_w, &para.text);
        for line in wrapped {
            if y + line_h > PAGE_BODY_BOTTOM {
                canvas.next_page();
                canvas.fill_rect_top(0.0, 0.0, A4_W, 4.0, accent);
                y = 48.0;
            }
            canvas.draw_text_top(MARGIN, y, bold, size, color, &line);
            y += line_h;
        }
        y += space_after;
    }

    canvas.hline_top(MARGIN, right_x, FOOTER_TOP - 10.0, 0.5, BORDER_GRAY);
    Ok(canvas.finish(title)?)
}

/// Renders 16:9 presentation slides to a widescreen PDF (one slide per page, selectable text).
pub fn render_pptx_pdf(title: Option<&str>, slides: &[SlidePdf]) -> Result<Vec<u8>, RenderError> {
    if slides.is_empty() {
        return Err(RenderError::EmptyDocument);
    }
    let mut canvas = PdfCanvas::new(SLIDE_W, SLIDE_H)?;
    let accent = LIGHT_PALETTE.primary.to_f32();
    let pad_x = 56.0;
    let body_w = SLIDE_W - 2.0 * pad_x;

    for (idx, slide) in slides.iter().enumerate() {
        if idx > 0 {
            canvas.next_page();
        }
        canvas.fill_rect_top(0.0, 0.0, SLIDE_W, 8.0, accent);

        let mut y = 68.0;
        if let Some(st) = slide.title.as_deref().filter(|s| !s.trim().is_empty()) {
            let size = if idx == 0 && slide.bullets.is_empty() { 30.0 } else { 24.0 };
            for line in canvas.wrap_text(true, size, body_w, st) {
                canvas.draw_text_top(pad_x, y, true, size, accent, &line);
                y += size * 1.25;
            }
            canvas.hline_top(pad_x, SLIDE_W - pad_x, y - 6.0, 1.0, BORDER_GRAY);
            y += 22.0;
        }

        for (bullet, level) in &slide.bullets {
            let indent = f32::from(*level) * 24.0;
            let x_bullet = pad_x + indent;
            let x_text = x_bullet + 16.0;
            let avail = (body_w - indent - 16.0).max(120.0);
            let lines = canvas.wrap_text(false, 15.0, avail, bullet);
            for (li, line) in lines.iter().enumerate() {
                if y > SLIDE_H - 48.0 {
                    break;
                }
                if li == 0 {
                    canvas.draw_text_top(x_bullet, y, true, 15.0, accent, "•");
                }
                canvas.draw_text_top(x_text, y, false, 15.0, TEXT_DARK, line);
                y += 22.0;
            }
            y += 6.0;
        }

        let slide_num = format!("{} / {}", idx + 1, slides.len());
        canvas.draw_text_right_top(SLIDE_W - pad_x, SLIDE_H - 24.0, false, 10.0, TEXT_MUTED, &slide_num);
    }

    Ok(canvas.finish(title)?)
}

fn tr_pdf<'a>(lang: &str, key: &'a str) -> &'a str {
    match auto_i18n::tr_ctx(lang, "pdf", key) {
        std::borrow::Cow::Borrowed(s) => s,
        std::borrow::Cow::Owned(_) => key,
    }
}

fn format_party_lines(p: &auto_model::Party, lang: &str) -> Vec<String> {
    let mut lines = vec![p.name.clone()];
    for part in p.address.split('\n').map(str::trim).filter(|s| !s.is_empty()) {
        lines.push(part.to_owned());
    }
    if let Some(tax) = p.tax_id.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("{}: {tax}", tr_pdf(lang, "Tax ID")));
    }
    if let Some(vat) = p.vat_number.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("{}: {vat}", tr_pdf(lang, "VAT number")));
    }
    if let Some(deliv) = p.delivery_address.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("{}: {deliv}", tr_pdf(lang, "Ship to")));
    }
    if let Some(email) = p.email.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(email.to_owned());
    }
    lines
}

fn draw_party_block(canvas: &mut PdfCanvas<'_>, x: f32, start_y: f32, max_w: f32, lines: &[String]) {
    let mut y = start_y;
    for (idx, item) in lines.iter().enumerate() {
        let bold = idx == 0;
        let color = if bold { TEXT_DARK } else { TEXT_MUTED };
        for wrapped in canvas.wrap_text(bold, 9.0, max_w, item) {
            canvas.draw_text_top(x, y, bold, 9.0, color, &wrapped);
            y += 12.5;
        }
    }
}

fn parse_hex_color(raw: Option<&str>) -> Option<[f32; 3]> {
    let hex = raw?.trim().strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some([f32::from(r) / 255.0, f32::from(g) / 255.0, f32::from(b) / 255.0])
}

fn tint_color(rgb: [f32; 3], strength: f32) -> [f32; 3] {
    [1.0 - strength * (1.0 - rgb[0]), 1.0 - strength * (1.0 - rgb[1]), 1.0 - strength * (1.0 - rgb[2])]
}

fn trim_qty(q: f64) -> String {
    if (q.fract()).abs() < 1e-6 {
        format!("{}", q as i64)
    } else {
        format!("{q:.2}").trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

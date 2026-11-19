//! Pure-Rust PDF COS writer built on `craft_pdf::cos`, `skrifa`, and `flate2` with CID Type0 Unicode fonts.

use base64::Engine;
use craft_pdf::cos::{Dict, Document, Object, PdfString, SaveOptions, Stream, write_full};
use flate2::read::ZlibDecoder;
use skrifa::charmap::Charmap;
use skrifa::instance::{LocationRef, Size};
use skrifa::metrics::{GlyphMetrics, Metrics};
use skrifa::{FontRef, GlyphId, MetadataProvider};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::io::Read;
use thiserror::Error;

const INTER_REGULAR_TTF: &[u8] = include_bytes!("../fonts/Inter-Regular.ttf");
const INTER_SEMIBOLD_TTF: &[u8] = include_bytes!("../fonts/Inter-SemiBold.ttf");

/// Errors produced when building or encoding PDF documents.
#[derive(Debug, Error)]
pub enum PdfBuildError {
    #[error("failed to read embedded font: {0}")]
    Font(String),
    #[error("invalid logo image: {0}")]
    Logo(String),
    #[error("failed to serialize PDF: {0}")]
    Cos(#[from] craft_pdf::cos::CosError),
}

struct FontState<'a> {
    ps_name: &'static str,
    raw_ttf: &'static [u8],
    charmap: Charmap<'a>,
    metrics: Metrics,
    glyph_metrics: GlyphMetrics<'a>,
    used_glyphs: BTreeMap<u16, (char, i64)>,
}

impl<'a> FontState<'a> {
    fn new(ps_name: &'static str, raw_ttf: &'static [u8]) -> Result<Self, PdfBuildError> {
        let font = FontRef::from_index(raw_ttf, 0).map_err(|e| PdfBuildError::Font(e.to_string()))?;
        let metrics = font.metrics(Size::unscaled(), LocationRef::default());
        let charmap = font.charmap();
        let glyph_metrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
        Ok(Self { ps_name, raw_ttf, charmap, metrics, glyph_metrics, used_glyphs: BTreeMap::new() })
    }

    fn upem(&self) -> f32 {
        f32::from(self.metrics.units_per_em.max(1))
    }

    fn map_char(&self, ch: char) -> (GlyphId, char) {
        let normalized = match ch {
            '\u{00A0}' | '\u{202F}' | '\u{2009}' => ' ',
            other => other,
        };
        if let Some(gid) = self.charmap.map(normalized) {
            return (gid, normalized);
        }
        if let Some(gid) = self.charmap.map('?') {
            return (gid, normalized);
        }
        (GlyphId::NOTDEF, normalized)
    }

    fn use_char(&mut self, ch: char) -> u16 {
        let (gid, unicode_ch) = self.map_char(ch);
        let gid_u16 = gid.to_u32().min(u32::from(u16::MAX)) as u16;
        let upem = self.upem();
        let adv = self.glyph_metrics.advance_width(gid).unwrap_or(upem * 0.5);
        self.used_glyphs.entry(gid_u16).or_insert_with(|| {
            let width_1000 = (adv * 1000.0 / upem).round() as i64;
            (unicode_ch, width_1000)
        });
        gid_u16
    }

    fn char_width(&self, ch: char, font_size: f32) -> f32 {
        let (gid, _) = self.map_char(ch);
        let adv = self.glyph_metrics.advance_width(gid).unwrap_or(self.upem() * 0.5);
        adv * font_size / self.upem()
    }

    fn text_width(&self, text: &str, font_size: f32) -> f32 {
        text.chars().map(|c| self.char_width(c, font_size)).sum()
    }

    fn pdf_scale(&self, v: f32) -> i64 {
        (v * 1000.0 / self.upem()).round() as i64
    }
}

/// Embedded raster XObject data ready to add to a PDF document.
pub struct EmbeddedImage {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub flate: bool,
    pub data: Vec<u8>,
}

/// Decodes a base64 JPEG or PNG logo into an opaque PDF-ready image stream (flattening PNG alpha on white).
pub fn decode_logo_image(mime: &str, data_base64: &str) -> Result<EmbeddedImage, PdfBuildError> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| PdfBuildError::Logo(format!("base64 decode: {e}")))?;

    if mime.eq_ignore_ascii_case("image/jpeg")
        || mime.eq_ignore_ascii_case("image/jpg")
        || raw.starts_with(&[0xFF, 0xD8])
    {
        let (width, height, components) = parse_jpeg_header(&raw)?;
        return Ok(EmbeddedImage { width, height, components, flate: false, data: raw });
    }
    if mime.eq_ignore_ascii_case("image/png") || raw.starts_with(b"\x89PNG\r\n\x1a\n") {
        return decode_png_opaque(&raw);
    }
    Err(PdfBuildError::Logo(format!("unsupported logo mime type: {mime}")))
}

fn parse_jpeg_header(raw: &[u8]) -> Result<(u32, u32, u8), PdfBuildError> {
    if raw.len() < 4 || raw[0] != 0xFF || raw[1] != 0xD8 {
        return Err(PdfBuildError::Logo("invalid JPEG SOI header".into()));
    }
    let mut i = 2usize;
    while i + 3 < raw.len() {
        if raw[i] != 0xFF {
            i += 1;
            continue;
        }
        while i < raw.len() && raw[i] == 0xFF {
            i += 1;
        }
        if i >= raw.len() {
            break;
        }
        let marker = raw[i];
        i += 1;
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue;
        }
        if i + 1 >= raw.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([raw[i], raw[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > raw.len() {
            break;
        }
        if matches!(marker, 0xC0..=0xC3) && seg_len >= 8 {
            let h = u16::from_be_bytes([raw[i + 3], raw[i + 4]]) as u32;
            let w = u16::from_be_bytes([raw[i + 5], raw[i + 6]]) as u32;
            let comps = raw[i + 7];
            if w > 0 && h > 0 && matches!(comps, 1 | 3) {
                return Ok((w, h, comps));
            }
            return Err(PdfBuildError::Logo("unsupported JPEG channel layout".into()));
        }
        i += seg_len;
    }
    Err(PdfBuildError::Logo("missing JPEG SOF frame header".into()))
}

fn decode_png_opaque(raw: &[u8]) -> Result<EmbeddedImage, PdfBuildError> {
    if raw.len() < 33 || !raw.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(PdfBuildError::Logo("invalid PNG signature".into()));
    }
    let mut pos = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut bit_depth = 0u8;
    let mut color_type = 0u8;
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut trns: Vec<u8> = Vec::new();
    let mut idat = Vec::new();

    while pos + 12 <= raw.len() {
        let len = u32::from_be_bytes(raw[pos..pos + 4].try_into().unwrap()) as usize;
        let kind = &raw[pos + 4..pos + 8];
        let data_start = pos + 8;
        let data_end = data_start.saturating_add(len);
        if data_end + 4 > raw.len() {
            return Err(PdfBuildError::Logo("truncated PNG chunk".into()));
        }
        let chunk = &raw[data_start..data_end];
        match kind {
            b"IHDR" if len == 13 => {
                width = u32::from_be_bytes(chunk[0..4].try_into().unwrap());
                height = u32::from_be_bytes(chunk[4..8].try_into().unwrap());
                bit_depth = chunk[8];
                color_type = chunk[9];
                if chunk[12] != 0 {
                    return Err(PdfBuildError::Logo("interlaced PNG logos are not supported".into()));
                }
            }
            b"PLTE" => {
                palette = chunk.as_chunks::<3>().0.to_vec();
            }
            b"tRNS" => {
                trns = chunk.to_vec();
            }
            b"IDAT" => idat.extend_from_slice(chunk),
            b"IEND" => break,
            _ => {}
        }
        pos = data_end + 4;
    }

    if width == 0 || height == 0 || bit_depth != 8 {
        return Err(PdfBuildError::Logo("only 8-bit non-empty PNG logos are supported".into()));
    }
    let bpp: usize = match color_type {
        0 | 3 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        other => return Err(PdfBuildError::Logo(format!("unsupported PNG color type {other}"))),
    };

    let mut inflated = Vec::new();
    ZlibDecoder::new(idat.as_slice())
        .read_to_end(&mut inflated)
        .map_err(|e| PdfBuildError::Logo(format!("PNG zlib error: {e}")))?;

    let row_bytes = (width as usize) * bpp;
    let stride = row_bytes + 1;
    if inflated.len() < stride * (height as usize) {
        return Err(PdfBuildError::Logo("incomplete PNG scanlines".into()));
    }

    let mut prev = vec![0u8; row_bytes];
    let mut curr = vec![0u8; row_bytes];
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);

    for y in 0..height as usize {
        let row = &inflated[y * stride..(y + 1) * stride];
        let filter = row[0];
        let src = &row[1..];
        for i in 0..row_bytes {
            let left = if i >= bpp { curr[i - bpp] } else { 0 };
            let up = prev[i];
            let up_left = if i >= bpp { prev[i - bpp] } else { 0 };
            let recon = match filter {
                0 => src[i],
                1 => src[i].wrapping_add(left),
                2 => src[i].wrapping_add(up),
                3 => src[i].wrapping_add(((u16::from(left) + u16::from(up)) / 2) as u8),
                4 => src[i].wrapping_add(paeth(left, up, up_left)),
                _ => return Err(PdfBuildError::Logo(format!("invalid PNG filter {filter}"))),
            };
            curr[i] = recon;
        }
        for px in 0..width as usize {
            let off = px * bpp;
            let (r, g, b, a) = match color_type {
                0 => (curr[off], curr[off], curr[off], 255),
                2 => (curr[off], curr[off + 1], curr[off + 2], 255),
                3 => {
                    let idx = curr[off] as usize;
                    let [r, g, b] = *palette.get(idx).unwrap_or(&[0, 0, 0]);
                    let a = *trns.get(idx).unwrap_or(&255);
                    (r, g, b, a)
                }
                4 => (curr[off], curr[off], curr[off], curr[off + 1]),
                6 => (curr[off], curr[off + 1], curr[off + 2], curr[off + 3]),
                _ => unreachable!(),
            };
            let alpha = u16::from(a);
            let inv = 255 - alpha;
            rgb.push(((u16::from(r) * alpha + 255 * inv) / 255) as u8);
            rgb.push(((u16::from(g) * alpha + 255 * inv) / 255) as u8);
            rgb.push(((u16::from(b) * alpha + 255 * inv) / 255) as u8);
        }
        prev.copy_from_slice(&curr);
    }

    Ok(EmbeddedImage { width, height, components: 3, flate: true, data: rgb })
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let a = i32::from(a);
    let b = i32::from(b);
    let c = i32::from(c);
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

/// Multi-page PDF canvas recording graphics and Unicode text operations before writing COS objects.
pub struct PdfCanvas<'a> {
    page_w: f32,
    page_h: f32,
    regular: FontState<'a>,
    bold: FontState<'a>,
    regular_used: bool,
    bold_used: bool,
    pages: Vec<Vec<u8>>,
    current: String,
    images: HashMap<String, EmbeddedImage>,
}

impl<'a> PdfCanvas<'a> {
    /// Creates a blank canvas whose pages use `(page_w, page_h)` points (e.g. A4 `595.28 x 841.89`).
    pub fn new(page_w: f32, page_h: f32) -> Result<Self, PdfBuildError> {
        Ok(Self {
            page_w,
            page_h,
            regular: FontState::new("Inter-Regular", INTER_REGULAR_TTF)?,
            bold: FontState::new("Inter-SemiBold", INTER_SEMIBOLD_TTF)?,
            regular_used: false,
            bold_used: false,
            pages: Vec::new(),
            current: String::new(),
            images: HashMap::new(),
        })
    }

    /// Registers a named image XObject once across the document.
    pub fn add_image(&mut self, name: &str, image: EmbeddedImage) {
        self.images.insert(name.to_owned(), image);
    }

    /// Starts a new page, flushing the current content stream if non-empty.
    pub fn next_page(&mut self) {
        if !self.current.is_empty() {
            let finished = std::mem::take(&mut self.current);
            self.pages.push(finished.into_bytes());
        }
    }

    /// Ensures the first page exists before drawing, or closes the final page cleanly.
    pub fn finish_pages(&mut self) {
        if !self.current.is_empty() || self.pages.is_empty() {
            let finished = std::mem::take(&mut self.current);
            self.pages.push(finished.into_bytes());
        }
    }

    /// Returns measured width in points for `text` using Regular or SemiBold Inter.
    pub fn text_width(&self, bold: bool, font_size: f32, text: &str) -> f32 {
        if bold { self.bold.text_width(text, font_size) } else { self.regular.text_width(text, font_size) }
    }

    /// Word-wraps `text` into lines fitting within `max_width` points, honoring explicit newlines.
    pub fn wrap_text(&self, bold: bool, font_size: f32, max_width: f32, text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for raw_line in text.split('\n') {
            let trimmed = raw_line.trim_end_matches('\r');
            if trimmed.is_empty() {
                out.push(String::new());
                continue;
            }
            let mut line = String::new();
            for word in trimmed.split_whitespace() {
                let candidate = if line.is_empty() { word.to_owned() } else { format!("{line} {word}") };
                if self.text_width(bold, font_size, &candidate) <= max_width {
                    line = candidate;
                    continue;
                }
                if !line.is_empty() {
                    out.push(std::mem::take(&mut line));
                }
                if self.text_width(bold, font_size, word) <= max_width {
                    line = word.to_owned();
                } else {
                    for ch in word.chars() {
                        let next = format!("{line}{ch}");
                        if !line.is_empty() && self.text_width(bold, font_size, &next) > max_width {
                            out.push(std::mem::take(&mut line));
                        }
                        line.push(ch);
                    }
                }
            }
            if !line.is_empty() {
                out.push(line);
            }
        }
        if out.is_empty() {
            out.push(String::new());
        }
        out
    }

    /// Draws a filled axis-aligned rectangle using top-down `y` coordinates (`y = 0` at top of page).
    pub fn fill_rect_top(&mut self, x: f32, y_top: f32, w: f32, h: f32, rgb: [f32; 3]) {
        let y_bot = self.page_h - y_top - h;
        let _ = writeln!(
            self.current,
            "q {:.4} {:.4} {:.4} rg {:.2} {:.2} {:.2} {:.2} re f Q",
            rgb[0], rgb[1], rgb[2], x, y_bot, w, h
        );
    }

    /// Draws a stroked horizontal line at top-down `y_top`.
    pub fn hline_top(&mut self, x1: f32, x2: f32, y_top: f32, width: f32, rgb: [f32; 3]) {
        let y = self.page_h - y_top;
        let _ = writeln!(
            self.current,
            "q {:.2} w {:.4} {:.4} {:.4} RG {:.2} {:.2} m {:.2} {:.2} l S Q",
            width, rgb[0], rgb[1], rgb[2], x1, y, x2, y
        );
    }

    /// Draws an image XObject placed with top-left at `(x, y_top)`.
    pub fn draw_image_top(&mut self, name: &str, x: f32, y_top: f32, w: f32, h: f32) {
        let y_bot = self.page_h - y_top - h;
        let _ = writeln!(self.current, "q {w:.2} 0 0 {h:.2} {x:.2} {y_bot:.2} cm /{name} Do Q");
    }

    /// Draws left-aligned text at baseline `y_top_baseline` measured downward from page top.
    pub fn draw_text_top(
        &mut self,
        x: f32,
        y_top_baseline: f32,
        bold: bool,
        font_size: f32,
        rgb: [f32; 3],
        text: &str,
    ) {
        if text.is_empty() {
            return;
        }
        let hex = self.encode_string(bold, text);
        let font_tag = if bold { "F2" } else { "F1" };
        let y = self.page_h - y_top_baseline;
        let _ = writeln!(
            self.current,
            "BT /{font_tag} {font_size:.2} Tf {:.4} {:.4} {:.4} rg 1 0 0 1 {x:.2} {y:.2} Tm {hex} Tj ET",
            rgb[0], rgb[1], rgb[2]
        );
    }

    /// Draws right-aligned text whose right edge lands at `x_right`.
    pub fn draw_text_right_top(
        &mut self,
        x_right: f32,
        y_top_baseline: f32,
        bold: bool,
        font_size: f32,
        rgb: [f32; 3],
        text: &str,
    ) {
        let w = self.text_width(bold, font_size, text);
        self.draw_text_top(x_right - w, y_top_baseline, bold, font_size, rgb, text);
    }

    fn encode_string(&mut self, bold: bool, text: &str) -> String {
        let font = if bold {
            self.bold_used = true;
            &mut self.bold
        } else {
            self.regular_used = true;
            &mut self.regular
        };
        let mut out = String::with_capacity(text.len() * 4 + 2);
        out.push('<');
        for ch in text.chars() {
            let gid = font.use_char(ch);
            let _ = write!(out, "{gid:04X}");
        }
        out.push('>');
        out
    }

    /// Returns the number of finalized/active pages currently on the canvas.
    pub fn page_count(&self) -> usize {
        self.pages.len() + usize::from(!self.current.is_empty())
    }

    /// Serializes all recorded pages, fonts, CMaps, and images into a PDF byte vector.
    pub fn finish(mut self, title: Option<&str>) -> Result<Vec<u8>, PdfBuildError> {
        self.finish_pages();

        let mut doc = Document::new_empty();
        doc.set_version("1.7");
        let root_ref = doc.root().ok_or(craft_pdf::cos::CosError::MissingObject(0))?;
        let root_obj = doc.get(root_ref);
        let pages_ref =
            root_obj.as_dict().and_then(|d| d.reference(b"Pages")).ok_or(craft_pdf::cos::CosError::MissingObject(1))?;

        let mut font_dict = Dict::new();
        if self.regular_used {
            let fref = add_cid_font(&mut doc, &self.regular);
            font_dict.set("F1", fref);
        }
        if self.bold_used {
            let fref = add_cid_font(&mut doc, &self.bold);
            font_dict.set("F2", fref);
        }

        let mut xobj_dict = Dict::new();
        for (name, img) in &self.images {
            let mut idict = Dict::new();
            idict.set("Type", Object::name("XObject"));
            idict.set("Subtype", Object::name("Image"));
            idict.set("Width", Object::Int(i64::from(img.width)));
            idict.set("Height", Object::Int(i64::from(img.height)));
            idict.set("BitsPerComponent", Object::Int(8));
            idict.set("ColorSpace", Object::name(if img.components == 1 { "DeviceGray" } else { "DeviceRGB" }));
            let stream = if img.flate {
                Stream::flate(idict, &img.data)
            } else {
                idict.set("Filter", Object::name("DCTDecode"));
                Stream::from_raw(idict, img.data.clone())
            };
            let iref = doc.add(stream);
            xobj_dict.set(name.as_str(), iref);
        }

        let mut resources = Dict::new();
        resources.set("Font", font_dict);
        if !xobj_dict.is_empty() {
            resources.set("XObject", xobj_dict);
        }
        resources.set(
            "ProcSet",
            vec![
                Object::name("PDF"),
                Object::name("Text"),
                Object::name("ImageB"),
                Object::name("ImageC"),
                Object::name("ImageI"),
            ],
        );
        let res_ref = doc.add(resources);

        let mut kids = Vec::with_capacity(self.pages.len());
        for content_bytes in &self.pages {
            let content_ref = doc.add(Stream::flate(Dict::new(), content_bytes));
            let mut page = Dict::new();
            page.set("Type", Object::name("Page"));
            page.set("Parent", pages_ref);
            page.set(
                "MediaBox",
                vec![
                    Object::Int(0),
                    Object::Int(0),
                    Object::Real(f64::from(self.page_w)),
                    Object::Real(f64::from(self.page_h)),
                ],
            );
            page.set("Resources", res_ref);
            page.set("Contents", content_ref);
            kids.push(Object::Ref(doc.add(page)));
        }

        let count = kids.len() as i64;
        doc.update_dict(pages_ref, |d| {
            d.set("Kids", kids);
            d.set("Count", Object::Int(count));
        })?;

        let mut info = Dict::new();
        info.set("Producer", Object::String(PdfString::text("auto-docs (craft-pdf/cos)")));
        if let Some(t) = title {
            info.set("Title", Object::String(PdfString::text(t)));
        }
        let info_ref = doc.add(info);
        doc.trailer_mut().set("Info", info_ref);

        let opts =
            SaveOptions { object_streams: false, id_entropy: Some(*b"auto-docs-pdf-v1"), ..SaveOptions::default() };
        Ok(write_full(&doc, &opts)?)
    }
}

fn add_cid_font(doc: &mut Document, font: &FontState<'_>) -> craft_pdf::cos::ObjRef {
    let mut ff_dict = Dict::new();
    ff_dict.set("Length1", Object::Int(font.raw_ttf.len() as i64));
    let ff_ref = doc.add(Stream::flate(ff_dict, font.raw_ttf));

    let bounds = font.metrics.bounds;
    let bbox = if let Some(b) = bounds {
        vec![
            Object::Int(font.pdf_scale(b.x_min)),
            Object::Int(font.pdf_scale(b.y_min)),
            Object::Int(font.pdf_scale(b.x_max)),
            Object::Int(font.pdf_scale(b.y_max)),
        ]
    } else {
        vec![Object::Int(-500), Object::Int(-250), Object::Int(1200), Object::Int(1000)]
    };

    let mut fd = Dict::new();
    fd.set("Type", Object::name("FontDescriptor"));
    fd.set("FontName", Object::name(font.ps_name));
    fd.set("Flags", Object::Int(4));
    fd.set("FontBBox", bbox);
    fd.set("ItalicAngle", Object::Int(0));
    fd.set("Ascent", Object::Int(font.pdf_scale(font.metrics.ascent.abs())));
    fd.set("Descent", Object::Int(-font.pdf_scale(font.metrics.descent.abs())));
    fd.set("CapHeight", Object::Int(font.pdf_scale(font.metrics.cap_height.unwrap_or(font.metrics.ascent * 0.72))));
    fd.set("StemV", Object::Int(80));
    fd.set("FontFile2", ff_ref);
    let fd_ref = doc.add(fd);

    let mut sys_info = Dict::new();
    sys_info.set("Registry", Object::String(PdfString::literal(b"Adobe".to_vec())));
    sys_info.set("Ordering", Object::String(PdfString::literal(b"Identity".to_vec())));
    sys_info.set("Supplement", Object::Int(0));

    let mut w_arr = Vec::with_capacity(font.used_glyphs.len() * 2);
    for (&gid, &(_, w)) in &font.used_glyphs {
        w_arr.push(Object::Int(i64::from(gid)));
        w_arr.push(Object::Array(vec![Object::Int(w)]));
    }

    let mut cid = Dict::new();
    cid.set("Type", Object::name("Font"));
    cid.set("Subtype", Object::name("CIDFontType2"));
    cid.set("BaseFont", Object::name(font.ps_name));
    cid.set("CIDSystemInfo", sys_info);
    cid.set("FontDescriptor", fd_ref);
    cid.set("DW", Object::Int(1000));
    cid.set("W", w_arr);
    cid.set("CIDToGIDMap", Object::name("Identity"));
    let cid_ref = doc.add(cid);

    let cmap = build_tounicode_cmap(&font.used_glyphs);
    let cmap_ref = doc.add(Stream::flate(Dict::new(), &cmap));

    let mut type0 = Dict::new();
    type0.set("Type", Object::name("Font"));
    type0.set("Subtype", Object::name("Type0"));
    type0.set("BaseFont", Object::name(font.ps_name));
    type0.set("Encoding", Object::name("Identity-H"));
    type0.set("DescendantFonts", vec![Object::Ref(cid_ref)]);
    type0.set("ToUnicode", cmap_ref);
    doc.add(type0)
}

fn build_tounicode_cmap(used: &BTreeMap<u16, (char, i64)>) -> Vec<u8> {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n\
         12 dict begin\n\
         begincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n\
         /CMapType 2 def\n\
         1 begincodespacerange\n\
         <0000> <FFFF>\n\
         endcodespacerange\n",
    );
    let pairs: Vec<(u16, char)> = used.iter().map(|(&gid, &(ch, _))| (gid, ch)).collect();
    for chunk in pairs.chunks(100) {
        let _ = writeln!(out, "{} beginbfchar", chunk.len());
        for &(gid, ch) in chunk {
            let mut buf = [0u16; 2];
            let units = ch.encode_utf16(&mut buf);
            let _ = write!(out, "<{gid:04X}> <");
            for u in units {
                let _ = write!(out, "{u:04X}");
            }
            out.push_str(">\n");
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out.into_bytes()
}

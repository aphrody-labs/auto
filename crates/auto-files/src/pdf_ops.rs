use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use craft_pdf::cos::{Dict, Document, MAX_PAGE_DECODED, ObjRef, Object, SaveOptions, pdfdoc_char, write_full};

use crate::FileError;

#[derive(Clone)]
pub(crate) struct PageNode {
    pub page_ref: ObjRef,
    pub media_box: Option<Object>,
    pub crop_box: Option<Object>,
    pub resources: Option<Object>,
    pub rotate: Option<Object>,
}

pub(crate) struct PageContentPart {
    pub stream_ref: Option<ObjRef>,
    pub bytes: Vec<u8>,
}

pub(crate) fn collect_pages(doc: &Document) -> Result<Vec<PageNode>, FileError> {
    let root_ref = doc.root().ok_or_else(|| FileError::InvalidPdf("missing /Root catalog".into()))?;
    let root_obj = doc.get(root_ref);
    let root = doc.dict(&root_obj).ok_or_else(|| FileError::InvalidPdf("/Root is not a dictionary".into()))?;
    let pages_ref = root.reference(b"Pages").ok_or_else(|| FileError::InvalidPdf("missing /Pages tree".into()))?;

    let mut out = Vec::new();
    let mut visited = HashSet::new();
    walk_pages_node(doc, pages_ref, None, None, None, None, &mut visited, &mut out)?;
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn walk_pages_node(
    doc: &Document,
    node_ref: ObjRef,
    inh_media: Option<Object>,
    inh_crop: Option<Object>,
    inh_res: Option<Object>,
    inh_rot: Option<Object>,
    visited: &mut HashSet<ObjRef>,
    out: &mut Vec<PageNode>,
) -> Result<(), FileError> {
    if !visited.insert(node_ref) {
        return Ok(());
    }
    let obj = doc.get(node_ref);
    let Some(dict) = doc.dict(&obj) else {
        return Ok(());
    };

    let media_box = dict.get(b"MediaBox").cloned().or(inh_media);
    let crop_box = dict.get(b"CropBox").cloned().or(inh_crop);
    let resources = dict.get(b"Resources").cloned().or(inh_res);
    let rotate = dict.get(b"Rotate").cloned().or(inh_rot);

    let is_pages = dict.name(b"Type") == Some(b"Pages") || dict.contains(b"Kids");
    if is_pages {
        if let Some(kids_obj) = dict.get(b"Kids") {
            let resolved = doc.resolve(kids_obj);
            if let Some(kids) = resolved.as_array() {
                for kid in kids {
                    if let Some(kid_ref) = kid.as_ref() {
                        walk_pages_node(
                            doc,
                            kid_ref,
                            media_box.clone(),
                            crop_box.clone(),
                            resources.clone(),
                            rotate.clone(),
                            visited,
                            out,
                        )?;
                    }
                }
            }
        }
    } else {
        out.push(PageNode { page_ref: node_ref, media_box, crop_box, resources, rotate });
    }
    Ok(())
}

pub fn pdf_page_count(pdf: &[u8]) -> Result<usize, FileError> {
    let doc = Document::open(Arc::new(pdf.to_vec()))?;
    Ok(collect_pages(&doc)?.len())
}

pub fn merge_pdfs(pdfs: &[(&str, &[u8])]) -> Result<Vec<u8>, FileError> {
    if pdfs.is_empty() {
        return Err(FileError::InvalidInput("no PDF documents supplied".into()));
    }
    let mut dst = Document::new_empty();
    let root_pages_ref = dst.add(Dict::new());
    let mut all_kids: Vec<Object> = Vec::new();

    for (idx, (name, bytes)) in pdfs.iter().enumerate() {
        let src = Document::open(Arc::new(bytes.to_vec()))
            .map_err(|e| FileError::InvalidPdf(format!("document '{name}' (#{}): {e}", idx + 1)))?;
        let pages = collect_pages(&src)?;
        let mut remap: HashMap<ObjRef, ObjRef> = HashMap::new();
        for node in pages {
            let cloned_ref = clone_page_into(&src, &mut dst, &mut remap, &node, root_pages_ref);
            all_kids.push(Object::Ref(cloned_ref));
        }
    }

    finalize_merged_catalog(&mut dst, root_pages_ref, all_kids)
}

pub fn extract_pdf_pages(pdf: &[u8], zero_based_pages: &[usize]) -> Result<Vec<u8>, FileError> {
    let src = Document::open(Arc::new(pdf.to_vec()))?;
    let pages = collect_pages(&src)?;
    if zero_based_pages.is_empty() {
        return Err(FileError::InvalidInput("page selection must not be empty".into()));
    }
    let total = pages.len();
    for &idx in zero_based_pages {
        if idx >= total {
            return Err(FileError::PageOutOfRange { page: idx + 1, total });
        }
    }

    let mut dst = Document::new_empty();
    let root_pages_ref = dst.add(Dict::new());
    let mut shared_remap: HashMap<ObjRef, ObjRef> = HashMap::new();
    let mut seen_pages: HashSet<usize> = HashSet::new();
    let mut kids: Vec<Object> = Vec::with_capacity(zero_based_pages.len());

    for &idx in zero_based_pages {
        let node = &pages[idx];
        // Duplicate the page dictionary if the same page index was requested twice.
        let mut remap = if seen_pages.insert(idx) {
            std::mem::take(&mut shared_remap)
        } else {
            let mut duplicate_map = shared_remap.clone();
            duplicate_map.remove(&node.page_ref);
            duplicate_map
        };
        let cloned_ref = clone_page_into(&src, &mut dst, &mut remap, node, root_pages_ref);
        shared_remap = remap;
        kids.push(Object::Ref(cloned_ref));
    }

    finalize_merged_catalog(&mut dst, root_pages_ref, kids)
}

fn finalize_merged_catalog(
    dst: &mut Document,
    root_pages_ref: ObjRef,
    kids: Vec<Object>,
) -> Result<Vec<u8>, FileError> {
    let mut pages_dict = Dict::new();
    pages_dict.set(b"Type".to_vec(), Object::name("Pages"));
    pages_dict.set(b"Count".to_vec(), Object::Int(kids.len() as i64));
    pages_dict.set(b"Kids".to_vec(), Object::Array(kids));
    dst.set(root_pages_ref, pages_dict);

    let mut catalog = Dict::new();
    catalog.set(b"Type".to_vec(), Object::name("Catalog"));
    catalog.set(b"Pages".to_vec(), Object::Ref(root_pages_ref));
    let root_ref = dst.add(catalog);
    dst.trailer_mut().set(b"Root".to_vec(), Object::Ref(root_ref));

    let opts = SaveOptions { object_streams: false, ..Default::default() };
    Ok(write_full(dst, &opts)?)
}

fn clone_page_into(
    src: &Document,
    dst: &mut Document,
    remap: &mut HashMap<ObjRef, ObjRef>,
    node: &PageNode,
    new_parent: ObjRef,
) -> ObjRef {
    if let Some(&existing) = remap.get(&node.page_ref) {
        return existing;
    }
    let dst_ref = dst.add(Object::Null);
    remap.insert(node.page_ref, dst_ref);

    let page_obj = src.get(node.page_ref);
    let mut page_dict = src.dict(&page_obj).unwrap_or_default();
    page_dict.remove(b"Parent");
    page_dict.remove(b"B");

    if !page_dict.contains(b"MediaBox")
        && let Some(mb) = &node.media_box
    {
        page_dict.set(b"MediaBox".to_vec(), mb.clone());
    }
    if !page_dict.contains(b"CropBox")
        && let Some(cb) = &node.crop_box
    {
        page_dict.set(b"CropBox".to_vec(), cb.clone());
    }
    if !page_dict.contains(b"Resources")
        && let Some(res) = &node.resources
    {
        page_dict.set(b"Resources".to_vec(), res.clone());
    }
    if !page_dict.contains(b"Rotate")
        && let Some(rot) = &node.rotate
    {
        page_dict.set(b"Rotate".to_vec(), rot.clone());
    }

    let mut cloned_dict = clone_dict(src, dst, remap, &page_dict);
    cloned_dict.set(b"Parent".to_vec(), Object::Ref(new_parent));
    dst.set(dst_ref, cloned_dict);
    dst_ref
}

fn clone_dict(src: &Document, dst: &mut Document, remap: &mut HashMap<ObjRef, ObjRef>, dict: &Dict) -> Dict {
    let mut out = Dict::new();
    for (k, v) in dict.iter() {
        out.set(k.clone(), clone_object(src, dst, remap, v));
    }
    out
}

fn clone_object(src: &Document, dst: &mut Document, remap: &mut HashMap<ObjRef, ObjRef>, obj: &Object) -> Object {
    match obj {
        Object::Null | Object::Bool(_) | Object::Int(_) | Object::Real(_) | Object::String(_) | Object::Name(_) => {
            obj.clone()
        }
        Object::Array(items) => Object::Array(items.iter().map(|item| clone_object(src, dst, remap, item)).collect()),
        Object::Dict(dict) => Object::Dict(clone_dict(src, dst, remap, dict)),
        Object::Stream(stream) => {
            let mut s = stream.clone();
            s.dict = clone_dict(src, dst, remap, &stream.dict);
            Object::Stream(s)
        }
        Object::Ref(r) => {
            if let Some(&mapped) = remap.get(r) {
                return Object::Ref(mapped);
            }
            let target = dst.add(Object::Null);
            remap.insert(*r, target);
            let orig = src.get(*r);
            let cloned = clone_object(src, dst, remap, &orig);
            dst.set(target, cloned);
            Object::Ref(target)
        }
    }
}

pub(crate) fn page_content_parts(doc: &Document, page_ref: ObjRef) -> Result<Vec<PageContentPart>, FileError> {
    let page_obj = doc.get(page_ref);
    let Some(page_dict) = doc.dict(&page_obj) else {
        return Ok(Vec::new());
    };
    let Some(contents) = page_dict.get(b"Contents") else {
        return Ok(Vec::new());
    };

    let mut parts = Vec::new();
    match contents {
        Object::Ref(r) => {
            let resolved = doc.get(*r);
            match resolved.as_ref() {
                Object::Stream(s) => parts.push(PageContentPart {
                    stream_ref: Some(*r),
                    bytes: doc.with_direct_parms(s).decoded_strict_within(MAX_PAGE_DECODED)?,
                }),
                Object::Array(arr) => collect_content_array(doc, arr, &mut parts)?,
                _ => {}
            }
        }
        Object::Array(arr) => collect_content_array(doc, arr, &mut parts)?,
        Object::Stream(s) => parts.push(PageContentPart {
            stream_ref: None,
            bytes: doc.with_direct_parms(s).decoded_strict_within(MAX_PAGE_DECODED)?,
        }),
        _ => {}
    }
    Ok(parts)
}

fn collect_content_array(doc: &Document, arr: &[Object], out: &mut Vec<PageContentPart>) -> Result<(), FileError> {
    for item in arr {
        if let Some(r) = item.as_ref()
            && let Object::Stream(s) = doc.get(r).as_ref()
        {
            out.push(PageContentPart {
                stream_ref: Some(r),
                bytes: doc.with_direct_parms(s).decoded_strict_within(MAX_PAGE_DECODED)?,
            });
        }
    }
    Ok(())
}

#[derive(Clone, Default)]
pub(crate) struct FontDecoder {
    pub two_byte: bool,
    pub to_unicode: HashMap<u32, String>,
    pub reverse: HashMap<char, Vec<u8>>,
}

impl FontDecoder {
    pub fn decode_bytes(&self, raw: &[u8]) -> (String, Vec<GlyphSlice>) {
        let mut text = String::new();
        let mut slices = Vec::new();
        let step = if self.two_byte { 2 } else { 1 };
        let mut pos = 0usize;
        while pos < raw.len() {
            let end = (pos + step).min(raw.len());
            let chunk = &raw[pos..end];
            let code = if chunk.len() == 2 {
                u32::from(u16::from_be_bytes([chunk[0], chunk[1]]))
            } else {
                u32::from(chunk[0])
            };
            let decoded = if let Some(s) = self.to_unicode.get(&code) {
                s.clone()
            } else if !self.two_byte && chunk.len() == 1 {
                pdfdoc_char(chunk[0]).to_string()
            } else if let Some(ch) = char::from_u32(code) {
                ch.to_string()
            } else {
                String::new()
            };
            let char_start = text.len();
            text.push_str(&decoded);
            let char_end = text.len();
            slices.push(GlyphSlice { text_start: char_start, text_end: char_end, raw_bytes: chunk.to_vec() });
            pos = end;
        }
        (text, slices)
    }

    pub fn encode_char(&self, ch: char) -> Option<&[u8]> {
        self.reverse.get(&ch).map(Vec::as_slice)
    }
}

#[derive(Clone)]
pub(crate) struct GlyphSlice {
    pub text_start: usize,
    pub text_end: usize,
    pub raw_bytes: Vec<u8>,
}

pub(crate) type FontMap = HashMap<Vec<u8>, FontDecoder>;

pub(crate) fn page_fonts(doc: &Document, node: &PageNode) -> FontMap {
    let mut map = HashMap::new();
    let Some(res_obj) = &node.resources else {
        return map;
    };
    let Some(res_dict) = doc.dict(res_obj) else {
        return map;
    };
    let Some(fonts_obj) = res_dict.get(b"Font") else {
        return map;
    };
    let Some(fonts_dict) = doc.dict(fonts_obj) else {
        return map;
    };
    for (fname, fobj) in fonts_dict.iter() {
        let Some(fdict) = doc.dict(fobj) else {
            continue;
        };
        let two_byte = fdict.name(b"Encoding").is_some_and(|e| e == b"Identity-H" || e == b"Identity-V")
            || fdict.name(b"Subtype") == Some(b"Type0");
        let mut decoder = FontDecoder { two_byte, ..Default::default() };

        if let Some(cmap_obj) = fdict.get(b"ToUnicode") {
            let resolved = doc.resolve(cmap_obj);
            if let Object::Stream(stream) = resolved.as_ref()
                && let Ok(bytes) = doc.with_direct_parms(stream).decoded_strict_within(MAX_PAGE_DECODED)
            {
                parse_tounicode_cmap(&bytes, &mut decoder);
            }
        }
        if !decoder.two_byte && decoder.reverse.is_empty() {
            for b in 32u8..=126 {
                decoder.reverse.insert(b as char, vec![b]);
            }
        }
        map.insert(fname.clone(), decoder);
    }
    map
}

fn parse_tounicode_cmap(data: &[u8], out: &mut FontDecoder) {
    let text = String::from_utf8_lossy(data);
    let tokens = cmap_tokens(&text);
    let mut i = 0usize;
    while i < tokens.len() {
        match tokens[i].as_str() {
            "begincodespacerange" => {
                i += 1;
                while i + 1 < tokens.len() && tokens[i] != "endcodespacerange" {
                    if let Some((digits, _)) = parse_hex_token(&tokens[i])
                        && digits >= 4
                    {
                        out.two_byte = true;
                    }
                    i += 2;
                }
            }
            "beginbfchar" => {
                i += 1;
                while i + 1 < tokens.len() && tokens[i] != "endbfchar" {
                    if let (Some((src_digits, src)), Some((_, dst_bytes))) =
                        (parse_hex_token(&tokens[i]), parse_hex_bytes(&tokens[i + 1]))
                    {
                        if src_digits >= 4 {
                            out.two_byte = true;
                        }
                        let s = decode_utf16_bytes(&dst_bytes);
                        register_cmap_entry(out, src, s);
                    }
                    i += 2;
                }
            }
            "beginbfrange" => {
                i += 1;
                while i + 2 < tokens.len() && tokens[i] != "endbfrange" {
                    if let (Some((lo_digits, lo)), Some((_, hi))) =
                        (parse_hex_token(&tokens[i]), parse_hex_token(&tokens[i + 1]))
                    {
                        if lo_digits >= 4 {
                            out.two_byte = true;
                        }
                        if tokens[i + 2] == "[" {
                            i += 3;
                            let mut cur = lo;
                            while i < tokens.len() && tokens[i] != "]" {
                                if cur <= hi
                                    && let Some((_, dst_bytes)) = parse_hex_bytes(&tokens[i])
                                {
                                    register_cmap_entry(out, cur, decode_utf16_bytes(&dst_bytes));
                                }
                                cur = cur.saturating_add(1);
                                i += 1;
                            }
                            i += 1;
                            continue;
                        } else if let Some((_, dst_bytes)) = parse_hex_bytes(&tokens[i + 2]) {
                            let mut base =
                                u16::from_be_bytes([*dst_bytes.first().unwrap_or(&0), *dst_bytes.get(1).unwrap_or(&0)]);
                            let count = hi.saturating_sub(lo).min(4096);
                            for offset in 0..=count {
                                let code = lo + offset;
                                let s = String::from_utf16_lossy(&[base.wrapping_add(offset as u16)]);
                                register_cmap_entry(out, code, s);
                            }
                            let _ = &mut base;
                        }
                    }
                    i += 3;
                }
            }
            _ => i += 1,
        }
    }
}

fn register_cmap_entry(out: &mut FontDecoder, code: u32, s: String) {
    let mut chars = s.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        let raw = if out.two_byte { (code as u16).to_be_bytes().to_vec() } else { vec![code as u8] };
        out.reverse.entry(ch).or_insert(raw);
    }
    out.to_unicode.insert(code, s);
}

fn cmap_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if b == b'%' {
            while i < bytes.len() && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
        } else if bytes.get(i..i + 2) == Some(b"<<") || bytes.get(i..i + 2) == Some(b">>") {
            i += 2;
        } else if b == b'<' {
            let start = i;
            i += 1;
            while i < bytes.len() && bytes[i] != b'>' {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            out.push(s[start..i].to_owned());
        } else if b == b'>' {
            i += 1;
        } else if b == b'[' || b == b']' {
            out.push((b as char).to_string());
            i += 1;
        } else {
            let start = i;
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && !matches!(bytes[i], b'<' | b'>' | b'[' | b']' | b'%')
            {
                i += 1;
            }
            if i == start {
                i += 1;
            } else {
                out.push(s[start..i].to_owned());
            }
        }
    }
    out
}

fn parse_hex_token(tok: &str) -> Option<(usize, u32)> {
    let inner = tok.strip_prefix('<')?.strip_suffix('>')?.trim();
    let clean: String = inner.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if clean.is_empty() || clean.len() > 8 {
        return None;
    }
    u32::from_str_radix(&clean, 16).ok().map(|v| (clean.len(), v))
}

fn parse_hex_bytes(tok: &str) -> Option<(usize, Vec<u8>)> {
    let inner = tok.strip_prefix('<')?.strip_suffix('>')?.trim();
    let clean: String = inner.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut out = Vec::new();
    let bytes = clean.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let hi = hex_nibble(bytes[i])?;
        let lo = if i + 1 < bytes.len() { hex_nibble(bytes[i + 1])? } else { 0 };
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some((clean.len(), out))
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn decode_utf16_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if bytes.len() == 1 {
        return char::from(bytes[0]).to_string();
    }
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().copied().map(u16::from_be_bytes).collect();
    String::from_utf16_lossy(&units)
}

#[derive(Clone, Debug)]
pub(crate) enum ContentTokenKind {
    Word(Vec<u8>),
    Name(Vec<u8>),
    Literal { raw: Vec<u8> },
    Hex { raw: Vec<u8> },
    ArrayOpen,
    ArrayClose,
}

#[derive(Clone, Debug)]
pub(crate) struct ContentToken {
    pub kind: ContentTokenKind,
    pub start: usize,
    pub end: usize,
}

pub(crate) fn tokenize_content(data: &[u8]) -> Vec<ContentToken> {
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let b = data[i];
        if b.is_ascii_whitespace() || b == 0 {
            i += 1;
            continue;
        }
        if b == b'%' {
            while i < data.len() && data[i] != b'\n' && data[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        if b == b'(' {
            let start = i;
            let raw = read_literal_bytes(data, &mut i);
            tokens.push(ContentToken { kind: ContentTokenKind::Literal { raw }, start, end: i });
            continue;
        }
        if b == b'<' {
            if data.get(i + 1) == Some(&b'<') {
                i += 2;
                let mut depth = 1usize;
                while i + 1 < data.len() && depth > 0 {
                    if data[i] == b'<' && data[i + 1] == b'<' {
                        depth += 1;
                        i += 2;
                    } else if data[i] == b'>' && data[i + 1] == b'>' {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                continue;
            }
            let start = i;
            let raw = read_hex_bytes(data, &mut i);
            tokens.push(ContentToken { kind: ContentTokenKind::Hex { raw }, start, end: i });
            continue;
        }
        if b == b'[' {
            tokens.push(ContentToken { kind: ContentTokenKind::ArrayOpen, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        if b == b']' {
            tokens.push(ContentToken { kind: ContentTokenKind::ArrayClose, start: i, end: i + 1 });
            i += 1;
            continue;
        }
        if b == b'/' {
            let start = i;
            i += 1;
            while i < data.len() && !is_pdf_delim_or_ws(data[i]) {
                i += 1;
            }
            tokens.push(ContentToken { kind: ContentTokenKind::Name(data[start + 1..i].to_vec()), start, end: i });
            continue;
        }
        let start = i;
        while i < data.len() && !is_pdf_delim_or_ws(data[i]) {
            i += 1;
        }
        if i == start {
            i += 1;
            continue;
        }
        let word = &data[start..i];
        if word == b"BI" {
            // Skip inline image payload safely up to ID + EI.
            while i + 2 < data.len() {
                if data[i].is_ascii_whitespace()
                    && &data[i + 1..i + 3] == b"EI"
                    && data.get(i + 3).is_none_or(|c| c.is_ascii_whitespace())
                {
                    i += 3;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if !word.is_empty() {
            tokens.push(ContentToken { kind: ContentTokenKind::Word(word.to_vec()), start, end: i });
        }
    }
    tokens
}

fn is_pdf_delim_or_ws(b: u8) -> bool {
    b.is_ascii_whitespace() || matches!(b, 0 | b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

fn read_literal_bytes(data: &[u8], i: &mut usize) -> Vec<u8> {
    *i += 1;
    let mut depth = 1usize;
    let mut out = Vec::new();
    while *i < data.len() && depth > 0 {
        let b = data[*i];
        *i += 1;
        if b == b'\\' {
            let Some(&esc) = data.get(*i) else { break };
            *i += 1;
            match esc {
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'b' => out.push(8),
                b'f' => out.push(12),
                b'(' | b')' | b'\\' => out.push(esc),
                b'\r' => {
                    if data.get(*i) == Some(&b'\n') {
                        *i += 1;
                    }
                }
                b'\n' => {}
                b'0'..=b'7' => {
                    let mut val = esc - b'0';
                    for _ in 0..2 {
                        if let Some(&d) = data.get(*i)
                            && (b'0'..=b'7').contains(&d)
                        {
                            val = val.wrapping_mul(8).wrapping_add(d - b'0');
                            *i += 1;
                        } else {
                            break;
                        }
                    }
                    out.push(val);
                }
                other => out.push(other),
            }
        } else if b == b'(' {
            depth += 1;
            out.push(b'(');
        } else if b == b')' {
            depth -= 1;
            if depth > 0 {
                out.push(b')');
            }
        } else {
            out.push(b);
        }
    }
    out
}

fn read_hex_bytes(data: &[u8], i: &mut usize) -> Vec<u8> {
    *i += 1;
    let mut nibbles = Vec::new();
    while *i < data.len() {
        let b = data[*i];
        *i += 1;
        if b == b'>' {
            break;
        }
        if let Some(n) = hex_nibble(b) {
            nibbles.push(n);
        }
    }
    let mut out = Vec::with_capacity(nibbles.len().div_ceil(2));
    for pair in nibbles.chunks(2) {
        let hi = pair[0];
        let lo = *pair.get(1).unwrap_or(&0);
        out.push((hi << 4) | lo);
    }
    out
}

#[derive(Clone)]
pub(crate) struct ShowOperand {
    pub start: usize,
    pub end: usize,
    pub is_hex: bool,
    pub font_name: Vec<u8>,
    pub text: String,
    pub slices: Vec<GlyphSlice>,
    pub x: f32,
    pub y: f32,
    pub font_size: f32,
}

#[derive(Clone)]
pub(crate) struct TextLine {
    pub operands: Vec<ShowOperand>,
    pub text: String,
    /// `(op_idx, slice_idx)` per byte range `(start..end)` in `text`.
    pub char_map: Vec<(usize, usize, usize, usize)>,
}

pub(crate) fn extract_stream_lines(data: &[u8], fonts: &FontMap) -> Vec<TextLine> {
    let tokens = tokenize_content(data);
    let mut lines: Vec<TextLine> = Vec::new();
    let mut cur_line: Vec<(ShowOperand, bool)> = Vec::new();

    let mut operands: Vec<&ContentToken> = Vec::new();
    let mut current_font: Vec<u8> = Vec::new();
    let mut current_size: f32 = 12.0;
    let mut tx: f32 = 0.0;
    let mut ty: f32 = 0.0;
    let mut tlm_x: f32 = 0.0;
    let mut tlm_y: f32 = 0.0;
    let mut leading: f32 = 14.0;
    let mut last_y: Option<f32> = None;

    let flush_line = |buf: &mut Vec<(ShowOperand, bool)>, out: &mut Vec<TextLine>| {
        if buf.is_empty() {
            return;
        }
        let mut combined = String::new();
        let mut char_map = Vec::new();
        let mut ops = Vec::with_capacity(buf.len());
        for (op_idx, (op, gap_space)) in buf.drain(..).enumerate() {
            if gap_space
                && !combined.is_empty()
                && !combined.ends_with(char::is_whitespace)
                && !op.text.starts_with(char::is_whitespace)
            {
                combined.push(' ');
            }
            for (slice_idx, sl) in op.slices.iter().enumerate() {
                let s = combined.len();
                combined.push_str(&op.text[sl.text_start..sl.text_end]);
                let e = combined.len();
                char_map.push((op_idx, slice_idx, s, e));
            }
            ops.push(op);
        }
        if !combined.is_empty() {
            out.push(TextLine { operands: ops, text: combined, char_map });
        }
    };

    let default_font = FontDecoder::default();
    let mut idx = 0usize;
    while idx < tokens.len() {
        let tok = &tokens[idx];
        match &tok.kind {
            ContentTokenKind::Word(w) if is_operator(w) => {
                match w.as_slice() {
                    b"BT" => {
                        flush_line(&mut cur_line, &mut lines);
                        tx = 0.0;
                        ty = 0.0;
                        tlm_x = 0.0;
                        tlm_y = 0.0;
                        last_y = None;
                    }
                    b"ET" => flush_line(&mut cur_line, &mut lines),
                    b"Tf" => {
                        if operands.len() >= 2 {
                            if let ContentTokenKind::Name(n) = &operands[operands.len() - 2].kind {
                                current_font = n.clone();
                            }
                            if let Some(sz) = token_f32(operands[operands.len() - 1]) {
                                current_size = sz.abs().max(1.0);
                            }
                        }
                    }
                    b"TL" => {
                        if let Some(tl) = operands.last().and_then(|t| token_f32(t)) {
                            leading = tl;
                        }
                    }
                    b"Td" | b"TD" => {
                        if operands.len() >= 2
                            && let (Some(dx), Some(dy)) =
                                (token_f32(operands[operands.len() - 2]), token_f32(operands[operands.len() - 1]))
                        {
                            tlm_x += dx;
                            tlm_y += dy;
                            tx = tlm_x;
                            ty = tlm_y;
                            if w.as_slice() == b"TD" {
                                leading = -dy;
                            }
                            if dy.abs() > 0.5 && last_y.is_some_and(|py| (py - ty).abs() > 0.5) {
                                flush_line(&mut cur_line, &mut lines);
                            }
                        }
                    }
                    b"Tm" => {
                        if operands.len() >= 6
                            && let (Some(e), Some(f)) =
                                (token_f32(operands[operands.len() - 2]), token_f32(operands[operands.len() - 1]))
                        {
                            tlm_x = e;
                            tlm_y = f;
                            tx = e;
                            ty = f;
                            if last_y.is_some_and(|py| (py - ty).abs() > 0.5) {
                                flush_line(&mut cur_line, &mut lines);
                            }
                        }
                    }
                    b"T*" => {
                        tlm_y -= leading;
                        tx = tlm_x;
                        ty = tlm_y;
                        flush_line(&mut cur_line, &mut lines);
                    }
                    b"Tj" | b"'" | b"\"" => {
                        if matches!(w.as_slice(), b"'" | b"\"") {
                            tlm_y -= leading;
                            tx = tlm_x;
                            ty = tlm_y;
                            flush_line(&mut cur_line, &mut lines);
                        }
                        if let Some(op_tok) = operands.last() {
                            let decoder = fonts.get(&current_font).unwrap_or(&default_font);
                            if let Some(show_op) =
                                build_show_operand(op_tok, decoder, &current_font, tx, ty, current_size)
                            {
                                let gap = last_y.is_some() && !cur_line.is_empty();
                                cur_line.push((show_op, gap));
                                last_y = Some(ty);
                            }
                        }
                    }
                    b"TJ" => {
                        if let Some(open_pos) =
                            operands.iter().rposition(|t| matches!(t.kind, ContentTokenKind::ArrayOpen))
                        {
                            let decoder = fonts.get(&current_font).unwrap_or(&default_font);
                            let mut pending_gap = false;
                            for item in &operands[open_pos + 1..] {
                                if matches!(item.kind, ContentTokenKind::ArrayClose) {
                                    break;
                                }
                                if let Some(kern) = token_f32(item) {
                                    if kern < -120.0 {
                                        pending_gap = true;
                                    }
                                    continue;
                                }
                                if let Some(show_op) =
                                    build_show_operand(item, decoder, &current_font, tx, ty, current_size)
                                {
                                    cur_line.push((show_op, pending_gap));
                                    pending_gap = false;
                                    last_y = Some(ty);
                                }
                            }
                        }
                    }
                    _ => {}
                }
                operands.clear();
            }
            _ => operands.push(tok),
        }
        idx += 1;
    }
    flush_line(&mut cur_line, &mut lines);
    lines
}

fn build_show_operand(
    tok: &ContentToken,
    decoder: &FontDecoder,
    font: &[u8],
    x: f32,
    y: f32,
    font_size: f32,
) -> Option<ShowOperand> {
    let (raw, is_hex) = match &tok.kind {
        ContentTokenKind::Literal { raw } => (raw.as_slice(), false),
        ContentTokenKind::Hex { raw } => (raw.as_slice(), true),
        _ => return None,
    };
    let (text, slices) = decoder.decode_bytes(raw);
    Some(ShowOperand {
        start: tok.start,
        end: tok.end,
        is_hex,
        font_name: font.to_vec(),
        text,
        slices,
        x,
        y,
        font_size,
    })
}

fn token_f32(tok: &ContentToken) -> Option<f32> {
    match &tok.kind {
        ContentTokenKind::Word(w) => std::str::from_utf8(w).ok()?.parse::<f32>().ok(),
        _ => None,
    }
}

fn is_operator(w: &[u8]) -> bool {
    matches!(
        w,
        b"BT"
            | b"ET"
            | b"Tf"
            | b"TL"
            | b"Td"
            | b"TD"
            | b"Tm"
            | b"T*"
            | b"Tc"
            | b"Tw"
            | b"Tz"
            | b"Ts"
            | b"Tr"
            | b"Tj"
            | b"TJ"
            | b"'"
            | b"\""
            | b"q"
            | b"Q"
            | b"cm"
            | b"re"
            | b"f"
            | b"F"
            | b"S"
            | b"s"
            | b"B"
            | b"b"
            | b"n"
            | b"W"
            | b"W*"
            | b"m"
            | b"l"
            | b"c"
            | b"v"
            | b"y"
            | b"h"
            | b"rg"
            | b"RG"
            | b"g"
            | b"G"
            | b"k"
            | b"K"
            | b"gs"
            | b"Do"
            | b"w"
            | b"J"
            | b"j"
            | b"M"
            | b"d"
            | b"i"
            | b"cs"
            | b"CS"
            | b"sc"
            | b"SC"
            | b"scn"
            | b"SCN"
            | b"BDC"
            | b"BMC"
            | b"EMC"
            | b"MP"
            | b"DP"
            | b"sh"
    )
}

pub fn pdf_text(pdf: &[u8]) -> Result<Vec<String>, FileError> {
    let doc = Document::open(Arc::new(pdf.to_vec()))?;
    let pages = collect_pages(&doc)?;
    let mut out = Vec::with_capacity(pages.len());
    for page in &pages {
        let fonts = page_fonts(&doc, page);
        let parts = page_content_parts(&doc, page.page_ref)?;
        let mut page_lines = BTreeMap::<i64, Vec<(i64, String)>>::new();
        let mut fallback_order = 0i64;
        for part in parts {
            let lines = extract_stream_lines(&part.bytes, &fonts);
            for line in lines {
                let y_key = line.operands.first().map_or(fallback_order, |op| -(op.y * 10.0).round() as i64);
                let x_key = line.operands.first().map_or(0, |op| (op.x * 10.0).round() as i64);
                page_lines.entry(y_key).or_default().push((x_key, line.text));
                fallback_order += 1;
            }
        }
        let mut text_lines = Vec::new();
        for mut row in page_lines.into_values() {
            row.sort_by_key(|(x, _)| *x);
            let joined: String = row.into_iter().map(|(_, t)| t).collect::<Vec<_>>().join(" ");
            let trimmed = joined.trim();
            if !trimmed.is_empty() {
                text_lines.push(trimmed.to_owned());
            }
        }
        out.push(text_lines.join("\n"));
    }
    Ok(out)
}

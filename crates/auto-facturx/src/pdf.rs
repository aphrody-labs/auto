//! Pure-Rust PDF/A-3b conversion, Factur-X XML attachment, extraction, and preflight checks using `craft_pdf::cos`.

use crate::FacturxError;
use chrono::{DateTime, Utc};
use craft_pdf::cos::{Dict, Document, ObjRef, Object, PdfString, SaveOptions, Stream, pdf_date, write_full};
use std::collections::HashSet;
use std::sync::Arc;

const FACTURX_FILENAME: &str = "factur-x.xml";

/// Wraps rendered PDF bytes into PDF/A-3b and embeds EN 16931 `factur-x.xml`.
pub fn assemble_facturx_pdf(
    pdf_bytes: &[u8],
    xml: &str,
    invoice_number: &str,
    unix_secs: i64,
) -> Result<Vec<u8>, FacturxError> {
    let mut doc = Document::open(Arc::new(pdf_bytes.to_vec()))?;
    doc.set_version("1.7");

    let root_ref = doc.root().ok_or(FacturxError::MissingCatalog)?;
    let pdf_ts = pdf_date(unix_secs);
    let iso_ts = format_xmp_utc(unix_secs);

    // 1. Update Info dictionary with matching producer/title/timestamps.
    let info_ref = ensure_info_dict(&mut doc, invoice_number, &pdf_ts)?;

    // 2. OutputIntent (sRGB IEC 61966-2.1 ICC v2.1 profile).
    let icc_bytes = srgb_icc_v2();
    let mut icc_dict = Dict::new();
    icc_dict.set("N", Object::Int(3));
    icc_dict.set("Alternate", Object::name("DeviceRGB"));
    let icc_ref = doc.add(Stream::flate(icc_dict, &icc_bytes));

    let mut intent = Dict::new();
    intent.set("Type", Object::name("OutputIntent"));
    intent.set("S", Object::name("GTS_PDFA1"));
    intent.set("OutputConditionIdentifier", Object::String(PdfString::text("sRGB IEC61966-2.1")));
    intent.set("RegistryName", Object::String(PdfString::text("http://www.color.org")));
    intent.set("Info", Object::String(PdfString::text("sRGB IEC61966-2.1")));
    intent.set("DestOutputProfile", icc_ref);
    let intent_ref = doc.add(intent);

    // 3. Embedded `factur-x.xml` file stream + FileSpec.
    let mut ef_params = Dict::new();
    ef_params.set("Size", Object::Int(xml.len() as i64));
    ef_params.set("ModDate", Object::String(PdfString::literal(pdf_ts.as_bytes().to_vec())));

    let mut ef_dict = Dict::new();
    ef_dict.set("Type", Object::name("EmbeddedFile"));
    ef_dict.set("Subtype", Object::name("text/xml"));
    ef_dict.set("Params", ef_params);
    let ef_ref = doc.add(Stream::flate(ef_dict, xml.as_bytes()));

    let mut ef_map = Dict::new();
    ef_map.set("F", ef_ref);
    ef_map.set("UF", ef_ref);

    let mut filespec = Dict::new();
    filespec.set("Type", Object::name("Filespec"));
    filespec.set("F", Object::String(PdfString::text(FACTURX_FILENAME)));
    filespec.set("UF", Object::String(PdfString::text(FACTURX_FILENAME)));
    filespec.set("Desc", Object::String(PdfString::text("Factur-X EN 16931 invoice XML")));
    filespec.set("AFRelationship", Object::name("Alternative"));
    filespec.set("EF", ef_map);
    let filespec_ref = doc.add(filespec);

    // 4. Names/EmbeddedFiles tree.
    let mut ef_tree = Dict::new();
    ef_tree.set("Names", vec![Object::String(PdfString::text(FACTURX_FILENAME)), Object::Ref(filespec_ref)]);
    let ef_tree_ref = doc.add(ef_tree);
    let mut names_dict = Dict::new();
    names_dict.set("EmbeddedFiles", ef_tree_ref);
    let names_ref = doc.add(names_dict);

    // 5. Uncompressed PDF/A-3b + Factur-X XMP metadata packet.
    let xmp_bytes = build_facturx_xmp(invoice_number, &iso_ts);
    let mut meta_dict = Dict::new();
    meta_dict.set("Type", Object::name("Metadata"));
    meta_dict.set("Subtype", Object::name("XML"));
    let meta_ref = doc.add(Stream::from_raw(meta_dict, xmp_bytes));

    let mut mark_info = Dict::new();
    mark_info.set("Marked", Object::Bool(true));

    doc.update_dict(root_ref, |catalog| {
        catalog.set("MarkInfo", mark_info);
        catalog.set("OutputIntents", vec![Object::Ref(intent_ref)]);
        catalog.set("Metadata", meta_ref);
        catalog.set("AF", vec![Object::Ref(filespec_ref)]);
        catalog.set("Names", names_ref);
    })?;
    doc.trailer_mut().set("Info", info_ref);

    let opts = SaveOptions {
        mod_date: Some(pdf_ts),
        object_streams: false,
        id_entropy: Some(*b"facturx-pdfa3b01"),
        ..SaveOptions::default()
    };
    Ok(write_full(&doc, &opts)?)
}

/// Extracts an embedded Factur-X XML document (`factur-x.xml` or ZUGFeRD XML) from PDF bytes.
pub fn extract_xml_from_pdf(pdf_bytes: &[u8]) -> Result<Option<String>, FacturxError> {
    let doc = Document::open(Arc::new(pdf_bytes.to_vec()))?;
    let Some(root_ref) = doc.root() else {
        return Ok(None);
    };
    let catalog = doc.get(root_ref);
    let Some(cat_dict) = catalog.as_dict() else {
        return Ok(None);
    };

    let mut specs: Vec<ObjRef> = Vec::new();
    if let Some(af) = cat_dict.get(b"AF").and_then(|o| doc.resolve(o).as_array().cloned()) {
        for item in af {
            if let Some(r) = item.as_ref() {
                specs.push(r);
            }
        }
    }
    if let Some(names_obj) = cat_dict.get(b"Names")
        && let Some(names_dict) = doc.dict(names_obj)
        && let Some(ef_root) = names_dict.get(b"EmbeddedFiles")
    {
        collect_name_tree_refs(&doc, ef_root, &mut specs);
    }

    for spec_ref in specs {
        let spec = doc.get(spec_ref);
        let Some(sd) = spec.as_dict() else {
            continue;
        };
        let fname = sd
            .get(b"UF")
            .or_else(|| sd.get(b"F"))
            .and_then(|o| doc.resolve(o).as_string().map(|s| s.to_text()))
            .unwrap_or_default();
        let lower = fname.to_ascii_lowercase();
        let is_facturx_name = lower.contains("factur-x") || lower.contains("zugferd") || lower.ends_with(".xml");
        if !is_facturx_name {
            continue;
        }
        let Some(ef_dict) = sd.get(b"EF").and_then(|o| doc.dict(o)) else {
            continue;
        };
        let Some(stream_ref) = ef_dict.reference(b"UF").or_else(|| ef_dict.reference(b"F")) else {
            continue;
        };
        if let Object::Stream(stream) = &*doc.get(stream_ref) {
            let decoded = stream.decoded()?;
            if let Ok(text) = String::from_utf8(decoded) {
                return Ok(Some(text));
            }
        }
    }

    Ok(None)
}

fn collect_name_tree_refs(doc: &Document, node: &Object, out: &mut Vec<ObjRef>) {
    let Some(dict) = doc.dict(node) else {
        return;
    };
    if let Some(names) = dict.get(b"Names").and_then(|o| doc.resolve(o).as_array().cloned()) {
        for [_, val] in names.as_chunks::<2>().0 {
            if let Some(r) = val.as_ref() {
                out.push(r);
            }
        }
    }
    if let Some(kids) = dict.get(b"Kids").and_then(|o| doc.resolve(o).as_array().cloned()) {
        for kid in kids {
            collect_name_tree_refs(doc, &kid, out);
        }
    }
}

/// Checks core PDF/A-3b structural requirements and returns human-readable non-compliance messages.
pub fn verify_pdfa3b(pdf_bytes: &[u8]) -> Result<Vec<String>, FacturxError> {
    let doc = Document::open(Arc::new(pdf_bytes.to_vec()))?;
    let mut issues = Vec::new();

    if doc.security().is_some() || doc.trailer().contains(b"Encrypt") {
        issues.push("PDF/A forbids document encryption".into());
    }
    let has_id =
        doc.trailer().get(b"ID").and_then(|o| doc.resolve(o).as_array().map(|a| a.len() >= 2)).unwrap_or(false);
    if !has_id {
        issues.push("missing trailer /ID array".into());
    }

    let Some(root_ref) = doc.root() else {
        issues.push("missing document catalog".into());
        return Ok(issues);
    };
    let catalog_obj = doc.get(root_ref);
    let Some(catalog) = catalog_obj.as_dict() else {
        issues.push("document catalog is not a dictionary".into());
        return Ok(issues);
    };

    // MarkInfo check.
    let marked = catalog
        .get(b"MarkInfo")
        .and_then(|o| doc.dict(o))
        .and_then(|d| match d.get(b"Marked") {
            Some(Object::Bool(b)) => Some(*b),
            _ => None,
        })
        .unwrap_or(false);
    if !marked {
        issues.push("missing /MarkInfo << /Marked true >>".into());
    }

    // OutputIntent & ICC profile check.
    let mut valid_intent = false;
    if let Some(intents) = catalog.get(b"OutputIntents").and_then(|o| doc.resolve(o).as_array().cloned()) {
        for item in intents {
            if let Some(idict) = doc.dict(&item)
                && idict.name(b"S") == Some(b"GTS_PDFA1")
                && let Some(prof_obj) = idict.get(b"DestOutputProfile")
                && let Object::Stream(s) = &*doc.resolve(prof_obj)
                && let Ok(icc) = s.decoded()
                && icc.len() >= 40
                && &icc[36..40] == b"acsp"
            {
                valid_intent = true;
                break;
            }
        }
    }
    if !valid_intent {
        issues.push("missing valid GTS_PDFA1 /OutputIntents with ICC profile".into());
    }

    // Metadata XMP check (must be uncompressed and declare pdfaid:part=3, conformance=B).
    let mut valid_xmp = false;
    if let Some(meta_obj) = catalog.get(b"Metadata")
        && let Object::Stream(ms) = &*doc.resolve(meta_obj)
    {
        if !ms.filters().is_empty() {
            issues.push("XMP /Metadata stream must not be compressed".into());
        } else if let Ok(raw) = ms.decoded()
            && let Ok(xmp) = std::str::from_utf8(&raw)
        {
            let has_part3 = xmp.contains("pdfaid:part=\"3\"") || xmp.contains("<pdfaid:part>3</pdfaid:part>");
            let has_conf_b =
                xmp.contains("pdfaid:conformance=\"B\"") || xmp.contains("<pdfaid:conformance>B</pdfaid:conformance>");
            if has_part3 && has_conf_b {
                valid_xmp = true;
            }
        }
    }
    if !valid_xmp {
        issues.push("missing PDF/A-3b XMP metadata identification (pdfaid:part=3, conformance=B)".into());
    }

    // Embedded files must carry AFRelationship and EF stream Subtype when present.
    if let Some(af) = catalog.get(b"AF").and_then(|o| doc.resolve(o).as_array().cloned()) {
        for item in af {
            if let Some(sd) = doc.dict(&item) {
                if sd.name(b"AFRelationship").is_none() {
                    issues.push("embedded /AF filespec missing /AFRelationship".into());
                }
                if sd.get(b"UF").is_none() {
                    issues.push("embedded /AF filespec missing Unicode /UF filename".into());
                }
            }
        }
    }

    // Verify all page fonts are embedded.
    verify_page_fonts(&doc, catalog, &mut issues);

    Ok(issues)
}

fn verify_page_fonts(doc: &Document, catalog: &Dict, issues: &mut Vec<String>) {
    let Some(pages_ref) = catalog.reference(b"Pages") else {
        issues.push("missing catalog /Pages".into());
        return;
    };
    let mut page_refs = Vec::new();
    let mut visited = HashSet::new();
    collect_pages(doc, pages_ref, &mut visited, &mut page_refs);

    let mut checked_fonts = HashSet::new();
    for pref in page_refs {
        let p = doc.get(pref);
        let Some(pdict) = p.as_dict() else { continue };
        let Some(res) = pdict.get(b"Resources").and_then(|o| doc.dict(o)) else { continue };
        let Some(fonts) = res.get(b"Font").and_then(|o| doc.dict(o)) else { continue };
        for (fname, fobj) in fonts.iter() {
            if let Some(r) = fobj.as_ref()
                && !checked_fonts.insert(r)
            {
                continue;
            }
            if !is_font_embedded(doc, fobj) {
                issues.push(format!("font /{} is not embedded", String::from_utf8_lossy(fname)));
            }
        }
    }
}

fn collect_pages(doc: &Document, node_ref: ObjRef, seen: &mut HashSet<ObjRef>, out: &mut Vec<ObjRef>) {
    if !seen.insert(node_ref) {
        return;
    }
    let obj = doc.get(node_ref);
    let Some(dict) = obj.as_dict() else { return };
    match dict.name(b"Type") {
        Some(b"Page") => out.push(node_ref),
        _ => {
            if let Some(kids) = dict.get(b"Kids").and_then(|o| doc.resolve(o).as_array().cloned()) {
                for kid in kids {
                    if let Some(kr) = kid.as_ref() {
                        collect_pages(doc, kr, seen, out);
                    }
                }
            }
        }
    }
}

fn is_font_embedded(doc: &Document, fobj: &Object) -> bool {
    let Some(fdict) = doc.dict(fobj) else { return false };
    let target_dict = if fdict.name(b"Subtype") == Some(b"Type0") {
        let Some(desc_arr) = fdict.get(b"DescendantFonts").and_then(|o| doc.resolve(o).as_array().cloned()) else {
            return false;
        };
        let Some(first) = desc_arr.first() else { return false };
        let Some(d) = doc.dict(first) else { return false };
        d
    } else {
        fdict
    };
    let Some(fd) = target_dict.get(b"FontDescriptor").and_then(|o| doc.dict(o)) else {
        return false;
    };
    fd.contains(b"FontFile") || fd.contains(b"FontFile2") || fd.contains(b"FontFile3")
}

fn ensure_info_dict(doc: &mut Document, invoice_number: &str, pdf_ts: &str) -> Result<ObjRef, FacturxError> {
    if let Some(info_ref) = doc.trailer().reference(b"Info") {
        doc.update_dict(info_ref, |d| {
            d.set("Title", Object::String(PdfString::text(&format!("Factur-X {invoice_number}"))));
            d.set("Creator", Object::String(PdfString::text("auto-facturx")));
            d.set("Producer", Object::String(PdfString::text("auto-facturx (craft-pdf/cos)")));
            if !d.contains(b"CreationDate") {
                d.set("CreationDate", Object::String(PdfString::literal(pdf_ts.as_bytes().to_vec())));
            }
            d.set("ModDate", Object::String(PdfString::literal(pdf_ts.as_bytes().to_vec())));
        })?;
        Ok(info_ref)
    } else {
        let mut d = Dict::new();
        d.set("Title", Object::String(PdfString::text(&format!("Factur-X {invoice_number}"))));
        d.set("Creator", Object::String(PdfString::text("auto-facturx")));
        d.set("Producer", Object::String(PdfString::text("auto-facturx (craft-pdf/cos)")));
        d.set("CreationDate", Object::String(PdfString::literal(pdf_ts.as_bytes().to_vec())));
        d.set("ModDate", Object::String(PdfString::literal(pdf_ts.as_bytes().to_vec())));
        Ok(doc.add(d))
    }
}

fn format_xmp_utc(unix_secs: i64) -> String {
    DateTime::<Utc>::from_timestamp(unix_secs, 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

fn build_facturx_xmp(invoice_number: &str, iso_ts: &str) -> Vec<u8> {
    let title = xml_escape(invoice_number);
    format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
         <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
         \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
         \x20   <rdf:Description rdf:about=\"\" xmlns:pdfaid=\"http://www.aiim.org/pdfa/ns/id/\">\n\
         \x20     <pdfaid:part>3</pdfaid:part>\n\
         \x20     <pdfaid:conformance>B</pdfaid:conformance>\n\
         \x20   </rdf:Description>\n\
         \x20   <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
         \x20     <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Factur-X {title}</rdf:li></rdf:Alt></dc:title>\n\
         \x20   </rdf:Description>\n\
         \x20   <rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n\
         \x20     <xmp:CreatorTool>auto-facturx</xmp:CreatorTool>\n\
         \x20     <xmp:CreateDate>{iso_ts}</xmp:CreateDate>\n\
         \x20     <xmp:ModifyDate>{iso_ts}</xmp:ModifyDate>\n\
         \x20   </rdf:Description>\n\
         \x20   <rdf:Description rdf:about=\"\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\">\n\
         \x20     <pdf:Producer>auto-facturx (craft-pdf/cos)</pdf:Producer>\n\
         \x20   </rdf:Description>\n\
         \x20   <rdf:Description rdf:about=\"\" xmlns:fx=\"urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#\">\n\
         \x20     <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>\n\
         \x20     <fx:DocumentType>INVOICE</fx:DocumentType>\n\
         \x20     <fx:Version>1.0</fx:Version>\n\
         \x20     <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>\n\
         \x20   </rdf:Description>\n\
         \x20   <rdf:Description rdf:about=\"\" \
                  xmlns:pdfaExtension=\"http://www.aiim.org/pdfa/ns/extension/\" \
                  xmlns:pdfaSchema=\"http://www.aiim.org/pdfa/ns/schema#\" \
                  xmlns:pdfaProperty=\"http://www.aiim.org/pdfa/ns/property#\">\n\
         \x20     <pdfaExtension:schemas>\n\
         \x20       <rdf:Bag>\n\
         \x20         <rdf:li rdf:parseType=\"Resource\">\n\
         \x20           <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>\n\
         \x20           <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>\n\
         \x20           <pdfaSchema:prefix>fx</pdfaSchema:prefix>\n\
         \x20           <pdfaSchema:property>\n\
         \x20             <rdf:Seq>\n\
         \x20               <rdf:li rdf:parseType=\"Resource\"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Factur-X XML filename</pdfaProperty:description></rdf:li>\n\
         \x20               <rdf:li rdf:parseType=\"Resource\"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>\n\
         \x20               <rdf:li rdf:parseType=\"Resource\"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>1.0</pdfaProperty:description></rdf:li>\n\
         \x20               <rdf:li rdf:parseType=\"Resource\"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>EN 16931</pdfaProperty:description></rdf:li>\n\
         \x20             </rdf:Seq>\n\
         \x20           </pdfaSchema:property>\n\
         \x20         </rdf:li>\n\
         \x20       </rdf:Bag>\n\
         \x20     </pdfaExtension:schemas>\n\
         \x20   </rdf:Description>\n\
         \x20 </rdf:RDF>\n\
         </x:xmpmeta>\n\
         <?xpacket end=\"w\"?>\n"
    )
    .into_bytes()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Builds a compact, self-contained ICC v2.1 sRGB profile (IEC 61966-2-1, D50 Bradford primaries).
fn srgb_icc_v2() -> Vec<u8> {
    fn s15f16(v: f64) -> [u8; 4] {
        ((v * 65536.0).round() as i32).to_be_bytes()
    }
    fn xyz(x: f64, y: f64, z: f64) -> Vec<u8> {
        let mut t = b"XYZ \0\0\0\0".to_vec();
        t.extend(s15f16(x));
        t.extend(s15f16(y));
        t.extend(s15f16(z));
        t
    }
    fn desc(text: &str) -> Vec<u8> {
        let mut t = b"desc\0\0\0\0".to_vec();
        let ascii: Vec<u8> = text.bytes().chain(std::iter::once(0)).collect();
        t.extend((ascii.len() as u32).to_be_bytes());
        t.extend(&ascii);
        t.extend([0u8; 4 + 4 + 2 + 1 + 67]);
        t
    }
    fn text_tag(text: &str) -> Vec<u8> {
        let mut t = b"text\0\0\0\0".to_vec();
        t.extend(text.bytes());
        t.push(0);
        t
    }
    fn curve() -> Vec<u8> {
        const N: usize = 1024;
        let mut t = b"curv\0\0\0\0".to_vec();
        t.extend((N as u32).to_be_bytes());
        for i in 0..N {
            let v = i as f64 / (N - 1) as f64;
            let lin = if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
            t.extend(((lin * 65535.0).round() as u16).to_be_bytes());
        }
        t
    }

    let tags: [(&[u8; 4], Vec<u8>); 7] = [
        (b"desc", desc("sRGB IEC61966-2.1")),
        (b"cprt", text_tag("CC0-1.0 public domain")),
        (b"wtpt", xyz(0.9642, 1.0, 0.8249)),
        (b"rXYZ", xyz(0.4361, 0.2225, 0.0139)),
        (b"gXYZ", xyz(0.3851, 0.7169, 0.0971)),
        (b"bXYZ", xyz(0.1431, 0.0606, 0.7141)),
        (b"rTRC", curve()),
    ];
    let count = tags.len() + 2;
    let mut offset = 128 + 4 + count * 12;
    let mut table = (count as u32).to_be_bytes().to_vec();
    let mut data = Vec::new();
    let mut trc = (0usize, 0usize);

    for (sig, body) in &tags {
        let len = body.len();
        table.extend(*sig);
        table.extend((offset as u32).to_be_bytes());
        table.extend((len as u32).to_be_bytes());
        if *sig == b"rTRC" {
            trc = (offset, len);
        }
        data.extend(body);
        let pad = (4 - len % 4) % 4;
        data.extend(std::iter::repeat_n(0u8, pad));
        offset += len + pad;
    }
    for sig in [b"gTRC", b"bTRC"] {
        table.extend(sig);
        table.extend((trc.0 as u32).to_be_bytes());
        table.extend((trc.1 as u32).to_be_bytes());
    }

    let size = 128 + table.len() + data.len();
    let mut header = Vec::with_capacity(size);
    header.extend((size as u32).to_be_bytes());
    header.extend(b"\0\0\0\0");
    header.extend([2, 0x10, 0, 0]);
    header.extend(b"mntrRGB XYZ ");
    header.extend([0u8; 12]);
    header.extend(b"acsp");
    header.extend([0u8; 28]);
    header.extend(s15f16(0.9642));
    header.extend(s15f16(1.0));
    header.extend(s15f16(0.8249));
    header.resize(128, 0);
    header.extend(table);
    header.extend(data);
    header
}

//! Assemblage PDF/A-3b : conversion par `pdfcraft-preflight`, puis `factur-x.xml` embarqué
//! (`/AF`, `/Names /EmbeddedFiles`, `AFRelationship /Alternative`) et extension XMP Factur-X.

use crate::Erreur;
use pdfcraft_cos::{Dict, Document, ObjRef, Object, PdfString, SaveOptions, Stream, pdf_date, write_full};
use pdfcraft_preflight::{Level, convert, verify};
use std::sync::Arc;

pub const NOM_XML: &str = "factur-x.xml";

const NS_FX: &str = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";

fn xmp_facturx() -> String {
    let prop = |name: &str, desc: &str| {
        format!(
            "<rdf:li rdf:parseType=\"Resource\"><pdfaProperty:name>{name}</pdfaProperty:name>\
<pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category>\
<pdfaProperty:description>{desc}</pdfaProperty:description></rdf:li>"
        )
    };
    format!(
        "<rdf:Description rdf:about=\"\" xmlns:fx=\"{NS_FX}\">\
<fx:DocumentType>{}</fx:DocumentType><fx:DocumentFileName>{NOM_XML}</fx:DocumentFileName>\
<fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>\n\
<rdf:Description rdf:about=\"\" xmlns:pdfaExtension=\"http://www.aiim.org/pdfa/ns/extension/\" \
xmlns:pdfaSchema=\"http://www.aiim.org/pdfa/ns/schema#\" xmlns:pdfaProperty=\"http://www.aiim.org/pdfa/ns/property#\">\
<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType=\"Resource\">\
<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>\
<pdfaSchema:namespaceURI>{NS_FX}</pdfaSchema:namespaceURI><pdfaSchema:prefix>fx</pdfaSchema:prefix>\
<pdfaSchema:property><rdf:Seq>{}{}{}{}</rdf:Seq></pdfaSchema:property>\
</rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>\n",
        "INVOICE",
        prop("DocumentFileName", "The name of the embedded XML document"),
        prop("DocumentType", "The type of the hybrid document in capital letters, e.g. INVOICE or ORDER"),
        prop("Version", "The actual version of the standard applying to the embedded XML document"),
        prop("ConformanceLevel", "The conformance level of the embedded XML document"),
    )
}

fn catalogue(doc: &Document) -> Result<(ObjRef, Dict), Erreur> {
    let root = doc.root().ok_or_else(|| Erreur::Invalide("PDF sans catalogue".into()))?;
    let cat = doc.dict(&Object::Ref(root)).ok_or_else(|| Erreur::Invalide("catalogue illisible".into()))?;
    Ok((root, cat))
}

/// PDF visuel + XML CII → PDF/A-3b Factur-X (non re-vérifié : voir [`verifier_pdfa`]).
pub fn assembler(pdf: &[u8], xml: &str, date_unix: i64) -> Result<Vec<u8>, Erreur> {
    let mut doc = Document::open(Arc::new(pdf.to_vec()))?;
    // D'abord la conversion : elle retirerait une pièce jointe ajoutée avant elle.
    convert(&mut doc, Level::A3b)?;
    let date = pdf_date(date_unix);

    let mut params = Dict::new();
    params.set(b"Size".to_vec(), Object::Int(xml.len() as i64));
    params.set(b"ModDate".to_vec(), PdfString::text(&date));
    let mut ef = Dict::new();
    ef.set(b"Type".to_vec(), Object::name("EmbeddedFile"));
    ef.set(b"Subtype".to_vec(), Object::name("text/xml"));
    ef.set(b"Params".to_vec(), Object::Dict(params));
    let ef = doc.add(Object::Stream(Stream::flate(ef, xml.as_bytes())));

    let mut efd = Dict::new();
    efd.set(b"F".to_vec(), Object::Ref(ef));
    efd.set(b"UF".to_vec(), Object::Ref(ef));
    let mut fs = Dict::new();
    fs.set(b"Type".to_vec(), Object::name("Filespec"));
    fs.set(b"F".to_vec(), PdfString::text(NOM_XML));
    fs.set(b"UF".to_vec(), PdfString::text(NOM_XML));
    fs.set(b"Desc".to_vec(), PdfString::text("Factur-X"));
    fs.set(b"AFRelationship".to_vec(), Object::name("Alternative"));
    fs.set(b"EF".to_vec(), Object::Dict(efd));
    let fs = doc.add(Object::Dict(fs));

    let (root, cat) = catalogue(&doc)?;

    // XMP : la conversion vient de l'écrire non compressé ; on y ajoute l'extension Factur-X.
    let mref = match cat.get(b"Metadata") {
        Some(Object::Ref(r)) => *r,
        _ => return Err(Erreur::Invalide("XMP absent après conversion PDF/A".into())),
    };
    let meta = doc.get(mref);
    let Object::Stream(s) = &*meta else {
        return Err(Erreur::Invalide("XMP illisible".into()));
    };
    let packet = String::from_utf8(s.decoded()?).map_err(|_| Erreur::Invalide("XMP non UTF-8".into()))?;
    let at = packet.rfind("</rdf:RDF>").ok_or_else(|| Erreur::Invalide("XMP sans rdf:RDF".into()))?;
    let packet = format!("{}{}{}", &packet[..at], xmp_facturx(), &packet[at..]);
    let mut md = s.dict.clone();
    md.remove(b"Filter");
    md.remove(b"DecodeParms");
    doc.set(mref, Object::Stream(Stream::from_raw(md, packet.into_bytes())));

    let mut names = cat.get(b"Names").map(|n| doc.resolve(n)).and_then(|n| n.as_dict().cloned()).unwrap_or_default();
    let mut tree = Dict::new();
    tree.set(b"Names".to_vec(), Object::Array(vec![Object::String(PdfString::text(NOM_XML)), Object::Ref(fs)]));
    names.set(b"EmbeddedFiles".to_vec(), Object::Dict(tree));
    doc.update_dict(root, |c| {
        c.set(b"Names".to_vec(), Object::Dict(names));
        c.set(b"AF".to_vec(), Object::Array(vec![Object::Ref(fs)]));
    })?;

    let opts = SaveOptions { mod_date: Some(date), id_seed: date_unix as u64, ..SaveOptions::default() };
    Ok(write_full(&doc, &opts)?)
}

/// Problèmes PDF/A-3b restants (vide = conforme).
pub fn verifier_pdfa(pdf: &[u8]) -> Result<Vec<String>, Erreur> {
    let doc = Document::open(Arc::new(pdf.to_vec()))?;
    Ok(verify(&doc, Level::A3b).into_iter().map(|i| format!("{} {}", i.clause, i.message)).collect())
}

/// XML Factur-X embarqué d'un PDF reçu, s'il y en a un.
pub fn extraire(pdf: &[u8]) -> Result<Option<String>, Erreur> {
    let doc = Document::open(Arc::new(pdf.to_vec()))?;
    let (_, cat) = catalogue(&doc)?;
    let mut candidats: Vec<Object> =
        cat.get(b"AF").and_then(|a| doc.resolve(a).as_array().cloned()).unwrap_or_default();
    if let Some(list) = cat
        .get(b"Names")
        .and_then(|n| doc.dict(n))
        .and_then(|n| n.get(b"EmbeddedFiles").and_then(|e| doc.dict(e)))
        .and_then(|e| e.get(b"Names").and_then(|l| doc.resolve(l).as_array().cloned()))
    {
        candidats.extend(list.into_iter().skip(1).step_by(2));
    }
    for c in candidats {
        let Some(fs) = doc.dict(&c) else { continue };
        let nom = ["UF", "F"]
            .iter()
            .find_map(|k| fs.get(k.as_bytes()).and_then(|v| doc.resolve(v).as_string().map(|s| s.to_text())));
        let ok = nom.as_deref().is_some_and(|n| {
            let n = n.to_ascii_lowercase();
            n == NOM_XML || n == "zugferd-invoice.xml" || n == "xrechnung.xml"
        });
        if !ok {
            continue;
        }
        let Some(ef) = fs.get(b"EF").and_then(|e| doc.dict(e)) else { continue };
        let Some(f) = ef.get(b"UF").or_else(|| ef.get(b"F")) else { continue };
        if let Object::Stream(s) = &*doc.resolve(f) {
            return Ok(Some(String::from_utf8_lossy(&s.decoded()?).into_owned()));
        }
    }
    Ok(None)
}

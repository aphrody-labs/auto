use std::collections::HashSet;
use std::sync::Arc;

use craft_pdf::cos::{Dict, Document, ObjRef, Object, PdfString, SaveOptions, write_full, write_incremental};
use craft_pkcs7::{cms, keys::DigestAlg, pkcs12, x509};
use serde::{Deserialize, Serialize};

use crate::FileError;
use crate::pdf_ops::collect_pages;

const SIG_PLACEHOLDER_BYTES: usize = 8192;
const BYTERANGE_SENTINEL: &[u8] = b"[0 999999999 999999999 999999999]";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureOptions {
    pub password: String,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub contact: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub page: Option<usize>,
    #[serde(default)]
    pub rect: Option<[f64; 4]>,
    #[serde(default)]
    pub certify: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedSignature {
    pub field: String,
    pub signed: bool,
    pub status: String,
    pub signer: Option<String>,
    pub date: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub format: Option<String>,
    pub algorithm: Option<String>,
    pub certification: Option<u8>,
    pub timestamped: bool,
    pub modifications: String,
    pub changes: Vec<String>,
    pub fingerprint: Option<String>,
    pub details: Vec<String>,
}

pub fn sign_pdf(pdf: &[u8], pkcs12_bytes: &[u8], opts: &SignatureOptions) -> Result<Vec<u8>, FileError> {
    let id = pkcs12::open(pkcs12_bytes, &opts.password)?;
    let mut doc = Document::open(Arc::new(pdf.to_vec()))?;
    if doc.reconstructed() {
        let normalized = write_full(&doc, &SaveOptions { object_streams: false, ..Default::default() })?;
        doc = Document::open(Arc::new(normalized))?;
    }
    let base_len = doc.bytes().len();

    let pages = collect_pages(&doc)?;
    if pages.is_empty() {
        return Err(FileError::InvalidPdf("document has no pages".into()));
    }
    let page_idx = opts.page.unwrap_or(0);
    if page_idx >= pages.len() {
        return Err(FileError::PageOutOfRange { page: page_idx + 1, total: pages.len() });
    }
    let page_ref = pages[page_idx].page_ref;

    let mut sig_dict = Dict::new();
    sig_dict.set(b"Type".to_vec(), Object::name("Sig"));
    sig_dict.set(b"Filter".to_vec(), Object::name("Adobe.PPKLite"));
    sig_dict.set(b"SubFilter".to_vec(), Object::name("adbe.pkcs7.detached"));
    sig_dict.set(b"Name".to_vec(), PdfString::text(&id.certificate.display_name()));
    if let Some(m) = opts.date.as_deref() {
        sig_dict.set(b"M".to_vec(), PdfString::text(m));
    }
    if let Some(reason) = opts.reason.as_deref() {
        sig_dict.set(b"Reason".to_vec(), PdfString::text(reason));
    }
    if let Some(loc) = opts.location.as_deref() {
        sig_dict.set(b"Location".to_vec(), PdfString::text(loc));
    }
    if let Some(contact) = opts.contact.as_deref() {
        sig_dict.set(b"ContactInfo".to_vec(), PdfString::text(contact));
    }
    if let Some(perm @ 1..=3) = opts.certify {
        let mut tparams = Dict::new();
        tparams.set(b"Type".to_vec(), Object::name("TransformParams"));
        tparams.set(b"P".to_vec(), Object::Int(i64::from(perm)));
        tparams.set(b"V".to_vec(), Object::name("1.2"));

        let mut sig_ref_dict = Dict::new();
        sig_ref_dict.set(b"Type".to_vec(), Object::name("SigRef"));
        sig_ref_dict.set(b"TransformMethod".to_vec(), Object::name("DocMDP"));
        sig_ref_dict.set(b"TransformParams".to_vec(), Object::Dict(tparams));
        sig_dict.set(b"Reference".to_vec(), Object::Array(vec![Object::Dict(sig_ref_dict)]));
    }
    sig_dict.set(
        b"ByteRange".to_vec(),
        Object::Array(vec![
            Object::Int(0),
            Object::Int(999_999_999),
            Object::Int(999_999_999),
            Object::Int(999_999_999),
        ]),
    );
    sig_dict
        .set(b"Contents".to_vec(), Object::String(PdfString { bytes: vec![0u8; SIG_PLACEHOLDER_BYTES], hex: true }));
    let sig_obj_ref = doc.add(sig_dict);

    let rect = opts.rect.unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let field_name = opts.field.clone().unwrap_or_else(|| format!("Signature{}", existing_sig_field_count(&doc) + 1));

    let mut widget = Dict::new();
    widget.set(b"Type".to_vec(), Object::name("Annot"));
    widget.set(b"Subtype".to_vec(), Object::name("Widget"));
    widget.set(b"FT".to_vec(), Object::name("Sig"));
    widget.set(b"T".to_vec(), PdfString::text(&field_name));
    widget.set(b"V".to_vec(), Object::Ref(sig_obj_ref));
    widget.set(b"P".to_vec(), Object::Ref(page_ref));
    widget.set(b"F".to_vec(), Object::Int(132));
    widget.set(b"Rect".to_vec(), Object::Array(rect.into_iter().map(Object::Real).collect()));
    let widget_ref = doc.add(widget);

    // Attach widget to target page /Annots.
    let annots_resolved = {
        let p_obj = doc.get(page_ref);
        doc.dict(&p_obj).and_then(|d| d.get(b"Annots").map(|a| doc.resolve(a)))
    };
    let mut annots = annots_resolved.as_deref().and_then(Object::as_array).cloned().unwrap_or_default();
    annots.push(Object::Ref(widget_ref));
    doc.update_dict(page_ref, |d| {
        d.set(b"Annots".to_vec(), Object::Array(annots));
    })?;

    // Attach widget to catalog /AcroForm /Fields.
    let root_ref = doc.root().ok_or_else(|| FileError::InvalidPdf("missing /Root".into()))?;
    let acro_existing = {
        let r_obj = doc.get(root_ref);
        doc.dict(&r_obj).and_then(|r| r.get(b"AcroForm").and_then(|a| doc.dict(a)))
    };
    let mut acro = acro_existing.unwrap_or_default();
    let fields_existing = acro.get(b"Fields").map(|f| doc.resolve(f));
    let mut fields = fields_existing.as_deref().and_then(Object::as_array).cloned().unwrap_or_default();
    fields.push(Object::Ref(widget_ref));
    acro.set(b"Fields".to_vec(), Object::Array(fields));
    acro.set(b"SigFlags".to_vec(), Object::Int(3));

    let acro_ref_existing = {
        let r_obj = doc.get(root_ref);
        doc.dict(&r_obj).and_then(|r| r.reference(b"AcroForm"))
    };
    let perms_set = opts.certify.is_some();
    if let Some(ar) = acro_ref_existing {
        doc.set(ar, acro);
        if perms_set {
            doc.update_dict(root_ref, |r| {
                let mut perms = r.get(b"Perms").and_then(Object::as_dict).cloned().unwrap_or_default();
                perms.set(b"DocMDP".to_vec(), Object::Ref(sig_obj_ref));
                r.set(b"Perms".to_vec(), Object::Dict(perms));
            })?;
        }
    } else {
        let ar = doc.add(acro);
        doc.update_dict(root_ref, |r| {
            r.set(b"AcroForm".to_vec(), Object::Ref(ar));
            if perms_set {
                let mut perms = r.get(b"Perms").and_then(Object::as_dict).cloned().unwrap_or_default();
                perms.set(b"DocMDP".to_vec(), Object::Ref(sig_obj_ref));
                r.set(b"Perms".to_vec(), Object::Dict(perms));
            }
        })?;
    }

    let save_opts = SaveOptions { mod_date: opts.date.clone(), object_streams: false, ..Default::default() };
    let mut out = write_incremental(&doc, &save_opts)?;
    patch_signature_cms(&mut out, base_len, &id)?;
    Ok(out)
}

fn patch_signature_cms(out: &mut [u8], search_from: usize, id: &pkcs12::DigitalId) -> Result<(), FileError> {
    let tail_start = search_from.min(out.len());
    let br_rel = find_subslice(&out[tail_start..], BYTERANGE_SENTINEL)
        .ok_or_else(|| FileError::InvalidPdf("signature /ByteRange placeholder missing".into()))?;
    let br_pos = tail_start + br_rel;

    let zero_hex = vec![b'0'; SIG_PLACEHOLDER_BYTES * 2];
    let mut contents_needle = Vec::with_capacity(zero_hex.len() + 2);
    contents_needle.push(b'<');
    contents_needle.extend_from_slice(&zero_hex);
    contents_needle.push(b'>');
    let c_rel = find_subslice(&out[tail_start..], &contents_needle)
        .ok_or_else(|| FileError::InvalidPdf("signature /Contents placeholder missing".into()))?;
    let c_start = tail_start + c_rel;
    let c_end = c_start + contents_needle.len();

    let br_text = format!("[0 {c_start} {c_end} {}]", out.len() - c_end);
    if br_text.len() > BYTERANGE_SENTINEL.len() {
        return Err(FileError::InvalidInput("PDF too large for ByteRange placeholder".into()));
    }
    out[br_pos..br_pos + BYTERANGE_SENTINEL.len()].fill(b' ');
    out[br_pos..br_pos + br_text.len()].copy_from_slice(br_text.as_bytes());

    let digest = DigestAlg::Sha256.digest(&[&out[..c_start], &out[c_end..]]);
    let cms_der = cms::sign_detached(&id.key, &id.certificate, &id.chain, DigestAlg::Sha256, &digest)?;
    if cms_der.len() > SIG_PLACEHOLDER_BYTES {
        return Err(FileError::InvalidInput("CMS SignedData exceeds signature placeholder".into()));
    }

    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let hex_dst = &mut out[c_start + 1..c_end - 1];
    for (idx, b) in cms_der.into_iter().enumerate() {
        hex_dst[idx * 2] = HEX[usize::from(b >> 4)];
        hex_dst[idx * 2 + 1] = HEX[usize::from(b & 0x0F)];
    }
    Ok(())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn existing_sig_field_count(doc: &Document) -> usize {
    collect_sig_field_refs(doc).len()
}

fn collect_sig_field_refs(doc: &Document) -> Vec<ObjRef> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Some(root_ref) = doc.root() {
        let root_obj = doc.get(root_ref);
        if let Some(root) = doc.dict(&root_obj)
            && let Some(acro_obj) = root.get(b"AcroForm")
            && let Some(acro) = doc.dict(acro_obj)
            && let Some(fields_obj) = acro.get(b"Fields")
        {
            let resolved = doc.resolve(fields_obj);
            if let Some(arr) = resolved.as_array() {
                for item in arr {
                    if let Some(r) = item.as_ref() {
                        collect_sig_fields_recursive(doc, r, &mut seen, &mut out);
                    }
                }
            }
        }
    }

    if let Ok(pages) = collect_pages(doc) {
        for page in pages {
            let p_obj = doc.get(page.page_ref);
            if let Some(p_dict) = doc.dict(&p_obj)
                && let Some(annots_obj) = p_dict.get(b"Annots")
            {
                let resolved = doc.resolve(annots_obj);
                if let Some(arr) = resolved.as_array() {
                    for item in arr {
                        if let Some(r) = item.as_ref() {
                            collect_sig_fields_recursive(doc, r, &mut seen, &mut out);
                        }
                    }
                }
            }
        }
    }
    out
}

fn collect_sig_fields_recursive(doc: &Document, r: ObjRef, seen: &mut HashSet<ObjRef>, out: &mut Vec<ObjRef>) {
    if !seen.insert(r) {
        return;
    }
    let obj = doc.get(r);
    let Some(dict) = doc.dict(&obj) else {
        return;
    };
    if dict.name(b"FT") == Some(b"Sig") {
        out.push(r);
    }
    if let Some(kids_obj) = dict.get(b"Kids") {
        let resolved = doc.resolve(kids_obj);
        if let Some(kids) = resolved.as_array() {
            for kid in kids {
                if let Some(kr) = kid.as_ref() {
                    collect_sig_fields_recursive(doc, kr, seen, out);
                }
            }
        }
    }
}

pub fn verify_signatures(pdf: &[u8], trusted_certs_pem: &str) -> Result<Vec<VerifiedSignature>, FileError> {
    let trusted_certs = if trusted_certs_pem.trim().is_empty() {
        Vec::new()
    } else {
        x509::load_certificates(trusted_certs_pem.as_bytes())?
    };

    let doc = Document::open(Arc::new(pdf.to_vec()))?;
    let field_refs = collect_sig_field_refs(&doc);
    let mut results = Vec::with_capacity(field_refs.len());

    for fref in field_refs {
        let fobj = doc.get(fref);
        let Some(fdict) = doc.dict(&fobj) else {
            continue;
        };
        let field_name = fdict
            .get(b"T")
            .and_then(Object::as_string)
            .map(PdfString::to_text)
            .unwrap_or_else(|| format!("Signature{}", results.len() + 1));

        let Some(v_obj) = fdict.get(b"V") else {
            results.push(VerifiedSignature {
                field: field_name,
                signed: false,
                status: "unsigned".into(),
                signer: None,
                date: None,
                reason: None,
                location: None,
                format: None,
                algorithm: None,
                certification: None,
                timestamped: false,
                modifications: "none".into(),
                changes: Vec::new(),
                fingerprint: None,
                details: vec!["Signature field is unsigned".into()],
            });
            continue;
        };

        let Some(sig_dict) = doc.dict(v_obj) else {
            results.push(invalid_sig_entry(field_name, "Signature /V dictionary missing"));
            continue;
        };

        let reason = sig_dict.get(b"Reason").and_then(Object::as_string).map(PdfString::to_text);
        let location = sig_dict.get(b"Location").and_then(Object::as_string).map(PdfString::to_text);
        let format = sig_dict.name(b"SubFilter").map(|n| String::from_utf8_lossy(n).into_owned());
        let date_dict = sig_dict.get(b"M").and_then(Object::as_string).map(PdfString::to_text);
        let certification =
            sig_dict.get(b"Reference").and_then(|r| doc.resolve(r).as_array().cloned()).and_then(|arr| {
                arr.into_iter().find_map(|item| {
                    let rd = doc.dict(&item)?;
                    (rd.name(b"TransformMethod") == Some(b"DocMDP"))
                        .then(|| rd.get(b"TransformParams").and_then(|tp| doc.dict(tp))?.int(b"P"))
                        .flatten()
                        .and_then(|p| u8::try_from(p).ok())
                })
            });

        let Some(br_vals) = extract_byterange(&doc, &sig_dict) else {
            results.push(invalid_sig_entry(field_name, "Missing or malformed /ByteRange"));
            continue;
        };
        let [a, b, c, d] = br_vals;
        if a != 0 || b > c || c.saturating_add(d) > pdf.len() {
            results.push(invalid_sig_entry(field_name, "/ByteRange exceeds document bounds"));
            continue;
        }

        let Some(raw_cms) = sig_dict.get(b"Contents").and_then(Object::as_string).map(|s| s.bytes.as_slice()) else {
            results.push(invalid_sig_entry(field_name, "Missing signature /Contents"));
            continue;
        };

        let mut details = Vec::new();
        let mut changes = Vec::new();
        let covered_end = c + d;
        let modifications = if covered_end == pdf.len() {
            "none".to_owned()
        } else {
            changes.push(format!("{} byte(s) appended after signed revision", pdf.len() - covered_end));
            "forbidden".to_owned()
        };

        let parsed = match cms::SignedData::parse(raw_cms) {
            Ok(sd) => sd,
            Err(e) => {
                results.push(invalid_sig_entry(field_name, format!("Invalid CMS SignedData: {e}")));
                continue;
            }
        };

        let content_digest = parsed.signer.digest.digest(&[&pdf[a..b], &pdf[c..covered_end]]);
        let md_ok = match &parsed.signer.message_digest {
            Some(md) => md.as_slice() == content_digest.as_slice(),
            None => parsed.signer.signed_attrs.is_none(),
        };

        let mut pool = parsed.certificates.clone();
        pool.extend(trusted_certs.iter().cloned());
        let cert_opt = parsed.signer_certificate().or_else(|| trusted_certs.first());

        let (crypto_ok, signer_name, fingerprint, trusted) = if let Some(cert) = cert_opt {
            let sig_ok = parsed.verify_signature(cert, &content_digest).unwrap_or(false) && md_ok;
            let chain = x509::build_chain(cert, &pool, None);
            let is_trusted = !trusted_certs.is_empty()
                && chain
                    .iter()
                    .any(|c_in_chain| trusted_certs.iter().any(|t| t.fingerprint() == c_in_chain.fingerprint()));
            if !sig_ok {
                details.push("Digest or signature mismatch".into());
            } else if !is_trusted {
                details.push("Signer certificate not present in trusted PEM bundle".into());
            }
            (sig_ok, Some(cert.display_name()), Some(cert.fingerprint()), is_trusted)
        } else {
            details.push("No signer certificate embedded in CMS SignedData".into());
            (false, None, None, false)
        };

        let status = if !crypto_ok {
            "invalid"
        } else if trusted {
            "valid"
        } else {
            "unknown"
        };

        let date = parsed.signer.signing_time.map(|t| t.to_string()).or(date_dict);

        results.push(VerifiedSignature {
            field: field_name,
            signed: true,
            status: status.to_owned(),
            signer: signer_name,
            date,
            reason,
            location,
            format,
            algorithm: Some(format!("{} / {:?}", parsed.signer.digest.name(), parsed.signer.scheme)),
            certification,
            timestamped: parsed.signer.timestamp,
            modifications,
            changes,
            fingerprint,
            details,
        });
    }

    Ok(results)
}

fn extract_byterange(doc: &Document, sig_dict: &Dict) -> Option<[usize; 4]> {
    let br_obj = sig_dict.get(b"ByteRange")?;
    let resolved = doc.resolve(br_obj);
    let arr = resolved.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let a = usize::try_from(arr[0].as_int()?).ok()?;
    let b = usize::try_from(arr[1].as_int()?).ok()?;
    let c = usize::try_from(arr[2].as_int()?).ok()?;
    let d = usize::try_from(arr[3].as_int()?).ok()?;
    Some([a, b, c, d])
}

fn invalid_sig_entry(field: String, msg: impl Into<String>) -> VerifiedSignature {
    VerifiedSignature {
        field,
        signed: true,
        status: "invalid".into(),
        signer: None,
        date: None,
        reason: None,
        location: None,
        format: None,
        algorithm: None,
        certification: None,
        timestamped: false,
        modifications: "forbidden".into(),
        changes: Vec::new(),
        fingerprint: None,
        details: vec![msg.into()],
    }
}

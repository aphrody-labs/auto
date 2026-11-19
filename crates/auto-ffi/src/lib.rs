#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeMap;

use auto_auth::{
    jwt::{JwkSet, JwtClaims, derive_ed25519_keypair, jwk_from_verifying_key, sign_jwt, verify_jwt},
    passkey::{PasskeyAssertion, verify_passkey_assertion},
    password::{hash_password_argon2id_with_salt, hash_password_scrypt_compat, verify_password},
    rbac::{Action, Role, can_perform, generate_api_key_with_entropy},
    session::{open_sealed, seal_with_nonce, sign_hmac_token, verify_hmac_token},
    totp::{TotpAlgorithm, decode_base32, otpauth_uri, totp, verify_totp},
};
use auto_files::{
    NewPresentation, RedactionOptions, SignatureOptions, SimpleDocx, TextReplacement, create_docx, create_pptx,
    docx_text, docx_to_pdf, extract_pdf_pages, fill_template_docx, merge_pdfs, pdf_page_count, pdf_text, pptx_text,
    pptx_to_pdf, read_docx, redact_pdf, replace_docx, sign_pdf, template_fields_docx, verify_signatures,
};
use auto_knowledge::{chunk_text, nearest_vectors};
use auto_model::Document;
use auto_sheets::{CellEdit, Workbook, modify_xlsx, read as read_spreadsheet, write_xlsx};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPdfEnvelope {
    doc: Document,
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FacturxEnvelope {
    doc: Document,
    #[serde(default)]
    timestamp: Option<i64>,
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkRequest {
    source: String,
    text: String,
    #[serde(default)]
    chunk_size: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NearestRequest {
    dimension: usize,
    k: usize,
    #[serde(default)]
    diversity: Option<f64>,
}

fn frame_parts(parts: &[&[u8]]) -> Vec<u8> {
    let total: usize = parts.iter().map(|p| 4 + p.len()).sum();
    let mut out = Vec::with_capacity(total);
    for p in parts {
        out.extend_from_slice(&(p.len() as u32).to_le_bytes());
        out.extend_from_slice(p);
    }
    out
}

fn unframe_parts(bytes: &[u8]) -> Result<Vec<&[u8]>, String> {
    let mut parts = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let header = bytes.get(offset..offset + 4).ok_or_else(|| "truncated frame header".to_owned())?;
        let len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        offset += 4;
        let payload = bytes.get(offset..offset + len).ok_or_else(|| "truncated frame payload".to_owned())?;
        parts.push(payload);
        offset += len;
    }
    Ok(parts)
}

fn parse_doc_with_locale(input: &[u8]) -> Result<Document, String> {
    if let Ok(env) = serde_json::from_slice::<RenderPdfEnvelope>(input) {
        let mut doc = env.doc;
        if let Some(loc) = env.locale {
            doc.locale = Some(loc);
        }
        return Ok(doc);
    }
    serde_json::from_slice::<Document>(input).map_err(|e| format!("invalid document JSON: {e}"))
}

fn f32_le_vec(bytes: &[u8], what: &str) -> Result<Vec<f32>, String> {
    if !bytes.len().is_multiple_of(4) {
        return Err(format!("{what} byte length must be a multiple of 4"));
    }
    Ok(bytes.as_chunks::<4>().0.iter().copied().map(f32::from_le_bytes).collect())
}

fn to_json_bytes<T: serde::Serialize>(val: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(val).map_err(|e| format!("JSON serialization error: {e}"))
}

pub fn dispatch(op: &str, input: &[u8]) -> Result<Vec<u8>, String> {
    match op {
        "render_pdf" => {
            let doc = parse_doc_with_locale(input)?;
            auto_docs::render(&doc).map_err(|e| e.to_string())
        }
        "facturx" => {
            let (mut doc, ts) = if input.first() == Some(&b'{')
                || input.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'{')
            {
                let env: FacturxEnvelope =
                    serde_json::from_slice(input).map_err(|e| format!("invalid facturx JSON: {e}"))?;
                let mut d = env.doc;
                if let Some(loc) = env.locale {
                    d.locale = Some(loc);
                }
                (d, env.timestamp.unwrap_or(0))
            } else {
                let ts_bytes = input.get(..8).ok_or_else(|| "missing 8-byte unix timestamp header".to_owned())?;
                let ts = i64::from_le_bytes([
                    ts_bytes[0],
                    ts_bytes[1],
                    ts_bytes[2],
                    ts_bytes[3],
                    ts_bytes[4],
                    ts_bytes[5],
                    ts_bytes[6],
                    ts_bytes[7],
                ]);
                let doc: Document =
                    serde_json::from_slice(&input[8..]).map_err(|e| format!("invalid document JSON: {e}"))?;
                (doc, ts)
            };
            let _ = &mut doc;
            let base_pdf = auto_docs::render(&doc).map_err(|e| e.to_string())?;
            auto_facturx::generate(&doc, &base_pdf, ts).map_err(|e| e.to_string())
        }
        "xml_cii" => {
            let doc = parse_doc_with_locale(input)?;
            auto_facturx::xml(&doc).map(String::into_bytes).map_err(|e| e.to_string())
        }
        "extract_xml" => {
            let opt = auto_facturx::extract_xml(input).map_err(|e| e.to_string())?;
            Ok(opt.unwrap_or_default().into_bytes())
        }
        "verify_pdfa" => {
            let errs = auto_facturx::verify_pdfa(input).map_err(|e| e.to_string())?;
            to_json_bytes(&errs)
        }
        "read_spreadsheet" => {
            let res = read_spreadsheet(input).map_err(|e| e.to_string())?;
            to_json_bytes(&res)
        }
        "write_xlsx" => {
            let book: Workbook = serde_json::from_slice(input).map_err(|e| format!("invalid workbook JSON: {e}"))?;
            write_xlsx(&book).map_err(|e| e.to_string())
        }
        "modify_xlsx" => {
            let parts = unframe_parts(input)?;
            let [edits_bytes, xlsx_bytes] = parts.as_slice() else {
                return Err("modify_xlsx expects [edits_json, xlsx_bytes]".into());
            };
            let edits: Vec<CellEdit> =
                serde_json::from_slice(edits_bytes).map_err(|e| format!("invalid edits JSON: {e}"))?;
            modify_xlsx(xlsx_bytes, &edits).map_err(|e| e.to_string())
        }
        "merge_pdfs" => {
            let parts = unframe_parts(input)?;
            if parts.is_empty() || !parts.len().is_multiple_of(2) {
                return Err("merge_pdfs expects [name, bytes]... pairs".into());
            }
            let mut pairs = Vec::with_capacity(parts.len() / 2);
            for [name_bytes, pdf_bytes] in parts.as_chunks::<2>().0 {
                let name = std::str::from_utf8(name_bytes).map_err(|_| "invalid UTF-8 PDF name".to_owned())?;
                pairs.push((name, *pdf_bytes));
            }
            merge_pdfs(&pairs).map_err(|e| e.to_string())
        }
        "extract_pdf_pages" => {
            let parts = unframe_parts(input)?;
            let [pages_bytes, pdf_bytes] = parts.as_slice() else {
                return Err("extract_pdf_pages expects [pages_json, pdf_bytes]".into());
            };
            let pages: Vec<usize> =
                serde_json::from_slice(pages_bytes).map_err(|e| format!("invalid page indices JSON: {e}"))?;
            extract_pdf_pages(pdf_bytes, &pages).map_err(|e| e.to_string())
        }
        "pdf_page_count" => {
            let count = pdf_page_count(input).map_err(|e| e.to_string())?;
            Ok(count.to_string().into_bytes())
        }
        "pdf_text" => {
            let pages = pdf_text(input).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "pages": pages }))
        }
        "create_docx" => {
            let doc: SimpleDocx = serde_json::from_slice(input).map_err(|e| format!("invalid SimpleDocx JSON: {e}"))?;
            create_docx(&doc).map_err(|e| e.to_string())
        }
        "read_docx" => {
            let paragraphs = read_docx(input).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "paragraphs": paragraphs }))
        }
        "template_fields_docx" => {
            let fields = template_fields_docx(input).map_err(|e| e.to_string())?;
            to_json_bytes(&fields)
        }
        "fill_template_docx" => {
            let parts = unframe_parts(input)?;
            let [values_bytes, docx_bytes] = parts.as_slice() else {
                return Err("fill_template_docx expects [values_json, docx_bytes]".into());
            };
            let values: BTreeMap<String, String> =
                serde_json::from_slice(values_bytes).map_err(|e| format!("invalid template values JSON: {e}"))?;
            fill_template_docx(docx_bytes, &values).map_err(|e| e.to_string())
        }
        "replace_docx" => {
            let parts = unframe_parts(input)?;
            let [rep_bytes, docx_bytes] = parts.as_slice() else {
                return Err("replace_docx expects [replacements_json, docx_bytes]".into());
            };
            let replacements: Vec<TextReplacement> =
                serde_json::from_slice(rep_bytes).map_err(|e| format!("invalid replacements JSON: {e}"))?;
            replace_docx(docx_bytes, &replacements).map_err(|e| e.to_string())
        }
        "docx_text" => docx_text(input).map(String::into_bytes).map_err(|e| e.to_string()),
        "docx_to_pdf" => docx_to_pdf(input).map_err(|e| e.to_string()),
        "redact_pdf" => {
            let parts = unframe_parts(input)?;
            let [opts_bytes, pdf_bytes] = parts.as_slice() else {
                return Err("redact_pdf expects [options_json, pdf_bytes]".into());
            };
            let opts: RedactionOptions =
                serde_json::from_slice(opts_bytes).map_err(|e| format!("invalid redaction options JSON: {e}"))?;
            let (out_pdf, report) = redact_pdf(pdf_bytes, &opts).map_err(|e| e.to_string())?;
            let report_json = to_json_bytes(&report)?;
            Ok(frame_parts(&[&report_json, &out_pdf]))
        }
        "sign_pdf" => {
            let parts = unframe_parts(input)?;
            let [opts_bytes, pkcs12_bytes, pdf_bytes] = parts.as_slice() else {
                return Err("sign_pdf expects [options_json, pkcs12_bytes, pdf_bytes]".into());
            };
            let opts: SignatureOptions =
                serde_json::from_slice(opts_bytes).map_err(|e| format!("invalid signature options JSON: {e}"))?;
            sign_pdf(pdf_bytes, pkcs12_bytes, &opts).map_err(|e| e.to_string())
        }
        "verify_signatures" => {
            let parts = unframe_parts(input)?;
            let [pem_bytes, pdf_bytes] = parts.as_slice() else {
                return Err("verify_signatures expects [pem_bytes, pdf_bytes]".into());
            };
            let pem = std::str::from_utf8(pem_bytes).map_err(|_| "invalid UTF-8 PEM bundle".to_owned())?;
            let sigs = verify_signatures(pdf_bytes, pem).map_err(|e| e.to_string())?;
            to_json_bytes(&sigs)
        }
        "create_pptx" => {
            let pres: NewPresentation =
                serde_json::from_slice(input).map_err(|e| format!("invalid presentation JSON: {e}"))?;
            create_pptx(&pres).map_err(|e| e.to_string())
        }
        "pptx_text" => {
            let slides = pptx_text(input).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "slides": slides }))
        }
        "pptx_to_pdf" => pptx_to_pdf(input).map_err(|e| e.to_string()),
        "chunk_text" => {
            let req: ChunkRequest =
                serde_json::from_slice(input).map_err(|e| format!("invalid chunk request JSON: {e}"))?;
            let chunks = chunk_text(&req.source, &req.text, req.chunk_size).map_err(|e| e.to_string())?;
            to_json_bytes(&chunks)
        }
        "nearest_vectors" => {
            let parts = unframe_parts(input)?;
            let [req_bytes, q_bytes, m_bytes] = parts.as_slice() else {
                return Err("nearest_vectors expects [options_json, query_f32, matrix_f32]".into());
            };
            let req: NearestRequest =
                serde_json::from_slice(req_bytes).map_err(|e| format!("invalid nearest_vectors JSON: {e}"))?;
            let query = f32_le_vec(q_bytes, "query")?;
            let matrix = f32_le_vec(m_bytes, "matrix")?;
            let hits =
                nearest_vectors(&query, &matrix, req.dimension, req.k, req.diversity).map_err(|e| e.to_string())?;
            to_json_bytes(&hits)
        }
        "auth_hash_password" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                password: String,
                salt_b64: String,
                #[serde(default)]
                mode: Option<String>,
            }
            use base64::{Engine as _, engine::general_purpose::STANDARD};
            let req: Req =
                serde_json::from_slice(input).map_err(|e| format!("invalid auth_hash_password JSON: {e}"))?;
            let salt = STANDARD.decode(&req.salt_b64).map_err(|e| format!("invalid saltB64: {e}"))?;
            let hash = if req.mode.as_deref() == Some("scrypt") {
                hash_password_scrypt_compat(&req.password, &salt).map_err(|e| e.to_string())?
            } else {
                hash_password_argon2id_with_salt(&req.password, &salt).map_err(|e| e.to_string())?
            };
            to_json_bytes(&serde_json::json!({ "hash": hash }))
        }
        "auth_verify_password" => {
            #[derive(Deserialize)]
            struct Req {
                password: String,
                hash: String,
            }
            let req: Req =
                serde_json::from_slice(input).map_err(|e| format!("invalid auth_verify_password JSON: {e}"))?;
            let valid = verify_password(&req.password, &req.hash).unwrap_or(false);
            to_json_bytes(&serde_json::json!({ "valid": valid }))
        }
        "auth_sign_jwt" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                #[serde(default)]
                key_label: Option<String>,
                claims: JwtClaims,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_sign_jwt JSON: {e}"))?;
            let (sk, kid) =
                derive_ed25519_keypair(&req.master_secret, req.key_label.as_deref().unwrap_or("jwt-default"));
            let token = sign_jwt(&sk, &kid, &req.claims).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "token": token, "kid": kid }))
        }
        "auth_verify_jwt" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                #[serde(default)]
                key_label: Option<String>,
                token: String,
                #[serde(default)]
                expected_issuer: Option<String>,
                #[serde(default)]
                expected_audience: Option<String>,
                now_unix_secs: i64,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_verify_jwt JSON: {e}"))?;
            let (sk, _) = derive_ed25519_keypair(&req.master_secret, req.key_label.as_deref().unwrap_or("jwt-default"));
            let claims = verify_jwt(
                &sk.verifying_key(),
                &req.token,
                req.expected_issuer.as_deref(),
                req.expected_audience.as_deref(),
                req.now_unix_secs,
            )
            .map_err(|e| e.to_string())?;
            to_json_bytes(&claims)
        }
        "auth_jwks" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                #[serde(default)]
                key_label: Option<String>,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_jwks JSON: {e}"))?;
            let (sk, kid) =
                derive_ed25519_keypair(&req.master_secret, req.key_label.as_deref().unwrap_or("jwt-default"));
            to_json_bytes(&JwkSet { keys: vec![jwk_from_verifying_key(&sk.verifying_key(), &kid)] })
        }
        "auth_seal_secret" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                purpose: String,
                plaintext_b64: String,
                nonce_b64: String,
            }
            use base64::{Engine as _, engine::general_purpose::STANDARD};
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_seal_secret JSON: {e}"))?;
            let pt = STANDARD.decode(&req.plaintext_b64).map_err(|e| format!("invalid plaintextB64: {e}"))?;
            let nonce = STANDARD.decode(&req.nonce_b64).map_err(|e| format!("invalid nonceB64: {e}"))?;
            let token = seal_with_nonce(&req.master_secret, &req.purpose, &pt, &nonce).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "token": token }))
        }
        "auth_open_secret" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                purpose: String,
                token: String,
            }
            use base64::{Engine as _, engine::general_purpose::STANDARD};
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_open_secret JSON: {e}"))?;
            let plain = open_sealed(&req.master_secret, &req.purpose, &req.token).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "plaintextB64": STANDARD.encode(&plain) }))
        }
        "auth_totp_code" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                secret_b32: String,
                unix_secs: u64,
                #[serde(default)]
                issuer: Option<String>,
                #[serde(default)]
                account: Option<String>,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_totp_code JSON: {e}"))?;
            let raw = decode_base32(&req.secret_b32).map_err(|e| e.to_string())?;
            let code = totp(&raw, req.unix_secs, 6, 30, TotpAlgorithm::Sha1).map_err(|e| e.to_string())?;
            let uri = otpauth_uri(
                req.issuer.as_deref().unwrap_or("Auto"),
                req.account.as_deref().unwrap_or("user"),
                &raw,
                TotpAlgorithm::Sha1,
            );
            to_json_bytes(&serde_json::json!({ "code": code, "uri": uri }))
        }
        "auth_totp_verify" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                secret_b32: String,
                code: String,
                unix_secs: u64,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_totp_verify JSON: {e}"))?;
            let raw = decode_base32(&req.secret_b32).map_err(|e| e.to_string())?;
            let valid = verify_totp(&raw, &req.code, req.unix_secs, 6, 30, 1, TotpAlgorithm::Sha1)
                .map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "valid": valid }))
        }
        "auth_sign_token" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                purpose: String,
                payload: serde_json::Value,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_sign_token JSON: {e}"))?;
            let token = sign_hmac_token(&req.master_secret, &req.purpose, &req.payload).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "token": token }))
        }
        "auth_verify_token" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                master_secret: String,
                purpose: String,
                token: String,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_verify_token JSON: {e}"))?;
            let payload: serde_json::Value =
                verify_hmac_token(&req.master_secret, &req.purpose, &req.token).map_err(|e| e.to_string())?;
            to_json_bytes(&payload)
        }
        "auth_generate_api_key" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                #[serde(default)]
                prefix: Option<String>,
                entropy_b64: String,
            }
            use base64::{Engine as _, engine::general_purpose::STANDARD};
            let req: Req =
                serde_json::from_slice(input).map_err(|e| format!("invalid auth_generate_api_key JSON: {e}"))?;
            let ent = STANDARD.decode(&req.entropy_b64).map_err(|e| format!("invalid entropyB64: {e}"))?;
            let generated = generate_api_key_with_entropy(req.prefix.as_deref().unwrap_or("auto_"), &ent)
                .map_err(|e| e.to_string())?;
            to_json_bytes(&generated)
        }
        "auth_verify_passkey" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Req {
                assertion: PasskeyAssertion,
                expected_challenge: String,
                expected_origin: String,
                expected_rp_id: String,
                #[serde(default)]
                min_sign_count: u32,
            }
            let req: Req =
                serde_json::from_slice(input).map_err(|e| format!("invalid auth_verify_passkey JSON: {e}"))?;
            let res = verify_passkey_assertion(
                &req.assertion,
                &req.expected_challenge,
                &req.expected_origin,
                &req.expected_rp_id,
                req.min_sign_count,
            )
            .map_err(|e| e.to_string())?;
            to_json_bytes(&res)
        }
        "auth_can_perform" => {
            #[derive(Deserialize)]
            struct Req {
                role: String,
                action: Action,
            }
            let req: Req = serde_json::from_slice(input).map_err(|e| format!("invalid auth_can_perform JSON: {e}"))?;
            let role = Role::parse(&req.role).map_err(|e| e.to_string())?;
            to_json_bytes(&serde_json::json!({ "allowed": can_perform(role, req.action) }))
        }
        other => Err(format!("unknown native operation: {other}")),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn call_wasm(op: &str, input: &[u8]) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    dispatch(op, input).map_err(|e| wasm_bindgen::JsValue::from_str(&e))
}

/// Executes a native operation across the C ABI (`[0|1 status, ...payload]`), returning a buffer to release with [`auto_free`].
///
/// # Safety
/// - `op_ptr` must be valid for `op_len` readable bytes (or null when `op_len == 0`).
/// - `in_ptr` must be valid for `in_len` readable bytes (or null when `in_len == 0`).
/// - `out_len` must be a non-null, aligned writable pointer.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn auto_call(
    op_ptr: *const u8,
    op_len: usize,
    in_ptr: *const u8,
    in_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let op_bytes = if op_ptr.is_null() { &[] } else { unsafe { std::slice::from_raw_parts(op_ptr, op_len) } };
    let input = if in_ptr.is_null() { &[] } else { unsafe { std::slice::from_raw_parts(in_ptr, in_len) } };
    let result = match std::str::from_utf8(op_bytes) {
        Ok(op) => dispatch(op, input),
        Err(_) => Err("operation name is not valid UTF-8".to_owned()),
    };
    let mut framed = match result {
        Ok(payload) => {
            let mut v = Vec::with_capacity(1 + payload.len());
            v.push(0);
            v.extend_from_slice(&payload);
            v
        }
        Err(msg) => {
            let bytes = msg.into_bytes();
            let mut v = Vec::with_capacity(1 + bytes.len());
            v.push(1);
            v.extend_from_slice(&bytes);
            v
        }
    };
    let len = framed.len();
    let ptr = framed.as_mut_ptr();
    std::mem::forget(framed);
    unsafe {
        *out_len = len;
    }
    ptr
}

/// Frees a response buffer allocated by [`auto_call`].
///
/// # Safety
/// `ptr` and `len` must originate from a prior [`auto_call`] invocation and must not have been freed already.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn auto_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, len, len);
        }
    }
}

/// Returns a static NUL-terminated library version string matching `include/auto.h`.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn auto_version() -> *const std::ffi::c_char {
    c"0.2.0".as_ptr()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_smoke_roundtrips_all_core_ops() {
        let pdf = dispatch(
            "render_pdf",
            br#"{"number":"INV-2026-0001","type":"invoice","date":"2026-10-22","issuer":{"name":"Alpha","address":"Paris"},"customer":{"name":"Beta","address":"Lyon"},"lines":[{"description":"Audit","quantity":1,"unitPriceExclVatCents":50000,"vat":200}]}"#,
        )
        .expect("render_pdf");
        assert!(pdf.starts_with(b"%PDF-"));
        assert_eq!(dispatch("pdf_page_count", &pdf).expect("count"), b"1");

        let fx = dispatch(
            "facturx",
            br#"{"doc":{"number":"INV-2026-0001","type":"invoice","date":"2026-10-22","issuer":{"name":"Alpha","address":"Paris"},"customer":{"name":"Beta","address":"Lyon"},"lines":[{"description":"Audit","quantity":1,"unitPriceExclVatCents":50000,"vat":200}]},"timestamp":1792663200}"#,
        )
        .expect("facturx");
        let xml = dispatch("extract_xml", &fx).expect("extract_xml");
        assert!(String::from_utf8_lossy(&xml).contains("<ram:GrandTotalAmount>600.00</ram:GrandTotalAmount>"));
        let pdfa_errs = dispatch("verify_pdfa", &fx).expect("verify_pdfa");
        assert_eq!(pdfa_errs, b"[]");

        let err = dispatch("unknown_op", b"").expect_err("unknown op fails");
        assert!(err.contains("unknown native operation"));
    }
}

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod jwt;
pub mod oauth;
pub mod passkey;
pub mod password;
pub mod rbac;
pub mod session;
pub mod totp;

#[cfg(feature = "native")]
pub mod server;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("authentication failed: {0}")]
    Unauthorized(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("storage error: {0}")]
    Storage(String),
}

pub type AuthResult<T> = Result<T, AuthError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub app_name: String,
    pub base_url: String,
    pub base_path: String,
    pub master_secret: String,
    pub trusted_origins: Vec<String>,
    pub session_ttl_secs: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            app_name: "Auto".into(),
            base_url: "http://localhost:3000".into(),
            base_path: "/api/auth".into(),
            master_secret: String::new(),
            trusted_origins: vec!["http://localhost:*".into(), "http://127.0.0.1:*".into()],
            session_ttl_secs: 60 * 60 * 24 * 7,
        }
    }
}

pub fn normalize_email(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

pub fn valid_email(raw: &str) -> bool {
    let e = normalize_email(raw);
    if e.len() < 5 || e.len() > 254 || e.contains(char::is_whitespace) {
        return false;
    }
    match e.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        }
        None => false,
    }
}

#[cfg(feature = "native")]
pub fn random_bytes(len: usize) -> AuthResult<Vec<u8>> {
    let mut out = vec![0u8; len];
    getrandom::fill(&mut out).map_err(|e| AuthError::Crypto(format!("csprng failed: {e}")))?;
    Ok(out)
}

#[cfg(feature = "native")]
pub fn random_hex(bytes_len: usize) -> AuthResult<String> {
    let raw = random_bytes(bytes_len)?;
    Ok(hex_encode(&raw))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn hex_decode(hex: &str) -> AuthResult<Vec<u8>> {
    let t = hex.trim();
    if !t.len().is_multiple_of(2) {
        return Err(AuthError::Crypto("odd hex length".into()));
    }
    let mut out = Vec::with_capacity(t.len() / 2);
    let (chunks, _) = t.as_bytes().as_chunks::<2>();
    for chunk in chunks {
        let pair = std::str::from_utf8(chunk).map_err(|_| AuthError::Crypto("invalid utf-8 in hex".into()))?;
        let byte = u8::from_str_radix(pair, 16).map_err(|_| AuthError::Crypto("invalid hex byte".into()))?;
        out.push(byte);
    }
    Ok(out)
}

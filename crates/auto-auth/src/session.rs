// Stateless HMAC-SHA256 signed session tokens, ChaCha20-Poly1305 encrypted vaults/cookies,
// domain-separated SHA-256 key derivation, and Origin/CSRF validation.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use hmac::{Hmac, Mac};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{AuthError, AuthResult};

type HmacSha256 = Hmac<Sha256>;

/// Derive a 32-byte key from `master_secret` bound to `domain_purpose`.
pub fn derive_key(master_secret: &str, domain_purpose: &str) -> AuthResult<[u8; 32]> {
    if master_secret.len() < 16 {
        return Err(AuthError::Crypto("master secret must be at least 16 characters".into()));
    }
    let mut mac = HmacSha256::new_from_slice(master_secret.as_bytes()).map_err(|e| AuthError::Crypto(e.to_string()))?;
    mac.update(domain_purpose.as_bytes());
    let out = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    Ok(key)
}

/// Encrypt binary or UTF-8 secrets with ChaCha20-Poly1305 + domain-separated AAD and 12-byte nonce.
pub fn seal_with_nonce(
    master_secret: &str,
    domain_purpose: &str,
    plaintext: &[u8],
    nonce12: &[u8],
) -> AuthResult<String> {
    if nonce12.len() != 12 {
        return Err(AuthError::Crypto("ChaCha20-Poly1305 requires a 12-byte nonce".into()));
    }
    let key = derive_key(master_secret, domain_purpose)?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let nonce = Nonce::try_from(nonce12).map_err(|_| AuthError::Crypto("invalid nonce".into()))?;
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad: domain_purpose.as_bytes() })
        .map_err(|_| AuthError::Crypto("encryption failed".into()))?;
    Ok(format!("v2:{}:{}", URL_SAFE_NO_PAD.encode(nonce12), URL_SAFE_NO_PAD.encode(ciphertext)))
}

#[cfg(feature = "native")]
pub fn seal(master_secret: &str, domain_purpose: &str, plaintext: &[u8]) -> AuthResult<String> {
    let nonce = crate::random_bytes(12)?;
    seal_with_nonce(master_secret, domain_purpose, plaintext, &nonce)
}

pub fn open_sealed(master_secret: &str, domain_purpose: &str, token: &str) -> AuthResult<Vec<u8>> {
    let rest = token.strip_prefix("v2:").ok_or_else(|| AuthError::Crypto("unsupported sealed token prefix".into()))?;
    let (nonce_b64, ct_b64) = rest.split_once(':').ok_or_else(|| AuthError::Crypto("malformed sealed token".into()))?;
    let nonce_bytes = URL_SAFE_NO_PAD.decode(nonce_b64).map_err(|e| AuthError::Crypto(e.to_string()))?;
    if nonce_bytes.len() != 12 {
        return Err(AuthError::Crypto("invalid sealed nonce length".into()));
    }
    let ciphertext = URL_SAFE_NO_PAD.decode(ct_b64).map_err(|e| AuthError::Crypto(e.to_string()))?;
    let key = derive_key(master_secret, domain_purpose)?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let nonce = Nonce::try_from(nonce_bytes.as_slice()).map_err(|_| AuthError::Crypto("invalid nonce".into()))?;
    cipher
        .decrypt(&nonce, Payload { msg: &ciphertext, aad: domain_purpose.as_bytes() })
        .map_err(|_| AuthError::Unauthorized("invalid ciphertext or authentication tag".into()))
}

/// Sign any serializable struct into a compact `base64url(json).base64url(hmac_sha256)` bearer/cookie token.
pub fn sign_hmac_token<T: Serialize>(master_secret: &str, purpose: &str, payload: &T) -> AuthResult<String> {
    let key = derive_key(master_secret, purpose)?;
    let json = serde_json::to_vec(payload).map_err(|e| AuthError::Crypto(e.to_string()))?;
    let body = URL_SAFE_NO_PAD.encode(&json);
    let mut mac = HmacSha256::new_from_slice(&key).map_err(|e| AuthError::Crypto(e.to_string()))?;
    mac.update(body.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{body}.{sig}"))
}

pub fn verify_hmac_token<T: DeserializeOwned>(master_secret: &str, purpose: &str, token: &str) -> AuthResult<T> {
    let (body, sig_b64) =
        token.split_once('.').ok_or_else(|| AuthError::Unauthorized("malformed signed token".into()))?;
    let key = derive_key(master_secret, purpose)?;
    let mut mac = HmacSha256::new_from_slice(&key).map_err(|e| AuthError::Crypto(e.to_string()))?;
    mac.update(body.as_bytes());
    let expected = mac.finalize().into_bytes();
    let provided = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| AuthError::Unauthorized("invalid token signature encoding".into()))?;
    if !bool::from(expected.as_slice().ct_eq(&provided)) {
        return Err(AuthError::Unauthorized("invalid token signature".into()));
    }
    let raw =
        URL_SAFE_NO_PAD.decode(body).map_err(|_| AuthError::Unauthorized("invalid token payload encoding".into()))?;
    serde_json::from_slice(&raw).map_err(|e| AuthError::Unauthorized(format!("invalid token json: {e}")))
}

pub fn sha256_b64u(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(input))
}

/// Constant-time origin matcher supporting exact origins and `:*` port wildcards (e.g. `http://localhost:*`).
pub fn is_trusted_origin(origin: &str, trusted_patterns: &[String]) -> bool {
    let clean = origin.trim().trim_end_matches('/');
    for pat in trusted_patterns {
        let p = pat.trim().trim_end_matches('/');
        if p == clean {
            return true;
        }
        if let Some(prefix) = p.strip_suffix(":*")
            && let Some(rest) = clean.strip_prefix(prefix)
        {
            return rest.is_empty() || (rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit()));
        }
    }
    false
}

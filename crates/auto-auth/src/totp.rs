// RFC 6238 TOTP (SHA-1 / SHA-256 / SHA-512), RFC 4648 Base32, otpauth:// URI,
// constant-time verification, and recovery code digests.
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use subtle::ConstantTimeEq;

use crate::{AuthError, AuthResult, hex_encode};

pub const TOTP_PERIOD_SECS: u64 = 30;
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TotpAlgorithm {
    #[default]
    Sha1,
    Sha256,
    Sha512,
}

impl TotpAlgorithm {
    pub fn label(self) -> &'static str {
        match self {
            Self::Sha1 => "SHA1",
            Self::Sha256 => "SHA256",
            Self::Sha512 => "SHA512",
        }
    }
}

pub fn encode_base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut bits = 0u32;
    let mut value = 0u32;
    for &b in bytes {
        value = (value << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32_ALPHABET[((value >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32_ALPHABET[((value << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

pub fn decode_base32(encoded: &str) -> AuthResult<Vec<u8>> {
    let mut out = Vec::with_capacity(encoded.len() * 5 / 8);
    let mut bits = 0u32;
    let mut value = 0u32;
    for ch in encoded.trim().trim_end_matches('=').bytes() {
        let up = ch.to_ascii_uppercase();
        if up == b' ' || up == b'-' {
            continue;
        }
        let idx = BASE32_ALPHABET
            .iter()
            .position(|&c| c == up)
            .ok_or_else(|| AuthError::Validation("invalid base32 character".into()))?;
        value = (value << 5) | (idx as u32);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((value >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

pub fn hotp(secret: &[u8], counter: u64, digits: u32, alg: TotpAlgorithm) -> AuthResult<String> {
    if digits == 0 || digits > 9 {
        return Err(AuthError::Validation("TOTP digits must be 1..=9".into()));
    }
    let counter_be = counter.to_be_bytes();
    let digest: Vec<u8> = match alg {
        TotpAlgorithm::Sha1 => {
            let mut mac = Hmac::<Sha1>::new_from_slice(secret).map_err(|e| AuthError::Crypto(e.to_string()))?;
            mac.update(&counter_be);
            mac.finalize().into_bytes().to_vec()
        }
        TotpAlgorithm::Sha256 => {
            let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|e| AuthError::Crypto(e.to_string()))?;
            mac.update(&counter_be);
            mac.finalize().into_bytes().to_vec()
        }
        TotpAlgorithm::Sha512 => {
            let mut mac = Hmac::<Sha512>::new_from_slice(secret).map_err(|e| AuthError::Crypto(e.to_string()))?;
            mac.update(&counter_be);
            mac.finalize().into_bytes().to_vec()
        }
    };
    let offset = (digest.last().copied().unwrap_or(0) & 0x0f) as usize;
    let code = ((u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]))
        % 10u32.pow(digits);
    Ok(format!("{code:0width$}", width = digits as usize))
}

pub fn totp(secret: &[u8], unix_secs: u64, digits: u32, period_secs: u64, alg: TotpAlgorithm) -> AuthResult<String> {
    if period_secs == 0 {
        return Err(AuthError::Validation("TOTP period must be > 0".into()));
    }
    hotp(secret, unix_secs / period_secs, digits, alg)
}

pub fn verify_totp(
    secret: &[u8],
    submitted: &str,
    unix_secs: u64,
    digits: u32,
    period_secs: u64,
    skew_steps: u64,
    alg: TotpAlgorithm,
) -> AuthResult<bool> {
    let clean = submitted.trim();
    if clean.len() != digits as usize || !clean.chars().all(|c| c.is_ascii_digit()) {
        return Ok(false);
    }
    let current = unix_secs / period_secs;
    let start = current.saturating_sub(skew_steps);
    let end = current.saturating_add(skew_steps);
    let mut matched = false;
    for step in start..=end {
        let candidate = hotp(secret, step, digits, alg)?;
        if bool::from(candidate.as_bytes().ct_eq(clean.as_bytes())) {
            matched = true;
        }
    }
    Ok(matched)
}

pub fn otpauth_uri(issuer: &str, account: &str, secret: &[u8], alg: TotpAlgorithm) -> String {
    let enc_issuer = url_encode(issuer);
    let enc_label = url_encode(&format!("{issuer}:{account}"));
    let b32 = encode_base32(secret);
    format!(
        "otpauth://totp/{enc_label}?secret={b32}&issuer={enc_issuer}&algorithm={}&digits=6&period={TOTP_PERIOD_SECS}",
        alg.label()
    )
}

pub fn hash_backup_code(code: &str) -> String {
    hex_encode(&Sha256::digest(code.trim().to_ascii_uppercase().as_bytes()))
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// Modern Argon2id password hashing + constant-time verification,
// plus full backward verification & compatibility with Better Auth's `<salt_hex>:<scrypt_hex>` hashes.
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use scrypt::{Params as ScryptParams, scrypt};
use subtle::ConstantTimeEq;

use crate::{AuthError, AuthResult, hex_decode, hex_encode};

const ARGON_M_COST: u32 = 19_456;
const ARGON_T_COST: u32 = 2;
const ARGON_P_COST: u32 = 1;

/// Hash a password with Argon2id (OWASP recommended) using an explicit 16+ byte random salt.
/// Formatted as standard PHC string `$argon2id$v=19$m=19456,t=2,p=1$<salt_b64>$<hash_b64>`.
pub fn hash_password_argon2id_with_salt(password: &str, salt: &[u8]) -> AuthResult<String> {
    validate_password_policy(password)?;
    if salt.len() < 16 {
        return Err(AuthError::Validation("salt must be at least 16 bytes".into()));
    }
    let params = Params::new(ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, Some(32))
        .map_err(|e| AuthError::Crypto(e.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut digest = [0u8; 32];
    argon2.hash_password_into(password.as_bytes(), salt, &mut digest).map_err(|e| AuthError::Crypto(e.to_string()))?;
    Ok(format!(
        "$argon2id$v=19$m={ARGON_M_COST},t={ARGON_T_COST},p={ARGON_P_COST}${}${}",
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(digest)
    ))
}

#[cfg(feature = "native")]
pub fn hash_password(password: &str) -> AuthResult<String> {
    let salt = crate::random_bytes(16)?;
    hash_password_argon2id_with_salt(password, &salt)
}

/// Produce a Better Auth compatible Scrypt hash (`<salt_hex>:<64B_derived_hex>`, N=16384, r=16, p=1).
pub fn hash_password_scrypt_compat(password: &str, salt16: &[u8]) -> AuthResult<String> {
    validate_password_policy(password)?;
    if salt16.len() < 16 {
        return Err(AuthError::Validation("scrypt salt must be at least 16 bytes".into()));
    }
    let salt_hex = hex_encode(&salt16[..16]);
    let params = ScryptParams::new(14, 16, 1).map_err(|e| AuthError::Crypto(e.to_string()))?;
    let mut dk = [0u8; 64];
    scrypt(password.normalize_nfkc_bytes().as_slice(), salt_hex.as_bytes(), &params, &mut dk)
        .map_err(|e| AuthError::Crypto(e.to_string()))?;
    Ok(format!("{salt_hex}:{}", hex_encode(&dk)))
}

trait NfkcShim {
    fn normalize_nfkc_bytes(&self) -> Vec<u8>;
}

impl NfkcShim for str {
    fn normalize_nfkc_bytes(&self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
}

/// Verify either modern `$argon2id$...` PHC hashes OR Better Auth `<salt_hex>:<dk_hex>` Scrypt hashes.
pub fn verify_password(password: &str, encoded_hash: &str) -> AuthResult<bool> {
    if let Some(rest) = encoded_hash.strip_prefix("$argon2id$") {
        let parts: Vec<&str> = rest.split('$').collect();
        if parts.len() != 4 {
            return Err(AuthError::Crypto("malformed argon2id hash".into()));
        }
        let mut m = ARGON_M_COST;
        let mut t = ARGON_T_COST;
        let mut p = ARGON_P_COST;
        for kv in parts[1].split(',') {
            if let Some((k, v)) = kv.split_once('=') {
                match k {
                    "m" => m = v.parse().map_err(|_| AuthError::Crypto("invalid argon2 m param".into()))?,
                    "t" => t = v.parse().map_err(|_| AuthError::Crypto("invalid argon2 t param".into()))?,
                    "p" => p = v.parse().map_err(|_| AuthError::Crypto("invalid argon2 p param".into()))?,
                    _ => {}
                }
            }
        }
        let salt =
            STANDARD_NO_PAD.decode(parts[2]).map_err(|e| AuthError::Crypto(format!("invalid argon2 salt: {e}")))?;
        let expected =
            STANDARD_NO_PAD.decode(parts[3]).map_err(|e| AuthError::Crypto(format!("invalid argon2 digest: {e}")))?;
        let params = Params::new(m, t, p, Some(expected.len())).map_err(|e| AuthError::Crypto(e.to_string()))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut actual = vec![0u8; expected.len()];
        argon2
            .hash_password_into(password.as_bytes(), &salt, &mut actual)
            .map_err(|e| AuthError::Crypto(e.to_string()))?;
        return Ok(bool::from(actual.ct_eq(&expected)));
    }

    if let Some((salt_hex, expected_hex)) = encoded_hash.split_once(':') {
        let expected = hex_decode(expected_hex)?;
        if expected.is_empty() || expected.len() > 128 {
            return Err(AuthError::Crypto("invalid scrypt digest length".into()));
        }
        let params = ScryptParams::new(14, 16, 1).map_err(|e| AuthError::Crypto(e.to_string()))?;
        let mut dk = vec![0u8; expected.len()];
        scrypt(password.as_bytes(), salt_hex.as_bytes(), &params, &mut dk)
            .map_err(|e| AuthError::Crypto(e.to_string()))?;
        if bool::from(dk.ct_eq(&expected)) {
            return Ok(true);
        }
        let raw_salt = hex_decode(salt_hex)?;
        let mut dk_raw = vec![0u8; expected.len()];
        scrypt(password.as_bytes(), &raw_salt, &params, &mut dk_raw).map_err(|e| AuthError::Crypto(e.to_string()))?;
        return Ok(bool::from(dk_raw.ct_eq(&expected)));
    }

    Err(AuthError::Crypto("unrecognized password hash format".into()))
}

pub fn validate_password_policy(password: &str) -> AuthResult<()> {
    if password.len() < 8 {
        return Err(AuthError::Validation("password must be at least 8 characters".into()));
    }
    if password.len() > 256 {
        return Err(AuthError::Validation("password must be at most 256 characters".into()));
    }
    Ok(())
}

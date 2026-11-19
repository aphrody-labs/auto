// Multi-tenant RBAC (owner, admin, accountant, hr, readonly), workspace segments,
// and Better Auth compatible `auto_` API keys with constant-time SHA-256 digest matching.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{AuthError, AuthResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Admin,
    Accountant,
    Hr,
    Readonly,
}

impl Role {
    pub fn parse(raw: &str) -> AuthResult<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "owner" => Ok(Self::Owner),
            "admin" => Ok(Self::Admin),
            "accountant" | "comptable" => Ok(Self::Accountant),
            "hr" | "rh" => Ok(Self::Hr),
            "readonly" | "lecture" => Ok(Self::Readonly),
            other => Err(AuthError::Validation(format!("unknown role: {other}"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Accountant => "accountant",
            Self::Hr => "hr",
            Self::Readonly => "readonly",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Read,
    Write,
    Delete,
    Issue,
    Hr,
    Settings,
    Billing,
    Operator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Segment {
    Customers,
    Suppliers,
    Projects,
    Deliveries,
    Orders,
}

pub fn can_perform(role: Role, action: Action) -> bool {
    match role {
        Role::Owner => true,
        Role::Admin => !matches!(action, Action::Operator),
        Role::Accountant => matches!(action, Action::Read | Action::Write | Action::Issue),
        Role::Hr => matches!(action, Action::Read | Action::Hr),
        Role::Readonly => matches!(action, Action::Read),
    }
}

pub fn segment_allows_path(segments: Option<&[Segment]>, path: &str, method: &str) -> bool {
    let Some(segs) = segments else {
        return true;
    };
    if segs.is_empty() {
        return true;
    }
    let clean = path.to_ascii_lowercase();
    if method.eq_ignore_ascii_case("GET")
        && (clean == "/v1/me" || clean == "/health" || clean.starts_with("/v1/search"))
    {
        return true;
    }
    if clean.starts_with("/v1/customers") || clean.starts_with("/v1/documents") || clean.starts_with("/v1/products") {
        return segs.contains(&Segment::Customers) || segs.contains(&Segment::Orders);
    }
    if clean.starts_with("/v1/suppliers") || clean.starts_with("/v1/inbox") {
        return segs.contains(&Segment::Suppliers);
    }
    if clean.starts_with("/v1/projects") {
        return segs.contains(&Segment::Projects);
    }
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedApiKey {
    pub raw_key: String,
    pub start: String,
    pub prefix: String,
    pub sha256_b64u: String,
}

pub fn generate_api_key_with_entropy(prefix: &str, entropy24: &[u8]) -> AuthResult<GeneratedApiKey> {
    if entropy24.len() < 24 {
        return Err(AuthError::Crypto("API key entropy must be at least 24 bytes".into()));
    }
    let clean_prefix = if prefix.is_empty() { "auto_" } else { prefix };
    let secret_part = URL_SAFE_NO_PAD.encode(&entropy24[..24]);
    let raw_key = format!("{clean_prefix}{secret_part}");
    let start_len = raw_key.len().min(clean_prefix.len() + 6);
    let sha256_b64u = URL_SAFE_NO_PAD.encode(Sha256::digest(raw_key.as_bytes()));
    Ok(GeneratedApiKey {
        start: raw_key[..start_len].to_string(),
        prefix: clean_prefix.to_string(),
        raw_key,
        sha256_b64u,
    })
}

#[cfg(feature = "native")]
pub fn generate_api_key(prefix: &str) -> AuthResult<GeneratedApiKey> {
    let entropy = crate::random_bytes(24)?;
    generate_api_key_with_entropy(prefix, &entropy)
}

pub fn verify_api_key_digest(raw_key: &str, expected_sha256_b64u: &str) -> bool {
    let actual = URL_SAFE_NO_PAD.encode(Sha256::digest(raw_key.as_bytes()));
    bool::from(actual.as_bytes().ct_eq(expected_sha256_b64u.as_bytes()))
}

// Modern EdDSA (Ed25519) JWT signing, verification, RFC 7517 JWKS export,
// and OpenID / MCP OAuth 2.1 `.well-known` discovery metadata.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{AuthError, AuthResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtHeader {
    pub alg: String,
    pub typ: String,
    pub kid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub iat: i64,
    pub exp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwkOkp {
    pub kty: String,
    pub crv: String,
    pub alg: String,
    #[serde(rename = "use")]
    pub key_use: String,
    pub kid: String,
    pub x: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwkSet {
    pub keys: Vec<JwkOkp>,
}

/// Deterministically derive a stable Ed25519 keypair from a master seed/secret + key index or purpose.
pub fn derive_ed25519_keypair(seed_secret: &str, key_label: &str) -> (SigningKey, String) {
    let mut hasher = Sha256::new();
    hasher.update(b"auto-auth:ed25519:v1:");
    hasher.update(key_label.as_bytes());
    hasher.update(b":");
    hasher.update(seed_secret.as_bytes());
    let digest = hasher.finalize();
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&digest);
    let signing = SigningKey::from_bytes(&seed);
    let pub_hash = Sha256::digest(signing.verifying_key().as_bytes());
    let kid = URL_SAFE_NO_PAD.encode(&pub_hash[..12]);
    (signing, kid)
}

pub fn jwk_from_verifying_key(key: &VerifyingKey, kid: &str) -> JwkOkp {
    JwkOkp {
        kty: "OKP".into(),
        crv: "Ed25519".into(),
        alg: "EdDSA".into(),
        key_use: "sig".into(),
        kid: kid.to_string(),
        x: URL_SAFE_NO_PAD.encode(key.as_bytes()),
    }
}

pub fn sign_jwt(signing: &SigningKey, kid: &str, claims: &JwtClaims) -> AuthResult<String> {
    let header = JwtHeader { alg: "EdDSA".into(), typ: "JWT".into(), kid: kid.to_string() };
    let h_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|e| AuthError::Crypto(e.to_string()))?);
    let c_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).map_err(|e| AuthError::Crypto(e.to_string()))?);
    let signing_input = format!("{h_b64}.{c_b64}");
    let sig: Signature = signing.sign(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes())))
}

pub fn verify_jwt(
    verifying: &VerifyingKey,
    token: &str,
    expected_issuer: Option<&str>,
    expected_audience: Option<&str>,
    now_unix_secs: i64,
) -> AuthResult<JwtClaims> {
    let mut parts = token.split('.');
    let (Some(h_b64), Some(c_b64), Some(s_b64), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(AuthError::Unauthorized("malformed JWT segment count".into()));
    };
    let h_raw = URL_SAFE_NO_PAD.decode(h_b64).map_err(|_| AuthError::Unauthorized("invalid JWT header".into()))?;
    let header: JwtHeader =
        serde_json::from_slice(&h_raw).map_err(|_| AuthError::Unauthorized("invalid JWT header json".into()))?;
    if header.alg != "EdDSA" {
        return Err(AuthError::Unauthorized("unsupported JWT algorithm; expected EdDSA".into()));
    }
    let sig_raw =
        URL_SAFE_NO_PAD.decode(s_b64).map_err(|_| AuthError::Unauthorized("invalid JWT signature encoding".into()))?;
    let sig_arr: [u8; 64] =
        sig_raw.try_into().map_err(|_| AuthError::Unauthorized("invalid Ed25519 signature length".into()))?;
    let sig = Signature::from_bytes(&sig_arr);
    let signing_input = format!("{h_b64}.{c_b64}");
    verifying
        .verify(signing_input.as_bytes(), &sig)
        .map_err(|_| AuthError::Unauthorized("JWT signature verification failed".into()))?;

    let c_raw =
        URL_SAFE_NO_PAD.decode(c_b64).map_err(|_| AuthError::Unauthorized("invalid JWT claims encoding".into()))?;
    let claims: JwtClaims =
        serde_json::from_slice(&c_raw).map_err(|_| AuthError::Unauthorized("invalid JWT claims json".into()))?;
    if claims.exp <= now_unix_secs {
        return Err(AuthError::Unauthorized("JWT token expired".into()));
    }
    if let Some(iss) = expected_issuer
        && claims.iss != iss
    {
        return Err(AuthError::Unauthorized("JWT issuer mismatch".into()));
    }
    if let Some(aud) = expected_audience
        && claims.aud != aud
    {
        return Err(AuthError::Unauthorized("JWT audience mismatch".into()));
    }
    Ok(claims)
}

pub fn oauth_authorization_server_metadata(base_url: &str, base_path: &str) -> serde_json::Value {
    let origin = base_url.trim_end_matches('/');
    let prefix = format!("{origin}{}", base_path.trim_end_matches('/'));
    serde_json::json!({
        "issuer": origin,
        "authorization_endpoint": format!("{prefix}/oauth2/authorize"),
        "token_endpoint": format!("{prefix}/oauth2/token"),
        "jwks_uri": format!("{prefix}/jwks"),
        "registration_endpoint": format!("{prefix}/oauth2/register"),
        "device_authorization_endpoint": format!("{prefix}/device/code"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "none"],
        "id_token_signing_alg_values_supported": ["EdDSA"],
        "client_id_metadata_document_supported": true
    })
}

pub fn oauth_protected_resource_metadata(base_url: &str, resource_path: &str) -> serde_json::Value {
    let origin = base_url.trim_end_matches('/');
    serde_json::json!({
        "resource": format!("{origin}{resource_path}"),
        "authorization_servers": [origin],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["openid", "profile", "email", "offline_access", "mcp:tools"]
    })
}

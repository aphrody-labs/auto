// OAuth2 PKCE (S256), social/OIDC authorization URL builder, and RFC 8628 Device Authorization codes.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Google,
    Microsoft,
    GitHub,
}

impl OAuthProvider {
    pub fn endpoints(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Google => (
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                "openid email profile",
            ),
            Self::Microsoft => (
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                "openid email profile offline_access",
            ),
            Self::GitHub => (
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                "read:user user:email",
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
    pub method: String,
}

pub fn pkce_pair_from_entropy(entropy32: &[u8]) -> PkcePair {
    let verifier = URL_SAFE_NO_PAD.encode(entropy32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkcePair { verifier, challenge, method: "S256".into() }
}

pub fn build_authorize_url(
    provider: OAuthProvider,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    pkce_challenge: &str,
) -> String {
    let (auth_url, _, scopes) = provider.endpoints();
    format!(
        "{auth_url}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        pct(client_id),
        pct(redirect_uri),
        pct(scopes),
        pct(state),
        pct(pkce_challenge)
    )
}

pub fn format_device_user_code(entropy8: &[u8]) -> String {
    const SAFE_CHARS: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let mut code = String::with_capacity(9);
    for (i, &b) in entropy8.iter().take(8).enumerate() {
        if i == 4 {
            code.push('-');
        }
        code.push(SAFE_CHARS[(b as usize) % SAFE_CHARS.len()] as char);
    }
    code
}

fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

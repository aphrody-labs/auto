// WebAuthn / Passkey verification (ECDSA P-256 / ES256) and challenge options builder.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{DerSignature, Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{AuthError, AuthResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyAssertion {
    pub credential_id: String,
    pub authenticator_data_b64u: String,
    pub client_data_json_b64u: String,
    pub signature_b64u: String,
    /// Uncompressed 65-byte SEC1 point (0x04 || x || y) or compressed 33-byte SEC1 public key.
    pub public_key_sec1: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDataJson {
    #[serde(rename = "type")]
    pub kind: String,
    pub challenge: String,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedPasskey {
    pub sign_count: u32,
    pub user_verified: bool,
    pub rp_id_hash_hex: String,
}

pub fn build_register_options(
    rp_id: &str,
    rp_name: &str,
    user_id: &str,
    user_email: &str,
    challenge_bytes: &[u8],
) -> serde_json::Value {
    serde_json::json!({
        "challenge": URL_SAFE_NO_PAD.encode(challenge_bytes),
        "rp": { "id": rp_id, "name": rp_name },
        "user": {
            "id": URL_SAFE_NO_PAD.encode(user_id.as_bytes()),
            "name": user_email,
            "displayName": user_email,
        },
        "pubKeyCredParams": [
            { "type": "public-key", "alg": -7 },
            { "type": "public-key", "alg": -257 }
        ],
        "timeout": 60000,
        "attestation": "none",
        "authenticatorSelection": {
            "residentKey": "preferred",
            "userVerification": "preferred"
        }
    })
}

/// Verify a WebAuthn `webauthn.get` ES256 (P-256) assertion against expected challenge, origin, and RP ID.
pub fn verify_passkey_assertion(
    assertion: &PasskeyAssertion,
    expected_challenge_b64u: &str,
    expected_origin: &str,
    expected_rp_id: &str,
    min_sign_count: u32,
) -> AuthResult<VerifiedPasskey> {
    let client_bytes = URL_SAFE_NO_PAD
        .decode(&assertion.client_data_json_b64u)
        .map_err(|_| AuthError::Unauthorized("invalid passkey clientDataJSON encoding".into()))?;
    let client: ClientDataJson = serde_json::from_slice(&client_bytes)
        .map_err(|e| AuthError::Unauthorized(format!("invalid clientDataJSON: {e}")))?;
    if client.kind != "webauthn.get" {
        return Err(AuthError::Unauthorized("expected webauthn.get ceremony".into()));
    }
    if !bool::from(client.challenge.as_bytes().ct_eq(expected_challenge_b64u.as_bytes())) {
        return Err(AuthError::Unauthorized("passkey challenge mismatch".into()));
    }
    if client.origin.trim_end_matches('/') != expected_origin.trim_end_matches('/') {
        return Err(AuthError::Unauthorized("passkey origin mismatch".into()));
    }

    let auth_data = URL_SAFE_NO_PAD
        .decode(&assertion.authenticator_data_b64u)
        .map_err(|_| AuthError::Unauthorized("invalid authenticatorData encoding".into()))?;
    if auth_data.len() < 37 {
        return Err(AuthError::Unauthorized("authenticatorData truncated".into()));
    }
    let expected_rp_hash = Sha256::digest(expected_rp_id.as_bytes());
    if !bool::from(auth_data[..32].ct_eq(expected_rp_hash.as_slice())) {
        return Err(AuthError::Unauthorized("passkey RP ID hash mismatch".into()));
    }
    let flags = auth_data[32];
    if (flags & 0x01) == 0 {
        return Err(AuthError::Unauthorized("passkey user-present flag missing".into()));
    }
    let user_verified = (flags & 0x04) != 0;
    let sign_count = u32::from_be_bytes([auth_data[33], auth_data[34], auth_data[35], auth_data[36]]);
    if min_sign_count > 0 && sign_count <= min_sign_count {
        return Err(AuthError::Unauthorized("passkey signCount replay detected".into()));
    }

    let client_hash = Sha256::digest(&client_bytes);
    let mut signed_msg = Vec::with_capacity(auth_data.len() + 32);
    signed_msg.extend_from_slice(&auth_data);
    signed_msg.extend_from_slice(&client_hash);

    let sig_bytes = URL_SAFE_NO_PAD
        .decode(&assertion.signature_b64u)
        .map_err(|_| AuthError::Unauthorized("invalid passkey signature encoding".into()))?;
    let vk = VerifyingKey::from_sec1_bytes(&assertion.public_key_sec1)
        .map_err(|_| AuthError::Unauthorized("invalid P-256 SEC1 public key".into()))?;
    if sig_bytes.len() == 64 {
        let sig = Signature::from_slice(&sig_bytes)
            .map_err(|_| AuthError::Unauthorized("invalid raw P-256 signature".into()))?;
        vk.verify(&signed_msg, &sig)
            .map_err(|_| AuthError::Unauthorized("passkey ES256 signature verification failed".into()))?;
    } else {
        let sig = DerSignature::try_from(sig_bytes.as_slice())
            .map_err(|_| AuthError::Unauthorized("invalid DER P-256 signature".into()))?;
        vk.verify(&signed_msg, &sig)
            .map_err(|_| AuthError::Unauthorized("passkey ES256 signature verification failed".into()))?;
    }

    Ok(VerifiedPasskey { sign_count, user_verified, rp_id_hash_hex: crate::hex_encode(&expected_rp_hash) })
}

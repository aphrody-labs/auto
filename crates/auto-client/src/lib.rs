//! Shared typed REST/WebSocket models, SQLite HLC sync protocol, Dual-Mode config, and signed auto-update verification.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use thiserror::Error;

/// API, sync, or update verification errors.
#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid HLC timestamp: {0}")]
    InvalidHlc(String),
    #[error("invalid base URL: {0}")]
    InvalidUrl(String),
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("release verification failed: {0}")]
    UpdateVerification(String),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Deployment topology mode (`AUTO_MODE=serverless|self-hosted`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerMode {
    #[default]
    Serverless,
    SelfHosted,
}

/// Shared client configuration targeting either Cloudflare Workers (`Serverless`) or Bun server (`SelfHosted`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub mode: ServerMode,
    pub base_url: String,
    pub organization_id: String,
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_token: Option<String>,
}

impl ClientConfig {
    /// Builds an HTTPS/HTTP REST URL for an endpoint path (e.g. `routes::DOCUMENTS`).
    pub fn api_url(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let rel = if path.starts_with('/') { path.to_owned() } else { format!("/{path}") };
        format!("{base}{rel}")
    }

    /// Builds the `/v1/sync/:company` WebSocket URL (`wss://` or `ws://`).
    pub fn ws_sync_url(&self) -> Result<String, ClientError> {
        let base = self.base_url.trim().trim_end_matches('/');
        let ws_base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if base.starts_with("wss://") || base.starts_with("ws://") {
            base.to_owned()
        } else {
            return Err(ClientError::InvalidUrl(self.base_url.clone()));
        };
        Ok(format!("{ws_base}/v1/sync/{}", self.organization_id))
    }

    /// Returns the URL for `/releases/manifest.json`.
    pub fn release_manifest_url(&self) -> String {
        self.api_url(routes::RELEASES_MANIFEST)
    }
}

/// Hybrid Logical Clock (`<wall_ms>:<counter>:<node_id>`) for causal multi-device conflict resolution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hlc {
    pub wall_ms: u64,
    pub counter: u32,
    pub node_id: String,
}

impl Hlc {
    pub fn new(wall_ms: u64, counter: u32, node_id: impl Into<String>) -> Self {
        Self { wall_ms, counter, node_id: node_id.into() }
    }

    /// Generates the next monotonic HLC timestamp given the local physical clock and previous HLC.
    pub fn tick(last: Option<&Hlc>, physical_ms: u64, node_id: impl Into<String>) -> Self {
        let node = node_id.into();
        match last {
            Some(prev) => {
                let wall_ms = physical_ms.max(prev.wall_ms);
                let counter = if wall_ms == prev.wall_ms { prev.counter.saturating_add(1) } else { 0 };
                Self { wall_ms, counter, node_id: node }
            }
            None => Self { wall_ms: physical_ms, counter: 0, node_id: node },
        }
    }

    /// Merges a received remote HLC with the local clock before advancing locally.
    pub fn receive(local: Option<&Hlc>, remote: &Hlc, physical_ms: u64, node_id: impl Into<String>) -> Self {
        let local_max = local.map_or(0, |l| l.wall_ms);
        let wall_ms = physical_ms.max(local_max).max(remote.wall_ms);
        let counter = match (local.filter(|l| l.wall_ms == wall_ms), remote.wall_ms == wall_ms) {
            (Some(l), true) => l.counter.max(remote.counter).saturating_add(1),
            (Some(l), false) => l.counter.saturating_add(1),
            (None, true) => remote.counter.saturating_add(1),
            (None, false) => 0,
        };
        Self { wall_ms, counter, node_id: node_id.into() }
    }

    /// Parses `<wall_ms>:<counter>:<node_id>`.
    pub fn parse(raw: &str) -> Result<Self, ClientError> {
        let mut parts = raw.splitn(3, ':');
        let wall_ms: u64 =
            parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| ClientError::InvalidHlc(raw.to_owned()))?;
        let counter: u32 =
            parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| ClientError::InvalidHlc(raw.to_owned()))?;
        let node_id =
            parts.next().filter(|s| !s.is_empty()).ok_or_else(|| ClientError::InvalidHlc(raw.to_owned()))?.to_owned();
        Ok(Self { wall_ms, counter, node_id })
    }

    /// Zero-padded sortable canonical string representation (`{:016}:{:06}:{}`).
    pub fn encode(&self) -> String {
        format!("{:016}:{:06}:{}", self.wall_ms, self.counter, self.node_id)
    }
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> Ordering {
        self.wall_ms
            .cmp(&other.wall_ms)
            .then_with(|| self.counter.cmp(&other.counter))
            .then_with(|| self.node_id.cmp(&other.node_id))
    }
}

impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Returns `true` if `incoming` wins over `existing` under Last-Writer-Wins HLC ordering.
pub fn incoming_wins(existing_hlc: Option<&str>, incoming_hlc: &Hlc) -> Result<bool, ClientError> {
    match existing_hlc {
        None => Ok(true),
        Some(raw) => Ok(*incoming_hlc > Hlc::parse(raw)?),
    }
}

/// Sync operation kind persisted in the local outbox and replicated over REST/WebSocket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncOpKind {
    Upsert,
    Delete,
}

/// Entity types tracked by the local SQLite store, Bun server, and Cloudflare D1/DO sync backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Document,
    Customer,
    Project,
    Automation,
    Settings,
}

/// Single causal mutation record in the HLC sync log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOp {
    pub op_id: String,
    pub entity: EntityKind,
    pub record_id: String,
    pub kind: SyncOpKind,
    pub hlc: Hlc,
    pub payload: Option<serde_json::Value>,
}

/// WebSocket frame payloads exchanged on `/v1/sync/:company`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsSyncMessage {
    Pull { since_hlc: Option<String>, limit: Option<u32> },
    Push { node_id: String, ops: Vec<SyncOp> },
    Ops { ops: Vec<SyncOp>, head_hlc: Option<String>, has_more: bool },
    Ack { accepted_ids: Vec<String>, head_hlc: Option<String> },
    Ping { ts_ms: u64 },
    Pong { ts_ms: u64 },
    Error { code: String, message: String },
}

/// Lifecycle status of a commercial document.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentStatus {
    #[default]
    Draft,
    Issued,
    Sent,
    Accepted,
    Paid,
    Overdue,
    Cancelled,
}

/// Synced document envelope combining commercial status, identity, and `auto_model::Document` payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub organization_id: String,
    pub customer_id: Option<String>,
    pub project_id: Option<String>,
    pub status: DocumentStatus,
    pub payload: auto_model::Document,
    pub totals: auto_model::Totals,
    pub updated_hlc: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// Synced customer record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub tax_id: Option<String>,
    pub vat_number: Option<String>,
    pub address: String,
    pub delivery_address: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub updated_hlc: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// Synced project / worksite record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub organization_id: String,
    pub customer_id: Option<String>,
    pub code: Option<String>,
    pub name: String,
    pub status: String,
    pub budget_excl_vat_cents: Option<i64>,
    pub updated_hlc: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// Synced workflow automation definition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: String,
    pub graph: serde_json::Value,
    pub updated_hlc: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// Sync pull request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullRequest {
    pub since_hlc: Option<String>,
    pub limit: Option<u32>,
}

/// Sync pull response returning causal ops and next cursor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResponse {
    pub ops: Vec<SyncOp>,
    pub head_hlc: Option<String>,
    pub has_more: bool,
}

/// Sync push request sending locally committed outbox ops.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushRequest {
    pub node_id: String,
    pub ops: Vec<SyncOp>,
}

/// Sync push acknowledgement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResponse {
    pub accepted: usize,
    pub rejected: usize,
    pub head_hlc: Option<String>,
}

/// Platform binary entry inside an `UpdateManifest` (`/releases/manifest.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtifact {
    pub platform: String,
    pub filename: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub signature_ed25519: String,
}

/// Signed release manifest published to R2 (`auto/releases/manifest.json`) and served at `/releases/manifest.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub version: String,
    pub published_at: String,
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub artifacts: Vec<ReleaseArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_signature_ed25519: Option<String>,
}

impl UpdateManifest {
    /// Finds a matching artifact for a platform target (e.g. `"windows-x86_64"`, `"darwin-aarch64"`, `"linux-x86_64"`).
    pub fn artifact_for(&self, platform: &str) -> Option<&ReleaseArtifact> {
        self.artifacts.iter().find(|a| a.platform == platform)
    }

    /// Canonical signing string for the whole manifest: `{version}\n{published_at}\n{channel}\n{platform:filename:sha256:size}\n...`.
    pub fn canonical_payload(&self) -> String {
        let mut lines = Vec::with_capacity(self.artifacts.len() + 3);
        lines.push(self.version.clone());
        lines.push(self.published_at.clone());
        lines.push(self.channel.clone());
        let mut sorted: Vec<&ReleaseArtifact> = self.artifacts.iter().collect();
        sorted.sort_by(|a, b| a.platform.cmp(&b.platform).then_with(|| a.filename.cmp(&b.filename)));
        for a in sorted {
            lines.push(format!("{}:{}:{}:{}", a.platform, a.filename, a.sha256.to_ascii_lowercase(), a.size_bytes));
        }
        lines.join("\n")
    }

    /// Verifies `manifest_signature_ed25519` against an Ed25519 public key (hex).
    pub fn verify_manifest_signature(&self, public_key_hex: &str) -> Result<(), ClientError> {
        let sig_hex = self
            .manifest_signature_ed25519
            .as_deref()
            .ok_or_else(|| ClientError::UpdateVerification("missing manifest signature".into()))?;
        verify_ed25519_hex(public_key_hex, sig_hex, self.canonical_payload().as_bytes())
    }
}

impl ReleaseArtifact {
    /// Canonical signing string for a single artifact: `{platform}:{filename}:{sha256}:{size_bytes}`.
    pub fn canonical_payload(&self) -> String {
        format!("{}:{}:{}:{}", self.platform, self.filename, self.sha256.to_ascii_lowercase(), self.size_bytes)
    }

    /// Verifies both the Ed25519 signature over artifact metadata and the downloaded bytes' SHA-256 digest.
    pub fn verify_bytes(&self, bytes: &[u8], public_key_hex: &str) -> Result<(), ClientError> {
        verify_ed25519_hex(public_key_hex, &self.signature_ed25519, self.canonical_payload().as_bytes())?;
        if bytes.len() as u64 != self.size_bytes {
            return Err(ClientError::UpdateVerification(format!(
                "size mismatch: expected {} bytes, got {}",
                self.size_bytes,
                bytes.len()
            )));
        }
        let actual = sha256_hex(bytes);
        if !actual.eq_ignore_ascii_case(&self.sha256) {
            return Err(ClientError::UpdateVerification(format!(
                "sha256 mismatch: expected {}, got {actual}",
                self.sha256
            )));
        }
        Ok(())
    }
}

/// Computes lowercase hex-encoded SHA-256 digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Verifies an Ed25519 signature (`signature_hex`, 64 bytes) against `public_key_hex` (32 bytes) and `message`.
pub fn verify_ed25519_hex(public_key_hex: &str, signature_hex: &str, message: &[u8]) -> Result<(), ClientError> {
    let pk_bytes = decode_hex_array::<32>(public_key_hex)
        .ok_or_else(|| ClientError::UpdateVerification("invalid Ed25519 public key hex".into()))?;
    let sig_bytes = decode_hex_array::<64>(signature_hex)
        .ok_or_else(|| ClientError::UpdateVerification("invalid Ed25519 signature hex".into()))?;
    let key = VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| ClientError::UpdateVerification("malformed Ed25519 public key".into()))?;
    let sig = Signature::from_bytes(&sig_bytes);
    key.verify(message, &sig).map_err(|_| ClientError::UpdateVerification("Ed25519 signature check failed".into()))
}

fn decode_hex_array<const N: usize>(hex: &str) -> Option<[u8; N]> {
    let trimmed = hex.trim();
    if trimmed.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&trimmed[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Canonical REST, WebSocket, and release routes exposed by `apps/server`.
pub mod routes {
    pub const HEALTH: &str = "/health";
    pub const AUTH_SESSION: &str = "/api/auth/session";
    pub const DOCUMENTS: &str = "/api/documents";
    pub const CUSTOMERS: &str = "/api/customers";
    pub const PROJECTS: &str = "/api/projects";
    pub const AUTOMATIONS: &str = "/api/automations";
    pub const SYNC_PULL: &str = "/api/sync/pull";
    pub const SYNC_PUSH: &str = "/api/sync/push";
    pub const SYNC_WS_PREFIX: &str = "/v1/sync";
    pub const KNOWLEDGE_SEARCH: &str = "/api/knowledge/search";
    pub const MCP: &str = "/mcp";
    pub const ADMIN_PREFIX: &str = "/admin";
    pub const RELEASES_MANIFEST: &str = "/releases/manifest.json";
    pub const RELEASES_PREFIX: &str = "/releases";
}

/// Local SQLite schema matching D1 entities, Bun SQLite server tables, and the HLC outbox.
pub const LOCAL_SQLITE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  op_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  hlc TEXT NOT NULL,
  payload_json TEXT,
  pushed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_hlc ON sync_outbox(hlc);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT,
  project_id TEXT,
  status TEXT NOT NULL,
  number TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_hlc TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_hlc TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_hlc TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_hlc TEXT NOT NULL,
  deleted_at TEXT
);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn hlc_and_ws_sync_urls_work_for_both_modes() {
        let a = Hlc::tick(None, 1_700_000_000_000, "node-a");
        let b = Hlc::receive(Some(&a), &Hlc::new(1_700_000_000_500, 3, "srv"), 1_699_000_000_000, "node-a");
        assert!(b > a);
        assert!(incoming_wins(Some(&a.encode()), &b).unwrap());
        assert!(!incoming_wins(Some(&b.encode()), &a).unwrap());

        let cloud = ClientConfig {
            mode: ServerMode::Serverless,
            base_url: "https://api.example.com/".into(),
            organization_id: "org-1".into(),
            node_id: "desktop-1".into(),
            bearer_token: None,
        };
        assert_eq!(cloud.ws_sync_url().unwrap(), "wss://api.example.com/v1/sync/org-1");

        let local = ClientConfig {
            mode: ServerMode::SelfHosted,
            base_url: "http://127.0.0.1:8787".into(),
            organization_id: "org-1".into(),
            node_id: "desktop-1".into(),
            bearer_token: None,
        };
        assert_eq!(local.ws_sync_url().unwrap(), "ws://127.0.0.1:8787/v1/sync/org-1");
        assert_eq!(local.release_manifest_url(), "http://127.0.0.1:8787/releases/manifest.json");
    }

    #[test]
    fn verifies_signed_update_manifest_and_artifact_bytes() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let pk_hex: String = signing_key.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let payload = b"auto-desktop-installer-bytes";
        let sha = sha256_hex(payload);
        let mut artifact = ReleaseArtifact {
            platform: "windows-x86_64".into(),
            filename: "auto-desktop.msi".into(),
            url: "/releases/auto-desktop.msi".into(),
            size_bytes: payload.len() as u64,
            sha256: sha,
            signature_ed25519: String::new(),
        };
        let sig: Signature = signing_key.sign(artifact.canonical_payload().as_bytes());
        artifact.signature_ed25519 = sig.to_bytes().iter().map(|b| format!("{b:02x}")).collect();

        let mut manifest = UpdateManifest {
            version: "0.2.0".into(),
            published_at: "2026-11-18T12:00:00Z".into(),
            channel: "stable".into(),
            notes: None,
            artifacts: vec![artifact],
            manifest_signature_ed25519: None,
        };
        let msig: Signature = signing_key.sign(manifest.canonical_payload().as_bytes());
        manifest.manifest_signature_ed25519 = Some(msig.to_bytes().iter().map(|b| format!("{b:02x}")).collect());

        manifest.verify_manifest_signature(&pk_hex).unwrap();
        manifest.artifact_for("windows-x86_64").unwrap().verify_bytes(payload, &pk_hex).unwrap();
        assert!(manifest.artifact_for("windows-x86_64").unwrap().verify_bytes(b"tampered", &pk_hex).is_err());
    }
}

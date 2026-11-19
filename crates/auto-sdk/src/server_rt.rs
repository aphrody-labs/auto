// Embedded native Axum HTTP + Better Auth (`auto-auth`) + MCP + Factur-X API runtime for `auto serve`.
use auto_auth::{
    AuthConfig,
    server::{SqlAuthStore, auth_router},
};
use axum::{
    Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::Value;

use crate::{VERSION, config::ResolvedRuntimeConfig, mcp::handle_mcp_request};

pub fn build_native_server_router(cfg: &ResolvedRuntimeConfig, store: SqlAuthStore) -> Router {
    let mode = cfg.mode.clone();
    let app = Router::new()
        .route(
            "/health",
            get(move || async move {
                Json(serde_json::json!({
                    "ok": true,
                    "runtime": "rust-native",
                    "mode": mode,
                    "version": VERSION,
                }))
            }),
        )
        .route("/mcp", post(h_mcp))
        .route("/v1/status", get(h_status));

    app.merge(auth_router(store))
}

async fn h_status() -> Response {
    Json(serde_json::json!({
        "engine": "aphrody-auto",
        "version": VERSION,
        "auth": "auto-auth-rust (Argon2id + Ed25519 JWKS + Passkeys + TOTP)",
    }))
    .into_response()
}

async fn h_mcp(Json(req): Json<Value>) -> Response {
    match handle_mcp_request(&req) {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

pub fn default_auth_config(cfg: &ResolvedRuntimeConfig) -> AuthConfig {
    let master_secret = std::env::var("AUTO_MASTER_KEY")
        .ok()
        .filter(|s| s.len() >= 16)
        .or_else(|| std::env::var("BETTER_AUTH_SECRET").ok().filter(|s| s.len() >= 16))
        .unwrap_or_else(|| "auto-local-dev-master-key-32-chars!!".into());
    AuthConfig {
        app_name: "Auto".into(),
        base_url: cfg.public_base_url.clone(),
        base_path: "/api/auth".into(),
        master_secret,
        trusted_origins: vec![cfg.public_base_url.clone(), "http://localhost:*".into(), "http://127.0.0.1:*".into()],
        session_ttl_secs: 60 * 60 * 24 * 7,
    }
}

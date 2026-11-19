// Native SQLite Better Auth Store + Axum `/api/auth/*` & `/.well-known/*` Router matching `001_global.sql`.
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    AuthConfig, AuthError, AuthResult, hex_encode,
    jwt::{
        JwkSet, JwtClaims, derive_ed25519_keypair, jwk_from_verifying_key, oauth_authorization_server_metadata,
        oauth_protected_resource_metadata, sign_jwt,
    },
    normalize_email,
    oauth::format_device_user_code,
    password::{hash_password, verify_password},
    random_bytes, random_hex,
    rbac::{Role, generate_api_key, verify_api_key_digest},
    session::{sha256_b64u, sign_hmac_token, verify_hmac_token},
    totp::{TotpAlgorithm, decode_base32, encode_base32, otpauth_uri, verify_totp},
    valid_email,
};

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn now_iso() -> String {
    let s = now_secs();
    format!("1970-01-01T00:00:00Z+{s}s")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub two_factor_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub id: String,
    pub user_id: String,
    pub token: String,
    pub active_organization_id: Option<String>,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnvelope {
    pub user: AuthUser,
    pub session: AuthSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SqlAuthStore {
    conn: Arc<Mutex<Connection>>,
    pub config: AuthConfig,
}

impl SqlAuthStore {
    pub fn open(path: &str, config: AuthConfig) -> AuthResult<Self> {
        let conn = if path == ":memory:" { Connection::open_in_memory() } else { Connection::open(path) }
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        let store = Self { conn: Arc::new(Mutex::new(conn)), config };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn from_connection(conn: Connection, config: AuthConfig) -> AuthResult<Self> {
        let store = Self { conn: Arc::new(Mutex::new(conn)), config };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn ensure_schema(&self) -> AuthResult<()> {
        let guard = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        guard
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS company (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    siren TEXT NOT NULL DEFAULT '000000000',
                    siret TEXT NOT NULL DEFAULT '00000000000000',
                    address TEXT NOT NULL DEFAULT '',
                    slug TEXT NOT NULL UNIQUE,
                    suspended_at TEXT,
                    deleted_at TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_user (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL DEFAULT '',
                    email_verified INTEGER NOT NULL DEFAULT 0,
                    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
                    role TEXT NOT NULL DEFAULT 'user',
                    banned INTEGER NOT NULL DEFAULT 0,
                    ban_expires TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
                    account_id TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    password TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
                    token TEXT NOT NULL UNIQUE,
                    expires_at INTEGER NOT NULL,
                    active_organization_id TEXT,
                    ip_address TEXT,
                    user_agent TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS membership (
                    id TEXT PRIMARY KEY,
                    company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    segments TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE (company_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS two_factor (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
                    secret TEXT NOT NULL,
                    backup_codes TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS apikey (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    start TEXT,
                    prefix TEXT,
                    key_hash TEXT NOT NULL UNIQUE,
                    reference_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS device_code (
                    id TEXT PRIMARY KEY,
                    device_code TEXT NOT NULL UNIQUE,
                    user_code TEXT NOT NULL UNIQUE,
                    user_id TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    expires_at INTEGER NOT NULL
                );
                "#,
            )
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn sign_up_email(&self, email: &str, password: &str, name: &str) -> AuthResult<SessionEnvelope> {
        let email = normalize_email(email);
        if !valid_email(&email) {
            return Err(AuthError::Validation("invalid email address".into()));
        }
        let pw_hash = hash_password(password)?;
        let user_id = format!("usr_{}", random_hex(12)?);
        let account_id = format!("acc_{}", random_hex(12)?);
        let now = now_iso();

        {
            let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
            let exists: Option<String> = conn
                .query_row("SELECT id FROM app_user WHERE email = ?1", [&email], |r| r.get(0))
                .optional()
                .map_err(|e| AuthError::Storage(e.to_string()))?;
            if exists.is_some() {
                return Err(AuthError::Conflict("user with this email already exists".into()));
            }
            conn.execute(
                "INSERT INTO app_user (id, email, name, email_verified, two_factor_enabled, role, banned, created_at) VALUES (?1, ?2, ?3, 0, 0, 'user', 0, ?4)",
                params![user_id, email, name.trim(), now],
            )
            .map_err(|e| AuthError::Storage(e.to_string()))?;
            conn.execute(
                "INSERT INTO account (id, user_id, account_id, provider_id, password, created_at) VALUES (?1, ?2, ?2, 'credential', ?3, ?4)",
                params![account_id, user_id, pw_hash, now],
            )
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        }
        self.create_session(&user_id, None, None)
    }

    pub fn sign_in_email(&self, email: &str, password: &str, totp_code: Option<&str>) -> AuthResult<SessionEnvelope> {
        let email = normalize_email(email);
        let (user_id, pw_hash, banned, two_factor) = {
            let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
            conn.query_row(
                "SELECT u.id, a.password, u.banned, u.two_factor_enabled FROM app_user u JOIN account a ON a.user_id = u.id AND a.provider_id = 'credential' WHERE u.email = ?1",
                [&email],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
            )
            .optional()
            .map_err(|e| AuthError::Storage(e.to_string()))?
            .ok_or_else(|| AuthError::Unauthorized("invalid email or password".into()))?
        };
        if banned != 0 {
            return Err(AuthError::Forbidden("account suspended".into()));
        }
        if !verify_password(password, &pw_hash)? {
            return Err(AuthError::Unauthorized("invalid email or password".into()));
        }
        if two_factor != 0 {
            let code = totp_code.ok_or_else(|| AuthError::Unauthorized("2FA TOTP code required".into()))?;
            if !self.verify_user_totp(&user_id, code)? {
                return Err(AuthError::Unauthorized("invalid 2FA TOTP code".into()));
            }
        }
        let default_org = self.default_organization_for_user(&user_id)?;
        self.create_session(&user_id, default_org, None)
    }

    fn create_session(
        &self,
        user_id: &str,
        active_org: Option<String>,
        ip: Option<String>,
    ) -> AuthResult<SessionEnvelope> {
        let sid = format!("ses_{}", random_hex(12)?);
        let nonce = random_hex(16)?;
        let exp = now_secs() + self.config.session_ttl_secs as i64;
        let payload = serde_json::json!({ "sid": sid, "sub": user_id, "nonce": nonce, "exp": exp });
        let signed = sign_hmac_token(&self.config.master_secret, "auto-auth:session", &payload)?;
        let now = now_iso();
        {
            let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
            conn.execute(
                "INSERT INTO session (id, user_id, token, expires_at, active_organization_id, ip_address, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![sid, user_id, signed, exp, active_org, ip, now],
            )
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        }
        self.get_session_by_token(&signed)?
            .ok_or_else(|| AuthError::Storage("failed reading newly created session".into()))
    }

    pub fn get_session_by_token(&self, token: &str) -> AuthResult<Option<SessionEnvelope>> {
        let _: serde_json::Value = match verify_hmac_token(&self.config.master_secret, "auto-auth:session", token) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        let row = conn
            .query_row(
                "SELECT s.id, s.user_id, s.token, s.active_organization_id, s.expires_at, u.email, u.name, u.role, u.two_factor_enabled
                 FROM session s JOIN app_user u ON u.id = s.user_id
                 WHERE s.token = ?1 AND u.banned = 0",
                [token],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, i64>(8)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        let Some((sid, uid, tok, org, exp, email, name, role, two_fa)) = row else {
            return Ok(None);
        };
        if exp <= now_secs() {
            let _ = conn.execute("DELETE FROM session WHERE id = ?1", [&sid]);
            return Ok(None);
        }
        let active_role = if let Some(ref oid) = org {
            conn.query_row(
                "SELECT role FROM membership WHERE company_id = ?1 AND user_id = ?2",
                params![oid, uid],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| AuthError::Storage(e.to_string()))?
        } else {
            None
        };
        Ok(Some(SessionEnvelope {
            user: AuthUser { id: uid.clone(), email, name, role, two_factor_enabled: two_fa },
            session: AuthSession { id: sid, user_id: uid, token: tok, active_organization_id: org, expires_at: exp },
            active_role,
        }))
    }

    pub fn sign_out(&self, token: &str) -> AuthResult<()> {
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        conn.execute("DELETE FROM session WHERE token = ?1", [token]).map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn create_organization(&self, owner_id: &str, name: &str, slug: &str, tax_id: &str) -> AuthResult<String> {
        let id = format!("org_{}", random_hex(12)?);
        let mem_id = format!("mem_{}", random_hex(12)?);
        let now = now_iso();
        let siren = tax_id.chars().filter(|c| c.is_ascii_digit()).take(9).collect::<String>();
        let siret = tax_id.chars().filter(|c| c.is_ascii_digit()).take(14).collect::<String>();
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        conn.execute(
            "INSERT INTO company (id, name, siren, siret, slug, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name.trim(), siren, siret, slug.trim(), now],
        )
        .map_err(|e| AuthError::Storage(e.to_string()))?;
        conn.execute(
            "INSERT INTO membership (id, company_id, user_id, role, created_at) VALUES (?1, ?2, ?3, 'owner', ?4)",
            params![mem_id, id, owner_id, now],
        )
        .map_err(|e| AuthError::Storage(e.to_string()))?;
        conn.execute(
            "UPDATE session SET active_organization_id = ?1 WHERE user_id = ?2 AND active_organization_id IS NULL",
            params![id, owner_id],
        )
        .map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok(id)
    }

    pub fn set_active_organization(&self, token: &str, org_id: &str) -> AuthResult<()> {
        let sess =
            self.get_session_by_token(token)?.ok_or_else(|| AuthError::Unauthorized("invalid session".into()))?;
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        let is_member: Option<String> = conn
            .query_row(
                "SELECT role FROM membership WHERE company_id = ?1 AND user_id = ?2",
                params![org_id, sess.user.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        if is_member.is_none() {
            return Err(AuthError::Forbidden("user is not a member of organization".into()));
        }
        conn.execute("UPDATE session SET active_organization_id = ?1 WHERE id = ?2", params![org_id, sess.session.id])
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok(())
    }

    pub fn default_organization_for_user(&self, user_id: &str) -> AuthResult<Option<String>> {
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        conn.query_row(
            "SELECT m.company_id FROM membership m JOIN company c ON c.id = m.company_id AND c.deleted_at IS NULL WHERE m.user_id = ?1 ORDER BY m.created_at ASC LIMIT 1",
            [user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| AuthError::Storage(e.to_string()))
    }

    pub fn enable_totp(&self, user_id: &str, email: &str) -> AuthResult<(String, String)> {
        let secret = random_bytes(20)?;
        let secret_b32 = encode_base32(&secret);
        let uri = otpauth_uri(&self.config.app_name, email, &secret, TotpAlgorithm::Sha1);
        let tf_id = format!("tfa_{}", random_hex(12)?);
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        conn.execute(
            "INSERT INTO two_factor (id, user_id, secret, backup_codes) VALUES (?1, ?2, ?3, '[]')
             ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret",
            params![tf_id, user_id, secret_b32],
        )
        .map_err(|e| AuthError::Storage(e.to_string()))?;
        conn.execute("UPDATE app_user SET two_factor_enabled = 1 WHERE id = ?1", [user_id])
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok((secret_b32, uri))
    }

    pub fn verify_user_totp(&self, user_id: &str, code: &str) -> AuthResult<bool> {
        let secret_b32: String = {
            let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
            conn.query_row("SELECT secret FROM two_factor WHERE user_id = ?1", [user_id], |r| r.get(0))
                .optional()
                .map_err(|e| AuthError::Storage(e.to_string()))?
                .ok_or_else(|| AuthError::NotFound("two-factor not enabled".into()))?
        };
        let raw = decode_base32(&secret_b32)?;
        verify_totp(&raw, code, now_secs() as u64, 6, 30, 1, TotpAlgorithm::Sha1)
    }

    pub fn create_api_key(&self, user_id: &str, company_id: &str, name: &str) -> AuthResult<(String, String)> {
        let key = generate_api_key("auto_")?;
        let id = format!("key_{}", random_hex(12)?);
        let now = now_iso();
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        conn.execute(
            "INSERT INTO apikey (id, name, start, prefix, key_hash, reference_id, user_id, enabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
            params![id, name, key.start, key.prefix, key.sha256_b64u, company_id, user_id, now],
        )
        .map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok((id, key.raw_key))
    }

    pub fn verify_api_key(&self, raw_key: &str) -> AuthResult<Option<(String, String, Role)>> {
        let digest = sha256_b64u(raw_key.as_bytes());
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        let row = conn
            .query_row(
                "SELECT k.user_id, k.reference_id, k.key_hash, coalesce(m.role, 'readonly')
                 FROM apikey k LEFT JOIN membership m ON m.user_id = k.user_id AND m.company_id = k.reference_id
                 WHERE k.key_hash = ?1 AND k.enabled = 1",
                [&digest],
                |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
                },
            )
            .optional()
            .map_err(|e| AuthError::Storage(e.to_string()))?;
        if let Some((uid, comp_id, hash, role_str)) = row
            && verify_api_key_digest(raw_key, &hash)
        {
            return Ok(Some((uid, comp_id, Role::parse(&role_str).unwrap_or(Role::Readonly))));
        }
        Ok(None)
    }

    pub fn issue_jwt_for_session(&self, env: &SessionEnvelope) -> AuthResult<String> {
        let (signing, kid) = derive_ed25519_keypair(&self.config.master_secret, "jwt-default");
        let now = now_secs();
        sign_jwt(
            &signing,
            &kid,
            &JwtClaims {
                iss: self.config.base_url.clone(),
                sub: env.user.id.clone(),
                aud: format!("{}/mcp", self.config.base_url.trim_end_matches('/')),
                iat: now,
                exp: now + 900,
                active_organization_id: env.session.active_organization_id.clone(),
                role: env.active_role.clone().or_else(|| Some(env.user.role.clone())),
                email: Some(env.user.email.clone()),
            },
        )
    }

    pub fn jwks(&self) -> JwkSet {
        let (signing, kid) = derive_ed25519_keypair(&self.config.master_secret, "jwt-default");
        JwkSet { keys: vec![jwk_from_verifying_key(&signing.verifying_key(), &kid)] }
    }

    pub fn create_device_code(&self) -> AuthResult<(String, String)> {
        let dev = hex_encode(&random_bytes(20)?);
        let user_code = format_device_user_code(&random_bytes(8)?);
        let id = format!("dev_{}", random_hex(8)?);
        let exp = now_secs() + 600;
        let conn = self.conn.lock().map_err(|_| AuthError::Storage("sqlite mutex poisoned".into()))?;
        conn.execute(
            "INSERT INTO device_code (id, device_code, user_code, status, expires_at) VALUES (?1, ?2, ?3, 'pending', ?4)",
            params![id, dev, user_code, exp],
        )
        .map_err(|e| AuthError::Storage(e.to_string()))?;
        Ok((dev, user_code))
    }
}

fn error_response(err: AuthError) -> Response {
    let status = match &err {
        AuthError::Validation(_) => StatusCode::BAD_REQUEST,
        AuthError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
        AuthError::Forbidden(_) => StatusCode::FORBIDDEN,
        AuthError::Conflict(_) => StatusCode::CONFLICT,
        AuthError::NotFound(_) => StatusCode::NOT_FOUND,
        AuthError::Crypto(_) | AuthError::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(serde_json::json!({ "error": err.to_string() }))).into_response()
}

fn extract_bearer_or_cookie(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())
        && let Some(tok) = auth.strip_prefix("Bearer ")
    {
        return Some(tok.trim().to_string());
    }
    if let Some(cookie) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        for part in cookie.split(';') {
            let trimmed = part.trim();
            if let Some(val) = trimmed
                .strip_prefix("auto.session_token=")
                .or_else(|| trimmed.strip_prefix("__Secure-auto.session_token="))
            {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignUpBody {
    email: String,
    password: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInBody {
    email: String,
    password: String,
    #[serde(default)]
    totp_code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrgBody {
    name: String,
    slug: String,
    #[serde(default)]
    tax_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetActiveOrgBody {
    organization_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateApiKeyBody {
    name: String,
    #[serde(default)]
    company_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyTotpBody {
    code: String,
}

fn set_session_cookie_header(token: &str, secure: bool) -> HeaderValue {
    let sec = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("auto.session_token={token}; Path=/; HttpOnly; SameSite=Lax{sec}"))
        .unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// Build an Axum router exposing native Better Auth compatible routes (`/api/auth/*` & `/.well-known/*`).
pub fn auth_router(store: SqlAuthStore) -> Router {
    let shared = Arc::new(store);
    Router::new()
        .route("/api/auth/sign-up/email", post(h_sign_up))
        .route("/api/auth/sign-in/email", post(h_sign_in))
        .route("/api/auth/sign-out", post(h_sign_out))
        .route("/api/auth/get-session", get(h_get_session))
        .route("/api/auth/token", get(h_token))
        .route("/api/auth/jwks", get(h_jwks))
        .route("/api/auth/organization/create", post(h_create_org))
        .route("/api/auth/organization/set-active", post(h_set_active_org))
        .route("/api/auth/api-key/create", post(h_create_api_key))
        .route("/api/auth/two-factor/enable", post(h_enable_totp))
        .route("/api/auth/two-factor/verify-totp", post(h_verify_totp))
        .route("/api/auth/device/code", post(h_device_code))
        .route("/.well-known/jwks.json", get(h_jwks))
        .route("/.well-known/oauth-authorization-server", get(h_oauth_meta))
        .route("/.well-known/oauth-protected-resource", get(h_resource_meta))
        .route("/.well-known/oauth-protected-resource/{*rest}", get(h_resource_meta_path))
        .with_state(shared)
}

async fn h_sign_up(State(s): State<Arc<SqlAuthStore>>, Json(body): Json<SignUpBody>) -> Response {
    match s.sign_up_email(&body.email, &body.password, &body.name) {
        Ok(env) => {
            let secure = s.config.base_url.starts_with("https://");
            ([(header::SET_COOKIE, set_session_cookie_header(&env.session.token, secure))], Json(env)).into_response()
        }
        Err(e) => error_response(e),
    }
}

async fn h_sign_in(State(s): State<Arc<SqlAuthStore>>, Json(body): Json<SignInBody>) -> Response {
    match s.sign_in_email(&body.email, &body.password, body.totp_code.as_deref()) {
        Ok(env) => {
            let secure = s.config.base_url.starts_with("https://");
            ([(header::SET_COOKIE, set_session_cookie_header(&env.session.token, secure))], Json(env)).into_response()
        }
        Err(e) => error_response(e),
    }
}

async fn h_sign_out(State(s): State<Arc<SqlAuthStore>>, headers: HeaderMap) -> Response {
    if let Some(tok) = extract_bearer_or_cookie(&headers) {
        let _ = s.sign_out(&tok);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn h_get_session(State(s): State<Arc<SqlAuthStore>>, headers: HeaderMap) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return Json(serde_json::Value::Null).into_response();
    };
    match s.get_session_by_token(&tok) {
        Ok(Some(env)) => Json(env).into_response(),
        Ok(None) => Json(serde_json::Value::Null).into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_token(State(s): State<Arc<SqlAuthStore>>, headers: HeaderMap) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return error_response(AuthError::Unauthorized("missing session".into()));
    };
    match s.get_session_by_token(&tok) {
        Ok(Some(env)) => match s.issue_jwt_for_session(&env) {
            Ok(jwt) => Json(serde_json::json!({ "token": jwt })).into_response(),
            Err(e) => error_response(e),
        },
        Ok(None) => error_response(AuthError::Unauthorized("invalid session".into())),
        Err(e) => error_response(e),
    }
}

async fn h_jwks(State(s): State<Arc<SqlAuthStore>>) -> Response {
    Json(s.jwks()).into_response()
}

async fn h_create_org(
    State(s): State<Arc<SqlAuthStore>>,
    headers: HeaderMap,
    Json(b): Json<CreateOrgBody>,
) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return error_response(AuthError::Unauthorized("missing session".into()));
    };
    let Ok(Some(env)) = s.get_session_by_token(&tok) else {
        return error_response(AuthError::Unauthorized("invalid session".into()));
    };
    match s.create_organization(&env.user.id, &b.name, &b.slug, &b.tax_id) {
        Ok(id) => Json(serde_json::json!({ "id": id, "name": b.name, "slug": b.slug })).into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_set_active_org(
    State(s): State<Arc<SqlAuthStore>>,
    headers: HeaderMap,
    Json(b): Json<SetActiveOrgBody>,
) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return error_response(AuthError::Unauthorized("missing session".into()));
    };
    match s.set_active_organization(&tok, &b.organization_id) {
        Ok(()) => Json(serde_json::json!({ "activeOrganizationId": b.organization_id })).into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_create_api_key(
    State(s): State<Arc<SqlAuthStore>>,
    headers: HeaderMap,
    Json(b): Json<CreateApiKeyBody>,
) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return error_response(AuthError::Unauthorized("missing session".into()));
    };
    let Ok(Some(env)) = s.get_session_by_token(&tok) else {
        return error_response(AuthError::Unauthorized("invalid session".into()));
    };
    let Some(org_id) = b.company_id.or(env.session.active_organization_id) else {
        return error_response(AuthError::Validation("active organization required".into()));
    };
    match s.create_api_key(&env.user.id, &org_id, &b.name) {
        Ok((id, key)) => Json(serde_json::json!({ "id": id, "key": key })).into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_enable_totp(State(s): State<Arc<SqlAuthStore>>, headers: HeaderMap) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return error_response(AuthError::Unauthorized("missing session".into()));
    };
    let Ok(Some(env)) = s.get_session_by_token(&tok) else {
        return error_response(AuthError::Unauthorized("invalid session".into()));
    };
    match s.enable_totp(&env.user.id, &env.user.email) {
        Ok((secret, totp_uri)) => Json(serde_json::json!({ "secret": secret, "totpURI": totp_uri })).into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_verify_totp(
    State(s): State<Arc<SqlAuthStore>>,
    headers: HeaderMap,
    Json(b): Json<VerifyTotpBody>,
) -> Response {
    let Some(tok) = extract_bearer_or_cookie(&headers) else {
        return error_response(AuthError::Unauthorized("missing session".into()));
    };
    let Ok(Some(env)) = s.get_session_by_token(&tok) else {
        return error_response(AuthError::Unauthorized("invalid session".into()));
    };
    match s.verify_user_totp(&env.user.id, &b.code) {
        Ok(valid) => Json(serde_json::json!({ "valid": valid })).into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_device_code(State(s): State<Arc<SqlAuthStore>>) -> Response {
    match s.create_device_code() {
        Ok((device_code, user_code)) => Json(serde_json::json!({
            "device_code": device_code,
            "user_code": user_code,
            "verification_uri": format!("{}/app/device", s.config.base_url.trim_end_matches('/')),
            "expires_in": 600,
            "interval": 5
        }))
        .into_response(),
        Err(e) => error_response(e),
    }
}

async fn h_oauth_meta(State(s): State<Arc<SqlAuthStore>>) -> Response {
    Json(oauth_authorization_server_metadata(&s.config.base_url, &s.config.base_path)).into_response()
}

async fn h_resource_meta(State(s): State<Arc<SqlAuthStore>>) -> Response {
    Json(oauth_protected_resource_metadata(&s.config.base_url, "/mcp")).into_response()
}

async fn h_resource_meta_path(
    State(s): State<Arc<SqlAuthStore>>,
    Path(rest): Path<String>,
    Query(_): Query<std::collections::HashMap<String, String>>,
) -> Response {
    Json(oauth_protected_resource_metadata(&s.config.base_url, &format!("/{rest}"))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        jwt::verify_jwt,
        passkey::{PasskeyAssertion, verify_passkey_assertion},
        password::hash_password_scrypt_compat,
        session::{open_sealed, seal},
        totp::totp,
    };
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use p256::ecdsa::{SigningKey as P256SigningKey, signature::Signer as _};
    use sha2::{Digest, Sha256};

    fn test_config() -> AuthConfig {
        AuthConfig {
            app_name: "Auto".into(),
            base_url: "https://auto.aphrody.com".into(),
            base_path: "/api/auth".into(),
            master_secret: "test-master-secret-32-chars-minimum!!".into(),
            trusted_origins: vec!["https://auto.aphrody.com".into(), "http://localhost:*".into()],
            session_ttl_secs: 3600,
        }
    }

    #[test]
    fn password_argon2id_and_scrypt_compat_plus_chacha20_vault() {
        let argon = hash_password("SuperSecret#2026!").unwrap();
        assert!(argon.starts_with("$argon2id$v=19$"));
        assert!(verify_password("SuperSecret#2026!", &argon).unwrap());
        assert!(!verify_password("WrongPassword", &argon).unwrap());

        let scrypt = hash_password_scrypt_compat("LegacyBetterAuth!", b"0123456789abcdef").unwrap();
        assert!(scrypt.contains(':'));
        assert!(verify_password("LegacyBetterAuth!", &scrypt).unwrap());

        let sealed = seal(&test_config().master_secret, "mail/oauth", b"refresh_tok_123").unwrap();
        assert_eq!(open_sealed(&test_config().master_secret, "mail/oauth", &sealed).unwrap(), b"refresh_tok_123");
        assert!(open_sealed(&test_config().master_secret, "wrong-purpose", &sealed).is_err());
    }

    #[test]
    fn sqlite_better_auth_flow_jwt_totp_apikey_and_passkey_es256() {
        let store = SqlAuthStore::open(":memory:", test_config()).unwrap();
        let env = store.sign_up_email("founder@aphrody.com", "CorrectHorseBattery99!", "Founder").unwrap();
        let org_id = store.create_organization(&env.user.id, "Aphrody SAS", "aphrody-sas", "73282932000074").unwrap();
        store.set_active_organization(&env.session.token, &org_id).unwrap();

        let refreshed = store.get_session_by_token(&env.session.token).unwrap().unwrap();
        assert_eq!(refreshed.session.active_organization_id.as_deref(), Some(org_id.as_str()));
        assert_eq!(refreshed.active_role.as_deref(), Some("owner"));

        let jwt = store.issue_jwt_for_session(&refreshed).unwrap();
        let (sk, _) = derive_ed25519_keypair(&store.config.master_secret, "jwt-default");
        let claims = verify_jwt(
            &sk.verifying_key(),
            &jwt,
            Some("https://auto.aphrody.com"),
            Some("https://auto.aphrody.com/mcp"),
            now_secs(),
        )
        .unwrap();
        assert_eq!(claims.sub, env.user.id);

        let (secret_b32, uri) = store.enable_totp(&env.user.id, &env.user.email).unwrap();
        assert!(uri.starts_with("otpauth://totp/"));
        let code = totp(&decode_base32(&secret_b32).unwrap(), now_secs() as u64, 6, 30, TotpAlgorithm::Sha1).unwrap();
        assert!(store.verify_user_totp(&env.user.id, &code).unwrap());

        let (_kid, raw_key) = store.create_api_key(&env.user.id, &org_id, "cli").unwrap();
        let (uid, cid, role) = store.verify_api_key(&raw_key).unwrap().unwrap();
        assert_eq!(uid, env.user.id);
        assert_eq!(cid, org_id);
        assert_eq!(role, Role::Owner);

        // WebAuthn ES256 passkey assertion check
        let p256_sk = P256SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let sec1_pub = p256_sk.verifying_key().to_sec1_point(false).as_bytes().to_vec();
        let challenge = URL_SAFE_NO_PAD.encode(b"challenge-123456");
        let client_json = serde_json::json!({
            "type": "webauthn.get",
            "challenge": challenge,
            "origin": "https://auto.aphrody.com"
        })
        .to_string();
        let mut auth_data = Sha256::digest(b"auto.aphrody.com").to_vec();
        auth_data.push(0x05); // UP + UV
        auth_data.extend_from_slice(&5u32.to_be_bytes());
        let mut msg = auth_data.clone();
        msg.extend_from_slice(Sha256::digest(client_json.as_bytes()).as_slice());
        let sig: p256::ecdsa::Signature = p256_sk.sign(&msg);
        let assertion = PasskeyAssertion {
            credential_id: "cred_1".into(),
            authenticator_data_b64u: URL_SAFE_NO_PAD.encode(&auth_data),
            client_data_json_b64u: URL_SAFE_NO_PAD.encode(client_json.as_bytes()),
            signature_b64u: URL_SAFE_NO_PAD.encode(sig.to_der().as_bytes()),
            public_key_sec1: sec1_pub,
        };
        let verified =
            verify_passkey_assertion(&assertion, &challenge, "https://auto.aphrody.com", "auto.aphrody.com", 1)
                .unwrap();
        assert_eq!(verified.sign_count, 5);
        assert!(verified.user_verified);
    }
}

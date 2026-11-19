-- Global SQLite schema (Cloudflare D1 `auto` and self-hosted global SQLite).
-- Covers Better Auth 1.7, company registry, RBAC memberships, Stripe billing state, and operator audit logs.

CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  siren TEXT NOT NULL DEFAULT '',
  siret TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  vat_number TEXT,
  vat_exempt INTEGER NOT NULL DEFAULT 0,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  billing_period TEXT CHECK (billing_period IN ('monthly', 'annual')),
  subscription_status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  trial_ends_at TEXT,
  period_ends_at TEXT,
  suspended_at TEXT,
  suspension_reason TEXT,
  deletion_requested_at TEXT,
  deletion_requested_by TEXT,
  deletion_effective_at TEXT,
  deleted_at TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS company_deletion_idx ON company (deletion_effective_at) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS company_stripe_cust_idx ON company (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  ban_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS membership (
  id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'accountant', 'viewer', 'hr')),
  segments TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX IF NOT EXISTS membership_user_idx ON membership (user_id);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS account_user_idx ON account (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_provider_idx ON account (provider_id, account_id);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  active_organization_id TEXT REFERENCES company (id) ON DELETE SET NULL,
  impersonated_by TEXT REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session (user_id);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

CREATE TABLE IF NOT EXISTS invitation (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'accountant', 'viewer', 'hr')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'canceled', 'rejected', 'expired')),
  expires_at TEXT NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS invitation_org_idx ON invitation (organization_id, status);

CREATE TABLE IF NOT EXISTS two_factor (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  failed_verification_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  user_id TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS two_factor_user_idx ON two_factor (user_id);

CREATE TABLE IF NOT EXISTS passkey (
  id TEXT PRIMARY KEY,
  name TEXT,
  public_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  counter INTEGER NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  aaguid TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS passkey_user_idx ON passkey (user_id);

CREATE TABLE IF NOT EXISTS apikey (
  id TEXT PRIMARY KEY,
  name TEXT,
  start TEXT,
  prefix TEXT,
  key TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  refill_interval INTEGER,
  refill_amount INTEGER,
  last_refill_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  rate_limit_enabled INTEGER NOT NULL DEFAULT 0,
  rate_limit_time_window INTEGER,
  rate_limit_max INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  remaining INTEGER,
  last_request TEXT,
  expires_at TEXT,
  permissions TEXT,
  metadata TEXT,
  reference_id TEXT,
  config_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS apikey_key_idx ON apikey (key);
CREATE INDEX IF NOT EXISTS apikey_user_idx ON apikey (user_id);

CREATE TABLE IF NOT EXISTS jwks (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  alg TEXT,
  crv TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_client (
  id TEXT PRIMARY KEY,
  client_id TEXT UNIQUE,
  client_secret TEXT,
  client_discovery_id TEXT,
  disabled INTEGER DEFAULT 0,
  skip_consent INTEGER DEFAULT 0,
  enable_end_session INTEGER DEFAULT 0,
  subject_type TEXT,
  scopes TEXT,
  client_credentials_scopes TEXT,
  user_id TEXT REFERENCES app_user (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT,
  tos TEXT,
  policy TEXT,
  software_id TEXT,
  software_version TEXT,
  software_statement TEXT,
  redirect_uris TEXT,
  post_logout_redirect_uris TEXT,
  backchannel_logout_uri TEXT,
  backchannel_logout_session_required INTEGER,
  token_endpoint_auth_method TEXT,
  application_type TEXT,
  jwks TEXT,
  jwks_uri TEXT,
  grant_types TEXT,
  response_types TEXT,
  require_pkce INTEGER,
  dpop_bound_access_tokens INTEGER DEFAULT 0,
  public INTEGER DEFAULT 0,
  type TEXT,
  reference_id TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS oauth_resource (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  access_token_ttl INTEGER,
  refresh_token_ttl INTEGER,
  signing_algorithm TEXT,
  signing_key_id TEXT,
  allowed_scopes TEXT,
  custom_claims TEXT,
  dpop_bound_access_tokens_required INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  policy_version INTEGER DEFAULT 1,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_client_resource (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_refresh_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  session_id TEXT,
  user_id TEXT NOT NULL,
  reference_id TEXT,
  authorization_code_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked TEXT,
  rotated_at TEXT,
  rotation_replay_response TEXT,
  rotation_replay_expires_at TEXT,
  auth_time TEXT,
  confirmation TEXT,
  scopes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_client_assertion (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  jti TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_application (
  id TEXT PRIMARY KEY,
  name TEXT,
  icon TEXT,
  metadata TEXT,
  client_id TEXT UNIQUE,
  client_secret TEXT,
  redirect_urls TEXT NOT NULL,
  type TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES app_user (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_access_token (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE,
  access_token TEXT UNIQUE,
  refresh_token TEXT UNIQUE,
  session_id TEXT,
  reference_id TEXT,
  authorization_code_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  refresh_id TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  expires_at TEXT,
  revoked INTEGER DEFAULT 0,
  confirmation TEXT,
  client_id TEXT,
  user_id TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_consent (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reference_id TEXT,
  resources TEXT,
  requested_user_info_claims TEXT,
  scopes TEXT NOT NULL,
  consent_given INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS device_code (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  user_code TEXT NOT NULL,
  user_id TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  last_polled_at TEXT,
  polling_interval INTEGER,
  client_id TEXT,
  scope TEXT
);

CREATE TABLE IF NOT EXISTS operator_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL,
  target_company_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

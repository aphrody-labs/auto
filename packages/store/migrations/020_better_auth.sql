-- Better Auth 1.7 remplace la couche comptes maison (docs/AUTH.md).
-- Schéma de référence : `bunx auth@latest generate --config packages/tenancy/auth.cli.ts` sur une base à
-- jour de 019, colonnes en snake_case (CamelCasePlugin de Kysely). Les tables historiques sont reprises :
-- user = app_user, organization = tenant, member = membership, invitation = invitation.
-- Tables de la couche d'authentification : hors RLS, lues par le propriétaire du schéma (comme avant).

-- Utilisateurs --------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN name text;
UPDATE app_user SET name = split_part(email, '@', 1);
ALTER TABLE app_user ALTER COLUMN name SET NOT NULL;
ALTER TABLE app_user ALTER COLUMN name SET DEFAULT '';
ALTER TABLE app_user ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE app_user ADD COLUMN image text;
ALTER TABLE app_user ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app_user ADD COLUMN two_factor_enabled boolean DEFAULT false;
-- Plugin admin (console opérateur) : rôle global, bannissement.
ALTER TABLE app_user ADD COLUMN role text;
ALTER TABLE app_user ADD COLUMN banned boolean DEFAULT false;
ALTER TABLE app_user ADD COLUMN ban_reason text;
ALTER TABLE app_user ADD COLUMN ban_expires timestamptz;

-- Comptes de connexion : le mot de passe (hachage Bun.password, argon2id) passe dans `account`.
CREATE TABLE account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_id_idx ON account (user_id);
CREATE UNIQUE INDEX account_fournisseur ON account (provider_id, account_id);
INSERT INTO account (account_id, provider_id, user_id, password, created_at, updated_at)
  SELECT id::text, 'credential', id, password_hash, created_at, created_at FROM app_user;
ALTER TABLE app_user DROP COLUMN password_hash;

-- Entreprises (organization) ---------------------------------------------------
ALTER TABLE tenant ADD COLUMN slug text;
UPDATE tenant SET slug = siren || '-' || left(id::text, 8);
ALTER TABLE tenant ALTER COLUMN slug SET NOT NULL;
-- Entreprises créées hors Better Auth (scripts, tests) : identifiant aléatoire.
ALTER TABLE tenant ALTER COLUMN slug SET DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX tenant_slug_uidx ON tenant (slug);
ALTER TABLE tenant ADD COLUMN logo text;
ALTER TABLE tenant ADD COLUMN metadata text;

-- Adhésions (member) : identifiant propre, date d'adhésion, rôle « rh ».
ALTER TABLE membership ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE membership ADD CONSTRAINT membership_id_unique UNIQUE (id);
ALTER TABLE membership ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE membership DROP CONSTRAINT membership_role_check;
ALTER TABLE membership ADD CONSTRAINT membership_role_check
  CHECK (role IN ('owner', 'admin', 'comptable', 'lecture', 'rh'));
CREATE INDEX membership_user_id_idx ON membership (user_id);

-- Invitations : statut Better Auth ; l'identifiant sert de jeton. Les anciennes invitations en cours
-- gardent leur hash : le lien `/invitation#<jeton>` reste accepté (POST /v1/invitations/acceptation).
ALTER TABLE invitation ADD COLUMN status text NOT NULL DEFAULT 'pending';
UPDATE invitation SET status = CASE
  WHEN acceptee_at IS NOT NULL THEN 'accepted'
  WHEN revoquee_at IS NOT NULL OR expires_at <= now() THEN 'canceled'
  ELSE 'pending' END;
ALTER TABLE invitation ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE invitation DROP CONSTRAINT invitation_role_check;
ALTER TABLE invitation ADD CONSTRAINT invitation_role_check
  CHECK (role IN ('owner', 'admin', 'comptable', 'lecture', 'rh'));
DROP INDEX invitation_en_cours;
CREATE UNIQUE INDEX invitation_en_cours ON invitation (tenant_id, email) WHERE status = 'pending';

-- Sessions : reconnexion forcée (les anciennes sessions ne sont pas reprises). Entreprise active = tenant.
CREATE TABLE session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  active_organization_id uuid REFERENCES tenant ON DELETE SET NULL,
  impersonated_by uuid REFERENCES app_user ON DELETE SET NULL
);
CREATE INDEX session_user_id_idx ON session (user_id);

CREATE TABLE verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON verification (identifier);

-- Double authentification : les secrets actifs sont repris par migrerDeuxFacteurs (packages/tenancy,
-- au démarrage de l'API) ; les colonnes totp_* et code_secours restent la source de cette reprise.
CREATE TABLE two_factor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);
CREATE UNIQUE INDEX two_factor_user_id_idx ON two_factor (user_id);

CREATE TABLE passkey (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  public_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  credential_id text NOT NULL,
  counter integer NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text,
  created_at timestamptz,
  aaguid text
);
CREATE INDEX passkey_user_id_idx ON passkey (user_id);
CREATE INDEX passkey_credential_id_idx ON passkey (credential_id);

-- Clés d'API d'entreprise (référence = tenant, auteur dans metadata.userId) ; hash SHA-256 en base64url.
CREATE TABLE apikey (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id text NOT NULL DEFAULT 'default',
  name text,
  start text,
  reference_id uuid NOT NULL REFERENCES tenant ON DELETE CASCADE,
  prefix text,
  key text NOT NULL UNIQUE,
  refill_interval integer,
  refill_amount integer,
  last_refill_at timestamptz,
  enabled boolean DEFAULT true,
  rate_limit_enabled boolean DEFAULT false,
  rate_limit_time_window integer,
  rate_limit_max integer,
  request_count integer DEFAULT 0,
  remaining integer,
  last_request timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  permissions text,
  metadata text
);
CREATE INDEX apikey_config_id_idx ON apikey (config_id);
CREATE INDEX apikey_reference_id_idx ON apikey (reference_id);

-- Reprise des jetons `auto_…` : même SHA-256, de l'hexadécimal au base64url sans remplissage.
INSERT INTO apikey (name, reference_id, prefix, key, expires_at, created_at, updated_at, metadata)
  SELECT c.name, c.tenant_id, 'auto_',
    rtrim(translate(encode(decode(c.token_hash, 'hex'), 'base64'), '+/', '-_'), '='),
    c.expires_at, c.created_at, c.created_at, json_build_object('userId', c.user_id)::text
  FROM credential c WHERE c.kind = 'api' AND (c.expires_at IS NULL OR c.expires_at > now());
DROP TABLE credential;

-- OAuth 2.1 (plugin mcp, sur oauth-provider) et clés de signature (plugin jwt) -----------------
CREATE TABLE jwks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  alg text,
  crv text
);

CREATE TABLE oauth_client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  client_secret text,
  client_discovery_id text,
  disabled boolean,
  skip_consent boolean,
  enable_end_session boolean,
  subject_type text,
  scopes jsonb,
  client_credentials_scopes jsonb,
  user_id uuid REFERENCES app_user ON DELETE CASCADE,
  created_at timestamptz,
  updated_at timestamptz,
  name text,
  uri text,
  icon text,
  contacts jsonb,
  tos text,
  policy text,
  software_id text,
  software_version text,
  software_statement text,
  redirect_uris jsonb NOT NULL,
  post_logout_redirect_uris jsonb,
  backchannel_logout_uri text,
  backchannel_logout_session_required boolean,
  token_endpoint_auth_method text,
  application_type text,
  jwks text,
  jwks_uri text,
  grant_types jsonb,
  response_types jsonb,
  require_pkce boolean,
  dpop_bound_access_tokens boolean,
  reference_id text,
  metadata jsonb
);
CREATE INDEX oauth_client_user_id_idx ON oauth_client (user_id);

CREATE TABLE oauth_resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL UNIQUE,
  name text NOT NULL,
  access_token_ttl integer,
  refresh_token_ttl integer,
  signing_algorithm text,
  signing_key_id text,
  allowed_scopes jsonb,
  custom_claims jsonb,
  dpop_bound_access_tokens_required boolean,
  disabled boolean,
  created_at timestamptz,
  updated_at timestamptz,
  policy_version integer,
  metadata jsonb
);

CREATE TABLE oauth_client_resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  resource_id text NOT NULL REFERENCES oauth_resource (identifier) ON DELETE CASCADE,
  metadata jsonb,
  created_at timestamptz
);
CREATE INDEX oauth_client_resource_resource_id_idx ON oauth_client_resource (resource_id);
CREATE UNIQUE INDEX oauth_client_resource_client_id_resource_id_uidx ON oauth_client_resource (client_id, resource_id);

CREATE TABLE oauth_refresh_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  session_id uuid REFERENCES session ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  reference_id text,
  authorization_code_id text,
  resources jsonb,
  requested_user_info_claims jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revoked timestamptz,
  rotated_at timestamptz,
  rotation_replay_response text,
  rotation_replay_expires_at timestamptz,
  auth_time timestamptz,
  confirmation jsonb,
  scopes jsonb NOT NULL
);
CREATE INDEX oauth_refresh_token_client_id_idx ON oauth_refresh_token (client_id);
CREATE INDEX oauth_refresh_token_session_id_idx ON oauth_refresh_token (session_id);
CREATE INDEX oauth_refresh_token_user_id_idx ON oauth_refresh_token (user_id);
CREATE INDEX oauth_refresh_token_authorization_code_id_idx ON oauth_refresh_token (authorization_code_id);

CREATE TABLE oauth_access_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  session_id uuid REFERENCES session ON DELETE SET NULL,
  user_id uuid REFERENCES app_user ON DELETE CASCADE,
  reference_id text,
  authorization_code_id text,
  resources jsonb,
  requested_user_info_claims jsonb,
  refresh_id uuid REFERENCES oauth_refresh_token ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revoked timestamptz,
  confirmation jsonb,
  scopes jsonb NOT NULL
);
CREATE INDEX oauth_access_token_client_id_idx ON oauth_access_token (client_id);
CREATE INDEX oauth_access_token_session_id_idx ON oauth_access_token (session_id);
CREATE INDEX oauth_access_token_user_id_idx ON oauth_access_token (user_id);
CREATE INDEX oauth_access_token_authorization_code_id_idx ON oauth_access_token (authorization_code_id);
CREATE INDEX oauth_access_token_refresh_id_idx ON oauth_access_token (refresh_id);

CREATE TABLE oauth_consent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_user ON DELETE CASCADE,
  reference_id text,
  resources jsonb,
  requested_user_info_claims jsonb,
  scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX oauth_consent_client_id_idx ON oauth_consent (client_id);
CREATE INDEX oauth_consent_user_id_idx ON oauth_consent (user_id);

CREATE TABLE oauth_client_assertion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL
);

-- Limitation de débit partagée entre instances (rateLimit.storage = "database").
CREATE TABLE rate_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);

-- Schéma officiel du plugin deviceAuthorization de Better Auth 1.7.12 (RFC 8628).
CREATE TABLE device_code (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_code varchar(191) NOT NULL UNIQUE,
 user_code varchar(191) NOT NULL UNIQUE, user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('pending','approved','denied')),
 last_polled_at timestamptz, polling_interval integer, client_id text, scope text
);
CREATE INDEX device_code_expiration ON device_code(expires_at);
REVOKE ALL ON device_code FROM PUBLIC;

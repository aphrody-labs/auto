-- Abonnements webhook par tenant : chaque tenant reçoit ses propres événements signés, par exemple dans
-- son instance ou son espace n8n. Le secret de signature est chiffré au repos (clé dérivée du tenant).

CREATE TABLE webhook (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  url text NOT NULL CHECK (url ~ '^https?://'),
  -- Types d'événements reçus ; tableau vide : tous.
  types text[] NOT NULL DEFAULT '{}',
  secret_chiffre bytea NOT NULL,
  actif boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX webhook_tenant ON webhook (tenant_id) WHERE actif;

ALTER TABLE webhook ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook TO auto_app USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY worker ON webhook TO auto_worker USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook TO auto_app;
GRANT SELECT ON webhook TO auto_worker;

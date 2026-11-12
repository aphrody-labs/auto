-- Schéma initial : comptes (hors RLS) et données métier isolées par tenant (RLS).

-- Rôle applicatif sans privilège : chaque transaction métier fait SET LOCAL ROLE auto_app.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auto_app') THEN
    CREATE ROLE auto_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT auto_app TO CURRENT_USER;

CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant', true), '')::uuid $$;

-- Comptes ----------------------------------------------------------------

CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom text NOT NULL,
  siren text NOT NULL,
  siret text NOT NULL,
  adresse text NOT NULL DEFAULT '',
  tva_intracom text,
  franchise_tva boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  tenant_id uuid NOT NULL REFERENCES tenant ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'comptable', 'lecture')),
  PRIMARY KEY (tenant_id, user_id)
);

-- Sessions et jetons API : seul le hash SHA-256 du secret est stocké.
CREATE TABLE credential (
  token_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('session', 'api')),
  tenant_id uuid NOT NULL REFERENCES tenant ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  name text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Données métier -----------------------------------------------------------

CREATE TABLE client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text NOT NULL,
  siret text,
  adresse text NOT NULL,
  tva_intracom text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE produit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  designation text NOT NULL,
  prix_ht_cents bigint NOT NULL,
  tva smallint NOT NULL,
  unite text
);

CREATE TABLE compteur (
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  serie text NOT NULL,
  annee int NOT NULL,
  seq int NOT NULL,
  PRIMARY KEY (tenant_id, serie, annee)
);

CREATE TABLE document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('devis', 'facture', 'acompte', 'avoir')),
  statut text NOT NULL DEFAULT 'brouillon',
  numero text,
  serie text,
  annee int,
  seq int,
  data jsonb NOT NULL,
  ht_cents bigint NOT NULL,
  tva_cents bigint NOT NULL,
  ttc_cents bigint NOT NULL,
  emis_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, numero),
  UNIQUE (tenant_id, serie, annee, seq),
  CHECK ((statut = 'brouillon') = (numero IS NULL))
);
CREATE INDEX document_tenant_type ON document (tenant_id, type, created_at DESC);

-- Un document émis est figé : seuls le statut et updated_at peuvent changer ; jamais supprimé.
CREATE FUNCTION document_fige() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'brouillon' THEN RAISE EXCEPTION 'document émis : suppression interdite'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut <> 'brouillon' AND (
       NEW.data IS DISTINCT FROM OLD.data OR NEW.numero IS DISTINCT FROM OLD.numero
    OR NEW.type IS DISTINCT FROM OLD.type OR NEW.ttc_cents IS DISTINCT FROM OLD.ttc_cents
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.emis_at IS DISTINCT FROM OLD.emis_at) THEN
    RAISE EXCEPTION 'document émis : modification interdite (émettre un avoir)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_fige BEFORE UPDATE OR DELETE ON document FOR EACH ROW EXECUTE FUNCTION document_fige();

-- Piste d'audit en ajout seul, chaînée par SHA-256 par tenant.
CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor uuid,
  action text NOT NULL,
  ref text,
  payload jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_tenant ON audit (tenant_id, id);

CREATE FUNCTION audit_chaine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT hash INTO NEW.prev_hash FROM audit WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(NEW.prev_hash, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(
    NEW.prev_hash || '|' || NEW.tenant_id || '|' || NEW.at || '|' || coalesce(NEW.actor::text, '') || '|'
    || NEW.action || '|' || coalesce(NEW.ref, '') || '|' || NEW.payload::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chaine BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION audit_chaine();

CREATE FUNCTION audit_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit : ajout seul'; END $$;
CREATE TRIGGER audit_immuable BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION audit_immuable();

-- Isolation ------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client', 'produit', 'compteur', 'document', 'audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

-- tenant : isolé pour auto_app ; la couche d'authentification (propriétaire du schéma) le lit sans RLS.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant USING (id = app_tenant());

GRANT USAGE ON SCHEMA public TO auto_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON client, produit TO auto_app;
GRANT SELECT, INSERT, UPDATE ON compteur TO auto_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document TO auto_app;
GRANT SELECT, INSERT ON audit TO auto_app;
GRANT SELECT ON tenant TO auto_app;

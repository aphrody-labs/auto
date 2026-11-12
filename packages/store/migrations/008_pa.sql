-- L6 plateforme agréée : connexion par tenant (identifiants chiffrés, mandat), dépôts des factures
-- émises et statuts du cycle de vie (XP Z12-012), factures reçues, e-reporting.

-- Une PA connectée par tenant. Identifiants : AES-256-GCM (clé HKDF du secret maître et du tenant),
-- jamais en clair en base.
CREATE TABLE pa_connexion (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  plateforme text NOT NULL CHECK (plateforme IN ('mock', 'b2brouter')),
  identifiants bytea NOT NULL,
  mandat jsonb NOT NULL,
  mandat_reference text NOT NULL,
  connecte_par uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pa_depot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  document_id uuid NOT NULL,
  plateforme text NOT NULL,
  id_pa text NOT NULL,
  sha256 text NOT NULL,
  statut text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, plateforme, id_pa),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id) ON DELETE RESTRICT
);
-- Un seul dépôt vivant par facture ; un nouveau dépôt n'est possible qu'après un rejet.
CREATE UNIQUE INDEX pa_depot_actif ON pa_depot (tenant_id, document_id) WHERE statut <> 'rejetee';

-- Historique des statuts, en ajout seul ; un webhook rejoué ne crée pas de doublon.
CREATE TABLE pa_statut (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  depot_id uuid NOT NULL,
  statut text NOT NULL CHECK (statut IN ('deposee', 'emise', 'recue', 'mise_a_disposition', 'prise_en_charge',
    'approuvee', 'approuvee_partiellement', 'en_litige', 'suspendue', 'completee', 'refusee', 'paiement_transmis',
    'encaissee', 'rejetee', 'visee')),
  code smallint NOT NULL CHECK (code BETWEEN 200 AND 214),
  motif text,
  source text NOT NULL CHECK (source IN ('depot', 'webhook', 'synchro', 'vendeur')),
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, depot_id, statut, at),
  FOREIGN KEY (tenant_id, depot_id) REFERENCES pa_depot (tenant_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER pa_statut_immuable BEFORE UPDATE OR DELETE ON pa_statut FOR EACH ROW EXECUTE FUNCTION audit_immuable();

-- Factures reçues par la PA : fichier tel que reçu (ajout seul) et XML Factur-X extrait.
CREATE TABLE pa_recue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  plateforme text NOT NULL,
  id_pa text NOT NULL,
  sha256 text NOT NULL,
  taille int NOT NULL,
  contenu bytea NOT NULL,
  xml text,
  numero text,
  emetteur text,
  ttc_cents bigint,
  recue_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plateforme, id_pa)
);
CREATE INDEX pa_recue_date ON pa_recue (tenant_id, created_at DESC);
CREATE TRIGGER pa_recue_immuable BEFORE UPDATE OR DELETE ON pa_recue FOR EACH ROW EXECUTE FUNCTION audit_immuable();

CREATE TABLE pa_ereporting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  plateforme text NOT NULL,
  id_pa text NOT NULL,
  nature text NOT NULL CHECK (nature IN ('b2c', 'international')),
  periode text NOT NULL CHECK (periode ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  statut text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plateforme, id_pa)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pa_connexion', 'pa_depot', 'pa_statut', 'pa_recue', 'pa_ereporting'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON pa_connexion TO auto_app;
GRANT SELECT, INSERT, UPDATE ON pa_depot, pa_ereporting TO auto_app;
GRANT SELECT, INSERT ON pa_statut, pa_recue TO auto_app;

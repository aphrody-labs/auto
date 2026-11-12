-- Factures fournisseurs reçues (dépôt API, mail, PA) : fichier d'origine immuable et facture extraite.

CREATE TABLE fichier_recu (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text,
  type_mime text NOT NULL,
  sha256 text NOT NULL,
  taille int NOT NULL,
  contenu bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sha256)
);
CREATE TRIGGER fichier_recu_immuable BEFORE UPDATE OR DELETE ON fichier_recu FOR EACH ROW EXECUTE FUNCTION audit_immuable();

CREATE TABLE facture_recue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  fichier_id uuid NOT NULL,
  canal text NOT NULL CHECK (canal IN ('api', 'mail', 'pa')),
  source text CHECK (source IN ('facturx', 'ocr')),
  statut text NOT NULL CHECK (statut IN ('a_verifier', 'validee', 'rejetee')),
  -- Facture normalisée (@auto/ingest FactureRecue) ; null si l'extraction a échoué.
  data jsonb,
  anomalies jsonb NOT NULL DEFAULT '[]',
  fournisseur text,
  siren text,
  numero text,
  date_facture date,
  echeance date,
  ttc_cents bigint,
  motif text,
  decide_par uuid,
  decide_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fichier_id),
  FOREIGN KEY (tenant_id, fichier_id) REFERENCES fichier_recu (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX facture_recue_statut ON facture_recue (tenant_id, statut, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fichier_recu', 'facture_recue'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON fichier_recu TO auto_app;
GRANT SELECT, INSERT, UPDATE ON facture_recue TO auto_app;

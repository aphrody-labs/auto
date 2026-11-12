-- Exemplaires figés des documents émis (Factur-X des factures, PDF des devis) : ajout seul.
CREATE TABLE fichier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES document ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('facturx', 'pdf')),
  sha256 text NOT NULL,
  taille int NOT NULL,
  contenu bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, kind)
);

CREATE TRIGGER fichier_immuable BEFORE UPDATE OR DELETE ON fichier FOR EACH ROW EXECUTE FUNCTION audit_immuable();

ALTER TABLE fichier ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichier FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fichier USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON fichier TO auto_app;

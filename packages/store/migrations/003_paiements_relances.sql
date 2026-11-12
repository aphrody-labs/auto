-- Client enregistré rattaché au document, paiements et relances (ajout seul).

-- Références entre tables toujours dans le même tenant : une clé étrangère ne passe pas par la RLS,
-- elle compare donc aussi tenant_id.
ALTER TABLE document ADD CONSTRAINT document_tenant_id_uk UNIQUE (tenant_id, id);
ALTER TABLE client ADD CONSTRAINT client_tenant_id_uk UNIQUE (tenant_id, id);
ALTER TABLE fichier ADD CONSTRAINT fichier_document_tenant_fk
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE document ADD COLUMN client_id uuid;
ALTER TABLE document ADD CONSTRAINT document_client_fk
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE RESTRICT;
CREATE INDEX document_client ON document (tenant_id, client_id);
CREATE INDEX document_origine ON document (tenant_id, (data ->> 'origine')) WHERE type = 'avoir';

CREATE OR REPLACE FUNCTION document_fige() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'brouillon' THEN RAISE EXCEPTION 'document émis : suppression interdite'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut <> 'brouillon' AND (
       NEW.data IS DISTINCT FROM OLD.data OR NEW.numero IS DISTINCT FROM OLD.numero
    OR NEW.type IS DISTINCT FROM OLD.type OR NEW.ttc_cents IS DISTINCT FROM OLD.ttc_cents
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.emis_at IS DISTINCT FROM OLD.emis_at
    OR NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
    RAISE EXCEPTION 'document émis : modification interdite (émettre un avoir)';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE paiement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  document_id uuid NOT NULL,
  date date NOT NULL,
  montant_cents bigint NOT NULL CHECK (montant_cents > 0),
  mode text NOT NULL CHECK (mode IN ('virement', 'carte', 'cheque', 'especes', 'prelevement', 'autre')),
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX paiement_document ON paiement (tenant_id, document_id);
CREATE TRIGGER paiement_immuable BEFORE UPDATE OR DELETE ON paiement FOR EACH ROW EXECUTE FUNCTION audit_immuable();

CREATE TABLE relance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  document_id uuid NOT NULL,
  niveau smallint NOT NULL CHECK (niveau BETWEEN 1 AND 3),
  canal text NOT NULL CHECK (canal IN ('mail', 'courrier', 'telephone')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, niveau),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER relance_immuable BEFORE UPDATE OR DELETE ON relance FOR EACH ROW EXECUTE FUNCTION audit_immuable();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['paiement', 'relance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO auto_app', t);
  END LOOP;
END $$;

-- Documents de travail : chaque version référence une copie immuable, jamais un document comptable émis.
CREATE TABLE atelier_document (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
 nom text NOT NULL,format text NOT NULL CHECK(format IN ('word','excel','pdf')),
 segment text NOT NULL CHECK(segment IN ('clients','fournisseurs','chantiers','livraisons','commandes')),
 fichier_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),archive boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,fichier_id) REFERENCES fichier_recu(tenant_id,id)
);
CREATE TABLE atelier_revision (
 tenant_id uuid NOT NULL DEFAULT app_tenant(),document_id uuid NOT NULL,revision integer NOT NULL,
 fichier_id uuid NOT NULL,actor uuid,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id,revision),
 FOREIGN KEY(tenant_id,document_id) REFERENCES atelier_document(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,fichier_id) REFERENCES fichier_recu(tenant_id,id)
);
CREATE INDEX atelier_document_fichier ON atelier_document(tenant_id,fichier_id);
CREATE INDEX atelier_revision_fichier ON atelier_revision(tenant_id,fichier_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['atelier_document','atelier_revision'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO auto_app USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO auto_app',t);
 END LOOP;
END $$;

-- Organisation métier : tiers fournisseurs, chantiers, affectations analytiques et pièces d'achat.
-- Les affectations sont séparées des documents émis, dont l'exemplaire reste immuable.
CREATE TABLE fournisseur (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text NOT NULL CHECK (length(trim(nom)) > 0),
  adresse text NOT NULL DEFAULT '', siret text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
  telephone text NOT NULL DEFAULT '', contact text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  archive boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id)
);
CREATE INDEX fournisseur_nom ON fournisseur (tenant_id, nom);
CREATE TABLE chantier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text NOT NULL CHECK (length(trim(nom)) > 0),
  code text NOT NULL CHECK (length(trim(code)) > 0),
  client_id uuid NOT NULL, adresse text NOT NULL DEFAULT '',
  budget_ht_cents bigint NOT NULL DEFAULT 0 CHECK (budget_ht_cents >= 0),
  avancement integer NOT NULL DEFAULT 0 CHECK (avancement BETWEEN 0 AND 100),
  statut text NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('planifie', 'en_cours', 'termine', 'en_pause')),
  debut date, fin date, notes text NOT NULL DEFAULT '', archive boolean NOT NULL DEFAULT false,
  CHECK (fin IS NULL OR debut IS NULL OR fin >= debut),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id)
);
CREATE INDEX chantier_client ON chantier (tenant_id, client_id);
CREATE TABLE chantier_document (
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  document_id uuid NOT NULL, chantier_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, chantier_id) REFERENCES chantier (tenant_id, id)
);
CREATE INDEX chantier_document_chantier ON chantier_document (tenant_id, chantier_id);
ALTER TABLE facture_recue ADD CONSTRAINT facture_recue_tenant_id UNIQUE (tenant_id, id);
CREATE TABLE achat_affectation (
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  recue_id uuid NOT NULL, fournisseur_id uuid NOT NULL, chantier_id uuid,
  PRIMARY KEY (tenant_id, recue_id),
  FOREIGN KEY (tenant_id, recue_id) REFERENCES facture_recue (tenant_id, id),
  FOREIGN KEY (tenant_id, fournisseur_id) REFERENCES fournisseur (tenant_id, id),
  FOREIGN KEY (tenant_id, chantier_id) REFERENCES chantier (tenant_id, id)
);
CREATE INDEX achat_affectation_chantier ON achat_affectation (tenant_id, chantier_id);
CREATE INDEX achat_affectation_fournisseur ON achat_affectation (tenant_id, fournisseur_id);
CREATE TABLE piece_chantier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('bon_livraison', 'confirmation_commande')),
  reference text NOT NULL CHECK (length(trim(reference)) > 0),
  fournisseur_id uuid NOT NULL, chantier_id uuid NOT NULL, recue_id uuid,
  date date NOT NULL,
  statut text NOT NULL DEFAULT 'a_verifier' CHECK (statut IN ('a_verifier', 'valide', 'annule')),
  lignes jsonb NOT NULL CHECK (jsonb_typeof(lignes) = 'array'),
  notes text NOT NULL DEFAULT '', archive boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, fournisseur_id, type, reference),
  FOREIGN KEY (tenant_id, fournisseur_id) REFERENCES fournisseur (tenant_id, id),
  FOREIGN KEY (tenant_id, chantier_id) REFERENCES chantier (tenant_id, id),
  FOREIGN KEY (tenant_id, recue_id) REFERENCES facture_recue (tenant_id, id)
);
CREATE INDEX piece_chantier_chantier ON piece_chantier (tenant_id, chantier_id, date DESC);
CREATE INDEX piece_chantier_fournisseur ON piece_chantier (tenant_id, fournisseur_id);
CREATE INDEX piece_chantier_recue ON piece_chantier (tenant_id, recue_id) WHERE recue_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['fournisseur','chantier','chantier_document','achat_affectation','piece_chantier'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO auto_app USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO auto_app', t);
  END LOOP;
END $$;

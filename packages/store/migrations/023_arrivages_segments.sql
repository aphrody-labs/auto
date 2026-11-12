-- Permissions explicites et arrivages : aucun changement des anciennes migrations.
CREATE TABLE membre_segments (
 tenant_id uuid NOT NULL DEFAULT app_tenant(), user_id uuid NOT NULL,
 segments text[] NOT NULL CHECK (segments <@ ARRAY['clients','fournisseurs','chantiers','livraisons','commandes']::text[]),
 PRIMARY KEY (tenant_id,user_id),
 FOREIGN KEY (tenant_id,user_id) REFERENCES membership (tenant_id,user_id) ON DELETE CASCADE
);
CREATE TABLE devis_recu (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
 fichier_id uuid NOT NULL, statut text NOT NULL DEFAULT 'a_verifier' CHECK (statut IN ('a_verifier','valide','rejete')),
 data jsonb, anomalies jsonb NOT NULL DEFAULT '[]', texte text NOT NULL DEFAULT '',
 brouillon_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id), UNIQUE (tenant_id,fichier_id),
 FOREIGN KEY (tenant_id,fichier_id) REFERENCES fichier_recu (tenant_id,id),
 FOREIGN KEY (tenant_id,brouillon_id) REFERENCES document (tenant_id,id) ON DELETE SET NULL (brouillon_id)
);
CREATE TABLE source_fichiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
 nom text NOT NULL,racine text NOT NULL,sous_dossier text NOT NULL DEFAULT '',
 segment text NOT NULL CHECK (segment IN ('clients','fournisseurs','chantiers','livraisons','commandes')),
 traitement text NOT NULL CHECK (traitement IN ('index','facture','devis')),
 actif boolean NOT NULL DEFAULT true, synchronise_at timestamptz, erreur text, sync_token uuid, bail_jusqua timestamptz,
 UNIQUE (tenant_id,id), UNIQUE (tenant_id,racine,sous_dossier)
);
CREATE TABLE fichier_indexe (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
 source_id uuid NOT NULL, fichier_id uuid NOT NULL,chemin text NOT NULL,nom text NOT NULL,
 segment text NOT NULL CHECK (segment IN ('clients','fournisseurs','chantiers','livraisons','commandes')),
 texte text NOT NULL DEFAULT '',empreinte text NOT NULL,recue_id uuid,devis_id uuid,
 archive boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id), UNIQUE (tenant_id,source_id,chemin,empreinte),
 FOREIGN KEY (tenant_id,source_id) REFERENCES source_fichiers (tenant_id,id),
 FOREIGN KEY (tenant_id,fichier_id) REFERENCES fichier_recu (tenant_id,id),
 FOREIGN KEY (tenant_id,recue_id) REFERENCES facture_recue (tenant_id,id),
 FOREIGN KEY (tenant_id,devis_id) REFERENCES devis_recu (tenant_id,id)
);
CREATE INDEX fichier_indexe_source ON fichier_indexe (tenant_id,source_id);
CREATE INDEX fichier_indexe_fichier ON fichier_indexe (tenant_id,fichier_id);
CREATE INDEX fichier_indexe_recue ON fichier_indexe (tenant_id,recue_id);
CREATE INDEX fichier_indexe_devis ON fichier_indexe (tenant_id,devis_id);
CREATE INDEX devis_recu_brouillon ON devis_recu (tenant_id,brouillon_id);
CREATE INDEX source_fichiers_actives ON source_fichiers (tenant_id) WHERE actif;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['membre_segments','devis_recu','source_fichiers','fichier_indexe'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO auto_app USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO auto_app',t);
 END LOOP;
END $$;

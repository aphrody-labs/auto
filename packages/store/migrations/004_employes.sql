-- Employés et absences (congés, RTT, maladie…). Données personnelles : accès réservé au droit « rh ».

CREATE TABLE employe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text NOT NULL CHECK (btrim(nom) <> ''),
  prenom text NOT NULL CHECK (btrim(prenom) <> ''),
  email text,
  poste text NOT NULL,
  contrat text NOT NULL CHECK (contrat IN ('cdi', 'cdd', 'apprentissage', 'professionnalisation', 'stage', 'interim')),
  date_entree date NOT NULL,
  date_sortie date CHECK (date_sortie IS NULL OR date_sortie >= date_entree),
  temps_travail smallint NOT NULL CHECK (temps_travail BETWEEN 1 AND 100),
  salaire_brut_mensuel_cents bigint NOT NULL CHECK (salaire_brut_mensuel_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX employe_nom ON employe (tenant_id, nom, prenom);

CREATE TABLE absence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  employe_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('conges_payes', 'rtt', 'maladie', 'sans_solde', 'evenement_familial', 'autre')),
  debut date NOT NULL,
  fin date NOT NULL CHECK (fin >= debut),
  jours_ouvrables smallint NOT NULL CHECK (jours_ouvrables >= 0),
  statut text NOT NULL DEFAULT 'demandee' CHECK (statut IN ('demandee', 'validee', 'refusee', 'annulee')),
  motif text,
  decide_par uuid,
  decide_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employe_id) REFERENCES employe (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX absence_employe ON absence (tenant_id, employe_id, debut);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employe', 'absence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO auto_app', t);
  END LOOP;
END $$;

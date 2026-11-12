-- Automatisations (workflows) de chaque entreprise, leurs exécutions et leurs secrets. Le moteur est dans
-- packages/automate ; le worker exécute les workflows déclenchés par un événement, un cron ou un webhook.

CREATE TABLE automatisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text NOT NULL CHECK (length(nom) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  actif boolean NOT NULL DEFAULT false,
  definition jsonb NOT NULL,
  declencheur text NOT NULL CHECK (declencheur IN ('manuel', 'evenement', 'planifie', 'webhook')),
  -- Copies dénormalisées du déclencheur, pour l'aiguillage sans lire la définition.
  evenements text[] NOT NULL DEFAULT '{}',
  cron text,
  fuseau text,
  -- Auteur : les actions « auto » du workflow s'exécutent avec ses droits.
  created_by uuid REFERENCES app_user ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX automatisation_evenements ON automatisation USING gin (evenements) WHERE actif;
CREATE INDEX automatisation_planifiee ON automatisation (declencheur) WHERE actif AND declencheur = 'planifie';

CREATE TABLE execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  automatisation_id uuid NOT NULL,
  -- manuel, essai, evenement:<id>, planifie:<minute>, webhook
  origine text NOT NULL,
  statut text NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'succes', 'erreur')),
  etapes jsonb NOT NULL DEFAULT '[]',
  erreur text,
  debut timestamptz NOT NULL DEFAULT now(),
  fin timestamptz,
  FOREIGN KEY (tenant_id, automatisation_id) REFERENCES automatisation (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX execution_automatisation ON execution (automatisation_id, debut DESC);

-- Secrets cités par `{{ $secret.nom }}` : chiffrés au repos (clé dérivée du tenant), jamais relus par l'API.
CREATE TABLE secret_automatisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  nom text NOT NULL CHECK (nom ~ '^[a-z0-9_-]{1,60}$'),
  valeur_chiffree bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nom)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automatisation', 'execution', 'secret_automatisation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO auto_app USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    EXECUTE format('CREATE POLICY worker ON %I TO auto_worker USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO auto_app', t);
    EXECUTE format('GRANT SELECT ON %I TO auto_worker', t);
  END LOOP;
END $$;
GRANT INSERT, UPDATE ON execution TO auto_worker;

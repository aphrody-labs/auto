-- Outbox des événements et file de jobs du worker.
--
-- Un événement est ajouté dans la transaction de l'action métier (rôle auto_app, RLS) avec son job de
-- livraison : validé avec l'action, ou annulé avec elle. Le worker (rôle auto_worker) traite les jobs de
-- tous les tenants ; ses accès passent par une politique RLS dédiée, la RLS reste forcée.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auto_worker') THEN
    CREATE ROLE auto_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT auto_worker TO CURRENT_USER;

CREATE TABLE evenement (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  type text NOT NULL,
  -- Corps JSON exact envoyé et signé : identique d'un essai à l'autre.
  corps text NOT NULL,
  statut text NOT NULL DEFAULT 'a_livrer' CHECK (statut IN ('a_livrer', 'livre', 'echec')),
  essais int NOT NULL DEFAULT 0,
  derniere_erreur text,
  livre_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evenement_statut ON evenement (statut, created_at) WHERE statut <> 'livre';
CREATE INDEX evenement_tenant ON evenement (tenant_id, created_at DESC);

CREATE TABLE job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL : job système (planification), hors tenant.
  tenant_id uuid DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  -- Clé de dédoublonnage : un seul job par clé (ex. relances:2026-10-22).
  cle text UNIQUE,
  statut text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'en_cours', 'fait', 'echec')),
  essais int NOT NULL DEFAULT 0,
  max_essais int NOT NULL DEFAULT 10 CHECK (max_essais > 0),
  executer_apres timestamptz NOT NULL DEFAULT now(),
  bail_jusqua timestamptz,
  derniere_erreur text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_a_prendre ON job (executer_apres) WHERE statut IN ('en_attente', 'en_cours');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evenement', 'job'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO auto_app USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    EXECUTE format('CREATE POLICY worker ON %I TO auto_worker USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO auto_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO auto_worker', t);
  END LOOP;
END $$;

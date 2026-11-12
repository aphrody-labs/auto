-- Versions d'un workflow : l'état précédent (nom, description, définition) est conservé à chaque modification de
-- son contenu, et peut être restauré. 50 versions par workflow au plus, les plus anciennes sont effacées.

CREATE TABLE automatisation_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  automatisation_id uuid NOT NULL,
  numero integer NOT NULL CHECK (numero > 0),
  nom text NOT NULL,
  description text NOT NULL DEFAULT '',
  definition jsonb NOT NULL,
  auteur uuid REFERENCES app_user ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automatisation_id, numero),
  FOREIGN KEY (tenant_id, automatisation_id) REFERENCES automatisation (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX automatisation_version_recentes ON automatisation_version (automatisation_id, numero DESC);

ALTER TABLE automatisation_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE automatisation_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automatisation_version TO auto_app
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, DELETE ON automatisation_version TO auto_app;

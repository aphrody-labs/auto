-- Base de connaissances par entreprise (RAG des automatisations) : morceaux de documents et leur vecteur
-- (embedding). Nœuds « Indexer dans la base de connaissances » et « Rechercher dans la base de connaissances » ;
-- découpage et recherche par la bibliothèque native (crate auto-connaissance, aphrody-rag-core).

CREATE TABLE connaissance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  base text NOT NULL CHECK (base ~ '^[a-z0-9_-]{1,60}$'),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 300),
  position integer NOT NULL CHECK (position >= 0),
  morceau text NOT NULL CHECK (length(morceau) BETWEEN 1 AND 20000),
  -- f32 little-endian bout à bout (lu tel quel par la recherche native) : 8 192 composantes au plus.
  vecteur bytea NOT NULL CHECK (octet_length(vecteur) BETWEEN 4 AND 32768 AND octet_length(vecteur) % 4 = 0),
  modele text NOT NULL CHECK (length(modele) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Sert aussi d'index (tenant_id, base) et (tenant_id, base, source).
  UNIQUE (tenant_id, base, source, position)
);

ALTER TABLE connaissance ENABLE ROW LEVEL SECURITY;
ALTER TABLE connaissance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connaissance TO auto_app
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY worker ON connaissance TO auto_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON connaissance TO auto_app;
GRANT SELECT ON connaissance TO auto_worker;

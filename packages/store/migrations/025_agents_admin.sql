-- Accès d'administration nominatifs des agents : jetons uniquement hachés, révocables, jamais sessions humaines.
CREATE TABLE agent_admin (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proprietaire_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 nom text NOT NULL CHECK (length(nom) BETWEEN 1 AND 100), empreinte text NOT NULL UNIQUE,
 actif boolean NOT NULL DEFAULT true, expire_at timestamptz NOT NULL,
 dernier_acces timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_admin_proprietaire ON agent_admin(proprietaire_id,created_at DESC);
CREATE TABLE agent_admin_journal (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, agent_id uuid NOT NULL REFERENCES agent_admin(id),
 methode text NOT NULL, route text NOT NULL, statut int NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_admin_journal_recent ON agent_admin_journal(agent_id,created_at DESC);
REVOKE ALL ON agent_admin,agent_admin_journal FROM PUBLIC;

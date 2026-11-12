-- Comptes : invitations par mail, double authentification TOTP, codes de secours.
-- Tables de la couche d'authentification (comme membership et credential) : lues par le propriétaire
-- du schéma avant qu'un tenant soit connu (acceptation d'une invitation, second facteur).

-- Défi du second facteur : jeton court, entre le mot de passe et le code TOTP. Il n'ouvre aucune route.
ALTER TABLE credential DROP CONSTRAINT credential_kind_check;
ALTER TABLE credential ADD CONSTRAINT credential_kind_check CHECK (kind IN ('session', 'api', 'mfa'));
ALTER TABLE credential ADD COLUMN tentatives smallint NOT NULL DEFAULT 0;

-- Secret TOTP chiffré (AES-GCM, clé dérivée de AUTO_CLE_MAITRE) ; dernier pas accepté contre le rejeu.
ALTER TABLE app_user ADD COLUMN totp_secret bytea;
ALTER TABLE app_user ADD COLUMN totp_actif boolean NOT NULL DEFAULT false;
ALTER TABLE app_user ADD COLUMN totp_dernier_pas bigint;
ALTER TABLE app_user ADD CONSTRAINT totp_actif_secret CHECK (NOT totp_actif OR totp_secret IS NOT NULL);

-- Codes de secours à usage unique : seul le SHA-256 est conservé (codes aléatoires de 50 bits).
CREATE TABLE code_secours (
  user_id uuid NOT NULL REFERENCES app_user ON DELETE CASCADE,
  hash text NOT NULL,
  utilise_at timestamptz,
  PRIMARY KEY (user_id, hash)
);

-- Invitation : jeton à usage unique (hash SHA-256), 7 jours, révocable.
CREATE TABLE invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'comptable', 'lecture')),
  token_hash text NOT NULL UNIQUE,
  invite_par uuid REFERENCES app_user ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  acceptee_at timestamptz,
  acceptee_par uuid REFERENCES app_user ON DELETE SET NULL,
  revoquee_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (acceptee_at IS NULL OR revoquee_at IS NULL)
);
CREATE INDEX invitation_tenant ON invitation (tenant_id, created_at DESC);
-- Une seule invitation en cours par email et entreprise.
CREATE UNIQUE INDEX invitation_en_cours ON invitation (tenant_id, email)
  WHERE acceptee_at IS NULL AND revoquee_at IS NULL;

-- Comme tenant : isolée pour auto_app, lue sans RLS par la couche d'authentification.
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitation USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT ON invitation TO auto_app;

-- Lot mail : boîte IMAP/SMTP du tenant (identifiants chiffrés AES-256-GCM), messages reçus et pièces jointes.

CREATE TABLE boite_mail (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  adresse text NOT NULL CHECK (adresse ~ '^[^\s@]+@[^\s@]+$'),
  nom text,
  fournisseur text,
  imap_hote text NOT NULL,
  imap_port int NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
  imap_securite text NOT NULL CHECK (imap_securite IN ('tls', 'starttls', 'aucune')),
  smtp_hote text NOT NULL,
  smtp_port int NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_securite text NOT NULL CHECK (smtp_securite IN ('tls', 'starttls', 'aucune')),
  certificat_non_verifie boolean NOT NULL DEFAULT false,
  dossier text NOT NULL DEFAULT 'INBOX',
  -- Empreinte du compte relevé (hôte, utilisateur, dossier) : clé d'idempotence avec UIDVALIDITY et UID.
  source text NOT NULL,
  -- version ‖ nonce ‖ AES-256-GCM(JSON { utilisateur, motDePasse }), clé HKDF(AUTO_CLE_MAITRE, tenant).
  identifiants bytea NOT NULL,
  uid_validity bigint,
  dernier_uid bigint NOT NULL DEFAULT 0,
  releve_at timestamptz,
  erreur text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_recu (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  source text NOT NULL,
  uid_validity bigint NOT NULL,
  uid bigint NOT NULL,
  message_id text,
  expediteur text,
  destinataires text[] NOT NULL DEFAULT '{}',
  sujet text NOT NULL DEFAULT '',
  date_envoi timestamptz,
  extrait text NOT NULL DEFAULT '',
  taille int NOT NULL,
  sha256 text NOT NULL,
  classement text NOT NULL CHECK (classement IN ('facture', 'autre')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, uid_validity, uid),
  UNIQUE (tenant_id, id)
);
CREATE INDEX mail_recu_date ON mail_recu (tenant_id, created_at DESC);

CREATE TABLE mail_piece (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  mail_id uuid NOT NULL,
  rang smallint NOT NULL,
  nom text NOT NULL,
  type text NOT NULL,
  taille int NOT NULL,
  sha256 text NOT NULL,
  facturx boolean NOT NULL DEFAULT false,
  contenu bytea NOT NULL,
  UNIQUE (mail_id, rang),
  FOREIGN KEY (tenant_id, mail_id) REFERENCES mail_recu (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['boite_mail', 'mail_recu', 'mail_piece'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON boite_mail TO auto_app;
GRANT SELECT, INSERT ON mail_recu, mail_piece TO auto_app;

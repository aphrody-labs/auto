-- Boîte privée à l'utilisateur : distincte de la boîte métier partagée du tenant.
CREATE TABLE courrier_compte (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT app_tenant(),
 user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 fournisseur text NOT NULL CHECK (fournisseur IN ('google','microsoft','ovh')),
 adresse text NOT NULL, secret bytea NOT NULL, curseur jsonb NOT NULL DEFAULT '{}',
 synchronise_at timestamptz, erreur text, actif boolean NOT NULL DEFAULT true,
 verrou_jusqua timestamptz, verrou text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,user_id,fournisseur,adresse), UNIQUE(tenant_id,user_id,id)
);
CREATE TABLE courrier_message (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT app_tenant(), user_id uuid NOT NULL,
 compte_id uuid NOT NULL, distant_id text NOT NULL, message_id text, expediteur text NOT NULL DEFAULT '',
 destinataires text[] NOT NULL DEFAULT '{}', sujet text NOT NULL DEFAULT '', texte text NOT NULL DEFAULT '',
 date_envoi timestamptz NOT NULL DEFAULT now(), lu boolean NOT NULL DEFAULT false,
 dossier text NOT NULL DEFAULT 'reception' CHECK (dossier IN ('reception','envoyes')),
 present boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,user_id,compte_id) REFERENCES courrier_compte(tenant_id,user_id,id) ON DELETE CASCADE,
 UNIQUE(compte_id,distant_id), UNIQUE(tenant_id,user_id,id)
);
CREATE INDEX courrier_message_liste ON courrier_message(tenant_id,user_id,date_envoi DESC,id DESC) WHERE present;
CREATE TABLE courrier_piece (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL DEFAULT app_tenant(), user_id uuid NOT NULL,
 message_id uuid NOT NULL, rang int NOT NULL, nom text NOT NULL, type text NOT NULL, contenu bytea NOT NULL,
 FOREIGN KEY(tenant_id,user_id,message_id) REFERENCES courrier_message(tenant_id,user_id,id) ON DELETE CASCADE, UNIQUE(message_id,rang)
);
CREATE TABLE courrier_oauth (
 empreinte text PRIMARY KEY, tenant_id uuid NOT NULL DEFAULT app_tenant(), user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 fournisseur text NOT NULL CHECK (fournisseur IN ('google','microsoft')), secret bytea NOT NULL,
 expire_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['courrier_compte','courrier_message','courrier_piece','courrier_oauth'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY courrier_prive ON %I USING (tenant_id=app_tenant() AND user_id=NULLIF(current_setting(''app.courrier_user'',true),'''')::uuid) WITH CHECK (tenant_id=app_tenant() AND user_id=NULLIF(current_setting(''app.courrier_user'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO auto_app',t);
 END LOOP;
END $$;

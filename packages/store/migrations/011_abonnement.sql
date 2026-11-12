-- Abonnement : état Stripe et consommation par tenant (RLS) ; journal des événements Stripe (opérateur).

CREATE TABLE abonnement (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'gratuit' CHECK (plan IN ('gratuit', 'pro', 'business')),
  periodicite text CHECK (periodicite IN ('mensuel', 'annuel')),
  -- 'aucun' : jamais souscrit ; sinon statut de l'abonnement Stripe.
  statut text NOT NULL DEFAULT 'aucun' CHECK (statut IN ('aucun', 'incomplete', 'incomplete_expired', 'trialing',
    'active', 'past_due', 'unpaid', 'canceled', 'paused')),
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  essai_utilise boolean NOT NULL DEFAULT false,
  essai_fin timestamptz,
  periode_fin timestamptz,
  annulation_fin_periode boolean NOT NULL DEFAULT false,
  -- Date Stripe (`created`) du dernier événement d'abonnement appliqué : un événement plus ancien est ignoré.
  stripe_maj timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Compteurs mensuels (période AAAA-MM, fuseau de Paris).
CREATE TABLE consommation (
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  periode text NOT NULL CHECK (periode ~ '^[0-9]{4}-[0-9]{2}$'),
  ressource text NOT NULL CHECK (ressource IN ('factures', 'appels_llm')),
  quantite bigint NOT NULL DEFAULT 0 CHECK (quantite >= 0),
  PRIMARY KEY (tenant_id, periode, ressource)
);

-- Une facture ou un acompte qui quitte l'état brouillon compte dans le mois de son émission,
-- dans la transaction de l'émission (pas de compteur à tenir à jour côté application).
CREATE FUNCTION consommation_facture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.statut = 'brouillon' AND NEW.statut <> 'brouillon' AND NEW.type IN ('facture', 'acompte') THEN
    INSERT INTO consommation (tenant_id, periode, ressource, quantite)
    VALUES (NEW.tenant_id, to_char(coalesce(NEW.emis_at, now()) AT TIME ZONE 'Europe/Paris', 'YYYY-MM'), 'factures', 1)
    ON CONFLICT (tenant_id, periode, ressource) DO UPDATE SET quantite = consommation.quantite + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consommation_facture AFTER UPDATE OF statut ON document
  FOR EACH ROW EXECUTE FUNCTION consommation_facture();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['abonnement', 'consommation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO auto_app', t);
  END LOOP;
END $$;

-- Événements Stripe reçus (opérateur, hors RLS, aucun droit pour auto_app) : l'identifiant d'événement
-- rend le traitement idempotent ; une facture Stripe payée ne donne qu'une facture émise.
CREATE TABLE stripe_evenement (
  id text PRIMARY KEY,
  type text NOT NULL,
  cree_at timestamptz NOT NULL,
  recu_at timestamptz NOT NULL DEFAULT now(),
  resultat text NOT NULL DEFAULT 'en_cours',
  tenant_id uuid REFERENCES tenant ON DELETE SET NULL,
  objet_id text,
  document_id uuid
);
CREATE UNIQUE INDEX stripe_evenement_facture ON stripe_evenement (objet_id)
  WHERE type = 'invoice.paid' AND document_id IS NOT NULL;

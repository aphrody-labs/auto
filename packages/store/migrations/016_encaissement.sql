-- Paiement en ligne des factures : chaque tenant encaisse sur son propre compte Stripe (clé secrète chiffrée au
-- repos, clé dérivée du tenant). Un paiement en ligne porte la référence `stripe:<session>` : unique par tenant,
-- il n'est jamais enregistré deux fois (retour du client rejoué, double clic).

CREATE TABLE encaissement (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  fournisseur text NOT NULL DEFAULT 'stripe' CHECK (fournisseur IN ('stripe')),
  cle_chiffree bytea NOT NULL,
  -- Quatre derniers caractères de la clé, pour l'affichage (« sk_live_…a1b2 »).
  apercu text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE encaissement ENABLE ROW LEVEL SECURITY;
ALTER TABLE encaissement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON encaissement TO auto_app USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON encaissement TO auto_app;

CREATE UNIQUE INDEX paiement_en_ligne ON paiement (tenant_id, reference) WHERE reference LIKE 'stripe:%';

-- Conformité : suppression d'un tenant avec délai de grâce, conservation légale, archivage objet.
--
-- Règle de conservation (voir packages/store/src/conformite.ts et docs/conformite/) :
-- les pièces comptables (factures, avoirs, acomptes émis, leurs exemplaires figés, paiements, relances,
-- piste d'audit, compteurs) sont conservées 10 ans à compter de la clôture de l'exercice
-- (art. L123-22 du Code de commerce ; 6 ans au titre de l'art. L102 B du LPF, couverts par les 10 ans).
-- Le reste (comptes, membres, brouillons, produits, RH, clients non facturés) est supprimé à la fin du
-- délai de grâce ; les fiches clients facturés sont pseudonymisées (la facture garde ses mentions légales).

ALTER TABLE tenant ADD COLUMN suppression_demandee_at timestamptz;
ALTER TABLE tenant ADD COLUMN suppression_demandee_par uuid;
ALTER TABLE tenant ADD COLUMN suppression_effective_at timestamptz;
ALTER TABLE tenant ADD COLUMN supprime_at timestamptz;
-- Fin de la conservation légale : après cette date, la purge efface définitivement le tenant.
ALTER TABLE tenant ADD COLUMN conservation_jusqua date;
CREATE INDEX tenant_suppression ON tenant (suppression_effective_at) WHERE supprime_at IS NULL;

-- Exception unique à l'immuabilité : la purge d'un tenant dont la conservation légale est échue,
-- demandée explicitement dans la transaction (app.purge = id du tenant).
CREATE FUNCTION purge_autorisee(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.purge', true) = t::text
    AND EXISTS (SELECT 1 FROM tenant WHERE id = t AND conservation_jusqua < current_date)
$$;

CREATE OR REPLACE FUNCTION audit_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND purge_autorisee(OLD.tenant_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit : ajout seul';
END $$;

CREATE OR REPLACE FUNCTION document_fige() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'brouillon' AND NOT purge_autorisee(OLD.tenant_id) THEN
      RAISE EXCEPTION 'document émis : suppression interdite';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut <> 'brouillon' AND (
       NEW.data IS DISTINCT FROM OLD.data OR NEW.numero IS DISTINCT FROM OLD.numero
    OR NEW.type IS DISTINCT FROM OLD.type OR NEW.ttc_cents IS DISTINCT FROM OLD.ttc_cents
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.emis_at IS DISTINCT FROM OLD.emis_at
    OR NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
    RAISE EXCEPTION 'document émis : modification interdite (émettre un avoir)';
  END IF;
  RETURN NEW;
END $$;

-- Copie des exemplaires figés en stockage objet à verrou (S3 Object Lock) : ajout seul.
ALTER TABLE fichier ADD CONSTRAINT fichier_tenant_id_uk UNIQUE (tenant_id, id);

CREATE TABLE archive_objet (
  tenant_id uuid NOT NULL DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  fichier_id uuid NOT NULL,
  cle text NOT NULL,
  sha256 text NOT NULL,
  conserver_jusqua date NOT NULL,
  archive_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fichier_id),
  FOREIGN KEY (tenant_id, fichier_id) REFERENCES fichier (tenant_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER archive_objet_immuable BEFORE UPDATE OR DELETE ON archive_objet
  FOR EACH ROW EXECUTE FUNCTION audit_immuable();

ALTER TABLE archive_objet ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_objet FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON archive_objet USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON archive_objet TO auto_app;

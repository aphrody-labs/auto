-- Gabarit des documents par tenant : couleur d'accent, logo (JPEG RVB) et ligne de pied de page.

CREATE TABLE gabarit (
  tenant_id uuid PRIMARY KEY DEFAULT app_tenant() REFERENCES tenant ON DELETE CASCADE,
  couleur text CHECK (couleur ~ '^#[0-9A-Fa-f]{6}$'),
  logo bytea CHECK (logo IS NULL OR octet_length(logo) <= 1048576),
  logo_largeur integer CHECK (logo_largeur > 0),
  logo_hauteur integer CHECK (logo_hauteur > 0),
  pied_de_page text CHECK (char_length(pied_de_page) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((logo IS NULL) = (logo_largeur IS NULL) AND (logo IS NULL) = (logo_hauteur IS NULL))
);

ALTER TABLE gabarit ENABLE ROW LEVEL SECURITY;
ALTER TABLE gabarit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gabarit USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON gabarit TO auto_app;

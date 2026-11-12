// Gabarit des documents par tenant (lot L4) : appliqué au rendu PDF des brouillons et à l'émission.
import type { Gabarit } from "@auto/domain";
import type { Tx } from "./db";
import { ErreurMetier, journaliser } from "./index";

interface GabaritRow {
  couleur: string | null;
  logo: Uint8Array | null;
  logo_largeur: number | null;
  logo_hauteur: number | null;
  pied_de_page: string | null;
}

/** Gabarit du tenant courant ; `undefined` s'il n'a rien personnalisé. */
export async function lireGabarit(tx: Tx): Promise<Gabarit | undefined> {
  const [r] = await tx<GabaritRow[]>`SELECT couleur, logo, logo_largeur, logo_hauteur, pied_de_page FROM gabarit`;
  if (!r) return undefined;
  return {
    couleur: r.couleur ?? undefined,
    piedDePage: r.pied_de_page ?? undefined,
    logo: r.logo
      ? { jpeg: new Uint8Array(r.logo).toBase64(), largeur: r.logo_largeur!, hauteur: r.logo_hauteur! }
      : undefined,
  };
}

export async function enregistrerGabarit(
  tx: Tx,
  actor: string | null,
  g: { couleur?: string | null; piedDePage?: string | null },
): Promise<void> {
  if (g.couleur && !/^#[0-9A-Fa-f]{6}$/.test(g.couleur)) throw new ErreurMetier("couleur au format #RRGGBB");
  if (g.piedDePage && g.piedDePage.length > 200) throw new ErreurMetier("pied de page : 200 caractères au plus");
  await tx`INSERT INTO gabarit (couleur, pied_de_page) VALUES (${g.couleur ?? null}, ${g.piedDePage?.trim() || null})
    ON CONFLICT (tenant_id) DO UPDATE SET couleur = EXCLUDED.couleur, pied_de_page = EXCLUDED.pied_de_page, updated_at = now()`;
  await journaliser(tx, actor, "gabarit.modifier", null, { couleur: g.couleur ?? null });
}

/** Logo déjà converti en JPEG RVB ; `null` le retire. */
export async function enregistrerLogo(
  tx: Tx,
  actor: string | null,
  logo: { jpeg: Uint8Array; largeur: number; hauteur: number } | null,
): Promise<void> {
  const [jpeg, l, h] = logo ? [logo.jpeg, logo.largeur, logo.hauteur] : [null, null, null];
  await tx`INSERT INTO gabarit (logo, logo_largeur, logo_hauteur) VALUES (${jpeg}, ${l}, ${h})
    ON CONFLICT (tenant_id) DO UPDATE SET logo = EXCLUDED.logo, logo_largeur = EXCLUDED.logo_largeur,
      logo_hauteur = EXCLUDED.logo_hauteur, updated_at = now()`;
  await journaliser(tx, actor, logo ? "gabarit.logo" : "gabarit.logo_retire", null);
}

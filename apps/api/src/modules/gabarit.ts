// Lot L4 : gabarit des documents par tenant (couleur d'accent, logo, pied de page).
import { enregistrerGabarit, enregistrerLogo, ErreurMetier, lireGabarit, withTenant } from "@auto/store";
import type { Module } from "../modules";
import { brut, objet, op, str } from "../openapi-outils";
import type { Chemins } from "../modules";

/** Largeur maximale du logo stocké (pixels) : assez pour l'impression à 48 pt de haut. */
const LARGEUR_LOGO = 600;
const MAX_OCTETS = 5 * 1024 * 1024;

/** Image quelconque (PNG, JPEG, WebP…) → JPEG RVB réduit, prêt à embarquer tel quel dans le PDF. */
export async function preparerLogo(
  octets: Uint8Array,
): Promise<{ jpeg: Uint8Array; largeur: number; hauteur: number }> {
  if (octets.length > MAX_OCTETS) throw new ErreurMetier("logo trop volumineux (5 Mo au plus)", [], 413);
  try {
    const source = new Bun.Image(octets.slice(), { maxPixels: 40_000_000 });
    const m = await source.metadata();
    const largeur = Math.min(LARGEUR_LOGO, m.width);
    const hauteur = Math.max(1, Math.round((m.height * largeur) / m.width));
    const jpeg = await new Bun.Image(octets.slice()).resize(largeur, hauteur).jpeg({ quality: 90 }).bytes();
    return { jpeg, largeur, hauteur };
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    throw new ErreurMetier("logo : image illisible (PNG, JPEG ou WebP attendu)");
  }
}

export const routes: Module = ({ sql, auth }) => ({
  "/v1/parametres/gabarit": {
    GET: auth("lire", async (_req, a) => {
      const g = await withTenant(sql, a.tenantId, (tx) => lireGabarit(tx));
      return Response.json({
        couleur: g?.couleur ?? null,
        piedDePage: g?.piedDePage ?? null,
        logo: g?.logo ? { largeur: g.logo.largeur, hauteur: g.logo.hauteur } : null,
      });
    }),
    PUT: auth("parametres", async (req, a) => {
      const b = (await req.json()) as { couleur?: string | null; piedDePage?: string | null };
      await withTenant(sql, a.tenantId, (tx) => enregistrerGabarit(tx, a.userId, b));
      return new Response(null, { status: 204 });
    }),
  },
  "/v1/parametres/gabarit/logo": {
    GET: auth("lire", async (_req, a) => {
      const g = await withTenant(sql, a.tenantId, (tx) => lireGabarit(tx));
      if (!g?.logo) return Response.json({ erreur: "aucun logo" }, { status: 404 });
      return new Response(Uint8Array.fromBase64(g.logo.jpeg), { headers: { "content-type": "image/jpeg" } });
    }),
    PUT: auth("parametres", async (req, a) => {
      const { image } = (await req.json()) as { image?: string };
      if (typeof image !== "string") throw new ErreurMetier("image (base64) manquante");
      const logo = await preparerLogo(Uint8Array.fromBase64(image));
      await withTenant(sql, a.tenantId, (tx) => enregistrerLogo(tx, a.userId, logo));
      return Response.json({ largeur: logo.largeur, hauteur: logo.hauteur });
    }),
    DELETE: auth("parametres", async (_req, a) => {
      await withTenant(sql, a.tenantId, (tx) => enregistrerLogo(tx, a.userId, null));
      return new Response(null, { status: 204 });
    }),
  },
});

/** Description OpenAPI des routes du lot. */
export const openapi: Chemins = {
  "/v1/parametres/gabarit": {
    get: op({
      resume: "Gabarit des documents (couleur, pied de page, dimensions du logo)",
      tag: "Paramètres",
      droit: "lire",
      succes: {
        200: objet({
          couleur: str,
          piedDePage: str,
          logo: objet({ largeur: { type: "integer" }, hauteur: { type: "integer" } }),
        }),
      },
    }),
    put: op({
      resume: "Modifier la couleur d'accent et le pied de page",
      tag: "Paramètres",
      droit: "parametres",
      corps: objet({
        couleur: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        piedDePage: { type: "string", maxLength: 200 },
      }),
      succes: { 204: null },
      erreurs: [422],
    }),
  },
  "/v1/parametres/gabarit/logo": {
    get: op({
      resume: "Logo (JPEG)",
      tag: "Paramètres",
      droit: "lire",
      succes: { 200: brut("image/jpeg") },
      erreurs: [404],
    }),
    put: op({
      resume: "Déposer un logo (PNG, JPEG ou WebP, converti en JPEG RVB de 600 px de large au plus)",
      tag: "Paramètres",
      droit: "parametres",
      corps: objet({ image: { type: "string", contentEncoding: "base64" } }, ["image"]),
      succes: { 200: objet({ largeur: { type: "integer" }, hauteur: { type: "integer" } }) },
      erreurs: [413, 422],
    }),
    delete: op({ resume: "Retirer le logo", tag: "Paramètres", droit: "parametres", succes: { 204: null } }),
  },
};

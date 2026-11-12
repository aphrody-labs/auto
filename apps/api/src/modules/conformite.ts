// Lot conformité : export RGPD, suppression de l'entreprise, archivage objet (voir modules.ts).
import {
  annulerSuppression,
  archiverFichiers,
  demanderSuppression,
  ErreurMetier,
  etatSuppression,
  exporterTenant,
  s3DepuisEnv,
} from "@auto/store";
import { entreprise, verifierMotDePasse, type Auth } from "@auto/tenancy";
import type { Module } from "../modules";
import { brut, objet, op, str } from "../openapi-outils";
import type { Chemins } from "../modules";

const owner = (a: Auth) => {
  if (a.role !== "owner") throw new ErreurMetier("réservé au owner de l'entreprise", [], 403);
};

export const routes: Module = ({ sql, auth }) => ({
  "/v1/conformite/export": {
    GET: auth("parametres", async (_req, a) => {
      const archive = await exporterTenant(sql, a.tenantId);
      const jour = new Date().toISOString().slice(0, 10);
      return new Response(archive, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="auto-export-${jour}.tar.gz"`,
          "cache-control": "no-store",
        },
      });
    }),
  },

  // Suppression : owner, nom exact de l'entreprise et mot de passe ; exécutée après le délai de grâce.
  "/v1/conformite/suppression": {
    GET: auth("lire", async (_req, a) => Response.json(await etatSuppression(sql, a.tenantId))),
    POST: auth("parametres", async (req, a) => {
      owner(a);
      const { confirmation, motDePasse } = ((await req.json()) ?? {}) as { confirmation?: string; motDePasse?: string };
      const e = await entreprise(sql, a.tenantId);
      if (confirmation?.trim() !== e.nom)
        throw new ErreurMetier("confirmation : saisir le nom exact de l'entreprise", [e.nom]);
      await verifierMotDePasse(sql, a.userId, motDePasse ?? "");
      return Response.json(await demanderSuppression(sql, a.tenantId, a.userId), { status: 202 });
    }),
    DELETE: auth("parametres", async (_req, a) => {
      owner(a);
      return Response.json(await annulerSuppression(sql, a.tenantId, a.userId));
    }),
  },

  "/v1/conformite/archivage": {
    POST: auth("parametres", async (_req, a) => {
      const s3 = s3DepuisEnv();
      if (!s3)
        return Response.json({ erreur: "stockage objet non configuré (S3_ENDPOINT, S3_BUCKET)" }, { status: 503 });
      return Response.json({ archives: await archiverFichiers(sql, a.tenantId, s3, a.userId) });
    }),
  },
});

/** Description OpenAPI des routes du lot. */
export const openapi: Chemins = {
  "/v1/conformite/export": {
    get: op({
      resume: "Export complet des données du tenant (tar.gz, sans secrets)",
      tag: "Conformité",
      droit: "parametres",
      succes: { 200: brut("application/gzip") },
    }),
  },
  "/v1/conformite/suppression": {
    get: op({
      resume: "État d'une demande de suppression du tenant",
      tag: "Conformité",
      droit: "lire",
      succes: { 200: objet({}) },
    }),
    post: op({
      resume: "Demander la suppression du tenant (owner, 30 jours de grâce, pièces comptables conservées 10 ans)",
      tag: "Conformité",
      droit: "parametres",
      corps: objet({ nomEntreprise: str, motDePasse: str }, ["nomEntreprise", "motDePasse"]),
      succes: { 202: objet({}) },
      erreurs: [401, 409, 422],
    }),
    delete: op({
      resume: "Annuler la demande de suppression",
      tag: "Conformité",
      droit: "parametres",
      succes: { 204: null },
      erreurs: [404],
    }),
  },
  "/v1/conformite/archivage": {
    post: op({
      resume: "Archiver les exemplaires figés en stockage objet verrouillé",
      tag: "Conformité",
      droit: "parametres",
      succes: { 200: objet({}) },
      erreurs: [503],
    }),
  },
};

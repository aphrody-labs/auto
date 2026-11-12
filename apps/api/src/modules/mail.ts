// Lot mail : boîte IMAP/SMTP du tenant, relève classée, envoi des devis et factures (voir docs/MAIL.md).
import { chiffrer, FOURNISSEURS } from "@auto/mail";
import {
  enregistrerBoite,
  ErreurMetier,
  lireBoite,
  lirePieceMail,
  listerMailsRecus,
  supprimerBoite,
  withTenant,
} from "@auto/store";
import type { BunRequest } from "bun";
import type { Module, Chemins } from "../modules";
import { avecId, brut, liste, objet, op, str } from "../openapi-outils";
import {
  USAGE,
  cle,
  type CorpsBoite,
  valider,
  empreinte,
  configs,
  ouvrir,
  tester,
  publique,
  relever,
  type CorpsEnvoi,
  envoyerDocument,
} from "@auto/services/mail";

export const routes: Module = ({ sql, publier, auth }) => ({
  "/v1/mail/fournisseurs": {
    GET: auth("lire", async () => Response.json(FOURNISSEURS)),
  },
  "/v1/mail/boite": {
    GET: auth("lire", async (_req, a) => {
      const b = await withTenant(sql, a.tenantId, (tx) => lireBoite(tx));
      return b ? Response.json(publique(b)) : Response.json({ erreur: "aucune boîte mail connectée" }, { status: 404 });
    }),
    PUT: auth("parametres", async (req, a) => {
      const { config, identifiants } = valider((await req.json()) as CorpsBoite);
      const test = await tester(configs(config, identifiants));
      const chiffre = await chiffrer(cle(), a.tenantId, USAGE, identifiants);
      const b = await withTenant(sql, a.tenantId, async (tx) => {
        await enregistrerBoite(tx, a.userId, {
          ...config,
          source: empreinte(config, identifiants),
          identifiants: chiffre,
        });
        return (await lireBoite(tx))!;
      });
      return Response.json({ ...publique(b), test });
    }),
    DELETE: auth("parametres", async (_req, a) => {
      const ok = await withTenant(sql, a.tenantId, (tx) => supprimerBoite(tx, a.userId));
      return ok ? new Response(null, { status: 204 }) : Response.json({ erreur: "aucune boîte" }, { status: 404 });
    }),
  },
  "/v1/mail/boite/test": {
    POST: auth("parametres", async (_req, a) => {
      const b = await withTenant(sql, a.tenantId, (tx) => lireBoite(tx));
      if (!b) throw new ErreurMetier("aucune boîte mail connectée", [], 404);
      return Response.json(await tester(await ouvrir(a.tenantId, b)));
    }),
  },
  "/v1/mail/releve": {
    POST: auth("ecrire", async (_req, a) => Response.json(await relever(sql, a.tenantId, publier, a.userId))),
  },
  "/v1/mail/messages": {
    GET: auth("lire", async (req, a) => {
      const k = new URL(req.url).searchParams.get("classement");
      const classement = k === "facture" || k === "autre" ? k : undefined;
      return Response.json(await withTenant(sql, a.tenantId, (tx) => listerMailsRecus(tx, { classement })));
    }),
  },
  "/v1/mail/pieces/:id": {
    GET: auth("lire", async (req: BunRequest<"/v1/mail/pieces/:id">, a) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return Response.json({ erreur: "introuvable" }, { status: 404 });
      const p = await withTenant(sql, a.tenantId, (tx) => lirePieceMail(tx, req.params.id));
      if (!p) return Response.json({ erreur: "introuvable" }, { status: 404 });
      return new Response(p.contenu, {
        headers: {
          "content-type": p.type,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(p.nom)}`,
          etag: `"${p.sha256}"`,
          "x-content-type-options": "nosniff",
        },
      });
    }),
  },
  "/v1/documents/:id/envoyer": {
    POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/envoyer">, a) => {
      const corps = (await req.json().catch(() => ({}))) as CorpsEnvoi;
      return Response.json(await envoyerDocument(sql, publier, a.tenantId, a.userId, req.params.id, corps ?? {}));
    }),
  },
});

const BOITE = objet({
  imap: objet({ hote: str, port: { type: "integer" }, tls: { type: "boolean" } }),
  smtp: objet({ hote: str, port: { type: "integer" }, tls: { type: "boolean" } }),
  utilisateur: str,
  motDePasse: str,
  email: str,
});

/** Description OpenAPI des routes du lot. */
export const openapi: Chemins = {
  "/v1/mail/fournisseurs": {
    get: op({
      resume: "Préréglages IMAP/SMTP des fournisseurs (OVH, Google, Microsoft…)",
      tag: "Mail",
      droit: "lire",
      succes: { 200: liste(objet({})) },
    }),
  },
  "/v1/mail/boite": {
    get: op({
      resume: "Boîte connectée (sans mot de passe)",
      tag: "Mail",
      droit: "lire",
      succes: { 200: objet({}) },
      erreurs: [404],
    }),
    put: op({
      resume: "Connecter la boîte IMAP/SMTP (connexion testée, identifiants chiffrés au repos)",
      tag: "Mail",
      droit: "parametres",
      corps: BOITE,
      succes: { 200: objet({}) },
      erreurs: [422, 502],
    }),
    delete: op({ resume: "Déconnecter la boîte", tag: "Mail", droit: "parametres", succes: { 204: null } }),
  },
  "/v1/mail/boite/test": {
    post: op({
      resume: "Tester la connexion IMAP et SMTP",
      tag: "Mail",
      droit: "parametres",
      succes: { 200: objet({}) },
      erreurs: [404, 502],
    }),
  },
  "/v1/mail/releve": {
    post: op({
      resume: "Relever les nouveaux messages (idempotent) et classer les pièces jointes",
      tag: "Mail",
      droit: "ecrire",
      succes: { 200: objet({}) },
      erreurs: [404, 502],
    }),
  },
  "/v1/mail/messages": {
    get: op({ resume: "Messages relevés", tag: "Mail", droit: "lire", succes: { 200: liste(objet({})) } }),
  },
  "/v1/mail/pieces/{id}": avecId({
    get: op({
      resume: "Pièce jointe",
      tag: "Mail",
      droit: "lire",
      succes: { 200: brut("application/octet-stream") },
      erreurs: [404],
    }),
  }),
  "/v1/documents/{id}/envoyer": avecId({
    post: op({
      resume: "Envoyer un document émis par la boîte de l'entreprise (PDF figé en pièce jointe ; facture → envoyée)",
      tag: "Mail",
      droit: "ecrire",
      corps: objet({ a: liste(str), objet: str, message: str }),
      succes: { 200: objet({ messageId: str, destinataires: liste(str), statut: str }) },
      erreurs: [404, 409, 422, 502],
    }),
  }),
};

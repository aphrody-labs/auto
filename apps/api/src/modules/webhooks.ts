// Abonnements webhook par tenant : chaque entreprise reçoit ses propres événements signés (son n8n, son
// outil d'automatisation), en plus de la livraison opérateur. Même format et même signature que l'outbox.
import { creerWebhook, ErreurMetier, listerWebhooks, supprimerWebhook, withTenant } from "@auto/store";
import { chiffrer } from "@auto/tenancy";
import type { BunRequest } from "bun";
import type { Chemins, Module } from "../modules";
import { avecId, liste, objet, op, str } from "../openapi-outils";
import { infoSecret, verifierUrl, TYPE } from "@auto/services/webhooks";

export const routes: Module = ({ sql, auth }) => ({
  "/v1/webhooks": {
    GET: auth("parametres", async (_req, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => listerWebhooks(tx))),
    ),
    POST: auth("parametres", async (req, a) => {
      const b = (await req.json()) as { url?: string; types?: string[] };
      const url = verifierUrl(b.url ?? "");
      const types = b.types ?? [];
      if (!Array.isArray(types) || types.some((t) => typeof t !== "string" || !TYPE.test(t)))
        throw new ErreurMetier("types : liste de types d'événements « domaine.fait »");
      const secret = crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
      const secretChiffre = await chiffrer(infoSecret(a.tenantId), new TextEncoder().encode(secret));
      const w = await withTenant(sql, a.tenantId, (tx) => creerWebhook(tx, a.userId, { url, types, secretChiffre }));
      // Le secret n'est montré qu'une fois : le récepteur s'en sert pour vérifier x-auto-signature.
      return Response.json({ ...w, secret }, { status: 201 });
    }),
  },
  "/v1/webhooks/:id": {
    DELETE: auth("parametres", async (req: BunRequest<"/v1/webhooks/:id">, a) => {
      await withTenant(sql, a.tenantId, (tx) => supprimerWebhook(tx, a.userId, req.params.id));
      return new Response(null, { status: 204 });
    }),
  },
});

const WEBHOOK = objet({ id: str, url: str, types: liste(str), actif: { type: "boolean" }, createdAt: str });

/** Description OpenAPI des routes du module. */
export const openapi: Chemins = {
  "/v1/webhooks": {
    get: op({
      resume: "Abonnements webhook de l'entreprise",
      tag: "Automatisation",
      droit: "parametres",
      succes: { 200: liste(WEBHOOK) },
    }),
    post: op({
      resume: "S'abonner aux événements (URL https, types filtrés ; secret de signature montré une seule fois)",
      tag: "Automatisation",
      droit: "parametres",
      corps: objet({ url: str, types: liste(str) }, ["url"]),
      succes: { 201: objet({ id: str, url: str, types: liste(str), secret: str }) },
      erreurs: [422],
    }),
  },
  "/v1/webhooks/{id}": avecId({
    delete: op({
      resume: "Supprimer un abonnement",
      tag: "Automatisation",
      droit: "parametres",
      succes: { 204: null },
      erreurs: [404],
    }),
  }),
};

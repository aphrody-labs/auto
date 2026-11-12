// Paiement en ligne des factures : clé Stripe de l'entreprise (paramètres), lien de paiement signé, page publique
// /facture/<jeton> (consultation, PDF Factur-X, paiement par carte, confirmation au retour de Stripe).
import { totaux } from "@auto/domain";
import { DUREE_LIEN_MS, signerLien, verifierLien } from "@auto/services/devis-public";
import { chiffrerCle, confirmerPaiement, creerSessionPaiement, verifierCle } from "@auto/services/encaissement";
import {
  enregistrerEncaissement,
  ErreurMetier,
  lire,
  lireEncaissement,
  lireFichier,
  resteDu,
  supprimerEncaissement,
  withTenant,
  type Sql,
} from "@auto/store";
import { entreprise } from "@auto/tenancy";
import type { BunRequest } from "bun";
import { origineApp, type Chemins, type Module } from "../modules";
import { avecId, brut, cents, objet, op, str } from "../openapi-outils";

const PAYABLE = ["emis", "envoye", "depose"];

async function vue(sql: Sql, tenantId: string, documentId: string) {
  const r = await withTenant(sql, tenantId, async (tx) => {
    const d = await lire(tx, documentId);
    if (!d || !["facture", "acompte"].includes(d.type)) return null;
    return { d, reste: (await resteDu(tx, d.id)).resteCents, actif: !!(await lireEncaissement(tx)) };
  });
  if (!r) throw new ErreurMetier("lien invalide ou expiré", [], 404);
  const t = totaux(r.d.data.lignes);
  return {
    numero: r.d.numero,
    statut: r.d.statut,
    emetteur: (await entreprise(sql, tenantId)).nom,
    client: r.d.data.client.nom,
    date: r.d.data.date,
    echeance: r.d.data.echeance ?? null,
    totaux: { htCents: t.htCents, tvaCents: t.tvaCents, ttcCents: t.ttcCents },
    resteCents: r.reste,
    payable: r.actif && r.reste > 0 && PAYABLE.includes(r.d.statut),
  };
}

export const routes: Module = ({ sql, publier, pub, auth }) => {
  async function parJeton(jeton: string) {
    const c = await verifierLien(jeton);
    if (!c) throw new ErreurMetier("lien invalide ou expiré", [], 404);
    return c;
  }
  const base = origineApp;

  return {
    "/v1/parametres/encaissement": {
      GET: auth("lire", async (_req, a) => {
        const e = await withTenant(sql, a.tenantId, (tx) => lireEncaissement(tx));
        return Response.json({ actif: !!e, fournisseur: e?.fournisseur ?? null, apercu: e?.apercu ?? null });
      }),
      PUT: auth("parametres", async (req, a) => {
        const { cle } = (await req.json().catch(() => ({}))) as { cle?: string };
        const c = await chiffrerCle(a.tenantId, (cle ?? "").trim());
        await verifierCle((cle ?? "").trim());
        await withTenant(sql, a.tenantId, (tx) => enregistrerEncaissement(tx, c.chiffree, c.apercu));
        return new Response(null, { status: 204 });
      }),
      DELETE: auth("parametres", async (_req, a) => {
        await withTenant(sql, a.tenantId, (tx) => supprimerEncaissement(tx));
        return new Response(null, { status: 204 });
      }),
    },

    "/v1/documents/:id/lien-paiement": {
      POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/lien-paiement">, a) => {
        const v = await vue(sql, a.tenantId, req.params.id).catch(() => null);
        if (!v) throw new ErreurMetier("facture introuvable", [], 404);
        if (!v.payable)
          throw new ErreurMetier(
            "lien de paiement impossible : facture soldée, non émise, ou paiement en ligne non configuré",
            [],
            409,
          );
        const expire = Date.now() + DUREE_LIEN_MS;
        const jeton = await signerLien({ t: a.tenantId, d: req.params.id, e: expire });
        return Response.json(
          { url: `${base(req)}/facture/${jeton}`, jeton, expire: new Date(expire).toISOString() },
          { status: 201 },
        );
      }),
    },

    "/v1/public/factures/:jeton": {
      GET: pub(async (req: BunRequest<"/v1/public/factures/:jeton">) => {
        const c = await parJeton(req.params.jeton);
        return Response.json(await vue(sql, c.t, c.d), { headers: { "cache-control": "no-store" } });
      }),
    },

    "/v1/public/factures/:jeton/pdf": {
      GET: pub(async (req: BunRequest<"/v1/public/factures/:jeton/pdf">) => {
        const c = await parJeton(req.params.jeton);
        const r = await withTenant(sql, c.t, async (tx) => {
          const d = await lire(tx, c.d);
          return d && ["facture", "acompte"].includes(d.type) ? { d, f: await lireFichier(tx, d.id, "facturx") } : null;
        });
        if (!r?.f) throw new ErreurMetier("lien invalide ou expiré", [], 404);
        return new Response(r.f.contenu, {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="${r.d.numero}.pdf"`,
            "cache-control": "no-store",
          },
        });
      }),
    },

    "/v1/public/factures/:jeton/paiement": {
      POST: pub(async (req: BunRequest<"/v1/public/factures/:jeton/paiement">) => {
        const c = await parJeton(req.params.jeton);
        const page = `${base(req)}/facture/${req.params.jeton}`;
        const s = await creerSessionPaiement(sql, c.t, c.d, {
          succes: `${page}?session={CHECKOUT_SESSION_ID}`,
          annulation: page,
        });
        if (!s) throw new ErreurMetier("paiement en ligne non proposé pour cette facture", [], 409);
        return Response.json(s, { status: 201 });
      }),
    },

    "/v1/public/factures/:jeton/confirmation": {
      POST: pub(async (req: BunRequest<"/v1/public/factures/:jeton/confirmation">) => {
        const c = await parJeton(req.params.jeton);
        const { session } = (await req.json().catch(() => ({}))) as { session?: string };
        const r = await confirmerPaiement(sql, c.t, c.d, session ?? "", publier);
        return Response.json({ ...(await vue(sql, c.t, c.d)), enregistre: r.enregistre });
      }),
    },
  };
};

const VUE = objet({
  numero: str,
  statut: str,
  emetteur: str,
  client: str,
  date: str,
  echeance: { type: ["string", "null"] },
  totaux: objet({ htCents: cents, tvaCents: cents, ttcCents: cents }),
  resteCents: cents,
  payable: { type: "boolean" },
});
const jeton = (ops: Record<string, unknown>) => avecId(ops, "jeton", str);

export const openapi: Chemins = {
  "/v1/parametres/encaissement": {
    get: op({
      resume: "Paiement en ligne : état (clé masquée)",
      tag: "Paramètres",
      droit: "lire",
      succes: { 200: objet({ actif: { type: "boolean" }, fournisseur: str, apercu: str }) },
    }),
    put: op({
      resume: "Paiement en ligne : enregistrer la clé Stripe de l'entreprise (vérifiée chez Stripe)",
      tag: "Paramètres",
      droit: "parametres",
      corps: objet({ cle: str }, ["cle"]),
      succes: { 204: null },
      erreurs: [422, 502],
    }),
    delete: op({
      resume: "Paiement en ligne : retirer la clé Stripe",
      tag: "Paramètres",
      droit: "parametres",
      succes: { 204: null },
    }),
  },
  "/v1/documents/{id}/lien-paiement": avecId({
    post: op({
      resume: "Créer le lien de paiement en ligne d'une facture (30 jours)",
      tag: "Documents",
      droit: "ecrire",
      succes: { 201: objet({ url: str, jeton: str, expire: str }) },
      erreurs: [404, 409],
    }),
  }),
  "/v1/public/factures/{jeton}": jeton({
    get: op({
      resume: "Facture vue par le client (lien public)",
      tag: "Paiement en ligne",
      succes: { 200: VUE },
      erreurs: [404],
    }),
  }),
  "/v1/public/factures/{jeton}/pdf": jeton({
    get: op({
      resume: "Factur-X de la facture (lien public)",
      tag: "Paiement en ligne",
      succes: { 200: brut("application/pdf") },
      erreurs: [404],
    }),
  }),
  "/v1/public/factures/{jeton}/paiement": jeton({
    post: op({
      resume: "Ouvrir une session de paiement par carte (Stripe Checkout) pour le reste dû",
      tag: "Paiement en ligne",
      succes: { 201: objet({ url: str }) },
      erreurs: [404, 409, 502],
    }),
  }),
  "/v1/public/factures/{jeton}/confirmation": jeton({
    post: op({
      resume: "Confirmer le paiement au retour de Stripe (session relue chez Stripe, enregistrement unique)",
      tag: "Paiement en ligne",
      corps: objet({ session: str }, ["session"]),
      succes: { 200: VUE },
      erreurs: [404, 409, 502],
    }),
  }),
};

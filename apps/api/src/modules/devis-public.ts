// Devis en ligne : l'émetteur crée un lien signé, le client consulte le devis, télécharge le PDF figé et
// l'accepte ou le refuse sans compte (page /devis/<jeton> du front).
import { totaux, type Document } from "@auto/domain";
import { DUREE_LIEN_MS, signerLien, verifierLien } from "@auto/services/devis-public";
import { changerStatut, ErreurMetier, journaliser, lire, lireFichier, withTenant } from "@auto/store";
import { entreprise } from "@auto/tenancy";
import type { BunRequest } from "bun";
import { origineApp, type Chemins, type Module } from "../modules";
import { avecId, brut, cents, enumere, objet, op, str } from "../openapi-outils";

const DECIDABLE = ["emis", "envoye"];

/** Vue publique : ce que le client voit, sans identifiants internes autres que le numéro. */
function vue(d: { numero: string | null; statut: string; data: Document; emisAt: string | null }, emetteur: string) {
  const t = totaux(d.data.lignes);
  return {
    numero: d.numero,
    statut: d.statut,
    emetteur,
    client: d.data.client.nom,
    date: d.data.date,
    validiteJours: d.data.validiteJours ?? null,
    lignes: d.data.lignes.map((l) => ({
      designation: l.designation,
      quantite: l.quantite,
      prixUnitaireHtCents: l.prixUnitaireHtCents,
      tva: l.tva,
    })),
    totaux: { htCents: t.htCents, tvaCents: t.tvaCents, ttcCents: t.ttcCents },
    decidable: DECIDABLE.includes(d.statut),
  };
}

export const routes: Module = ({ sql, publier, pub, auth }) => {
  /** Devis désigné par un jeton valide, dans le contexte de son entreprise. */
  async function parJeton(jeton: string) {
    const c = await verifierLien(jeton);
    if (!c) throw new ErreurMetier("lien invalide ou expiré", [], 404);
    return c;
  }

  return {
    "/v1/documents/:id/lien-public": {
      POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/lien-public">, a) => {
        const d = await withTenant(sql, a.tenantId, (tx) => lire(tx, req.params.id));
        if (!d || d.type !== "devis") throw new ErreurMetier("devis introuvable", [], 404);
        if (!DECIDABLE.includes(d.statut))
          throw new ErreurMetier("seul un devis émis ou envoyé se partage en ligne", [], 409);
        const expire = Date.now() + DUREE_LIEN_MS;
        const jeton = await signerLien({ t: a.tenantId, d: d.id, e: expire });
        const base = origineApp(req);
        return Response.json(
          { url: `${base}/devis/${jeton}`, jeton, expire: new Date(expire).toISOString() },
          { status: 201 },
        );
      }),
    },

    "/v1/public/devis/:jeton": {
      GET: pub(async (req: BunRequest<"/v1/public/devis/:jeton">) => {
        const c = await parJeton(req.params.jeton);
        const d = await withTenant(sql, c.t, (tx) => lire(tx, c.d));
        if (!d || d.type !== "devis") throw new ErreurMetier("lien invalide ou expiré", [], 404);
        return Response.json(vue(d, (await entreprise(sql, c.t)).nom), { headers: { "cache-control": "no-store" } });
      }),
    },

    "/v1/public/devis/:jeton/pdf": {
      GET: pub(async (req: BunRequest<"/v1/public/devis/:jeton/pdf">) => {
        const c = await parJeton(req.params.jeton);
        const r = await withTenant(sql, c.t, async (tx) => {
          const d = await lire(tx, c.d);
          return d && d.type === "devis" ? { d, f: await lireFichier(tx, d.id, "pdf") } : null;
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

    "/v1/public/devis/:jeton/decision": {
      POST: pub(async (req: BunRequest<"/v1/public/devis/:jeton/decision">) => {
        const c = await parJeton(req.params.jeton);
        const b = (await req.json().catch(() => ({}))) as { decision?: string; nom?: string };
        if (b.decision !== "accepte" && b.decision !== "refuse")
          throw new ErreurMetier("décision attendue : accepte ou refuse");
        const nom = (b.nom ?? "").trim().slice(0, 120);
        if (!nom) throw new ErreurMetier("nom du signataire requis", ["nom"]);
        const d = await withTenant(sql, c.t, async (tx) => {
          const cur = await lire(tx, c.d);
          if (!cur || cur.type !== "devis") throw new ErreurMetier("lien invalide ou expiré", [], 404);
          if (!DECIDABLE.includes(cur.statut)) throw new ErreurMetier("ce devis a déjà reçu une réponse", [], 409);
          const d = await changerStatut(tx, null, c.d, b.decision as "accepte" | "refuse");
          await journaliser(tx, null, `devis.${b.decision}.en_ligne`, d.id, { signataire: nom });
          await publier(tx, "document.statut", { ...d, totaux: totaux(d.data.lignes), canal: "lien", signataire: nom });
          return d;
        });
        return Response.json(vue(d, (await entreprise(sql, c.t)).nom));
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
  validiteJours: { type: ["integer", "null"] },
  lignes: {
    type: "array",
    items: objet({ designation: str, quantite: { type: "number" }, prixUnitaireHtCents: cents }),
  },
  totaux: objet({ htCents: cents, tvaCents: cents, ttcCents: cents }),
  decidable: { type: "boolean" },
});

export const openapi: Chemins = {
  "/v1/documents/{id}/lien-public": avecId({
    post: op({
      resume: "Créer le lien public d'un devis émis (30 jours)",
      tag: "Documents",
      droit: "ecrire",
      succes: { 201: objet({ url: str, jeton: str, expire: str }) },
      erreurs: [404, 409],
    }),
  }),
  "/v1/public/devis/{jeton}": {
    parameters: [{ name: "jeton", in: "path", required: true, schema: str }],
    get: op({
      resume: "Devis vu par le client (lien public)",
      tag: "Devis en ligne",
      succes: { 200: VUE },
      erreurs: [404],
    }),
  },
  "/v1/public/devis/{jeton}/pdf": {
    parameters: [{ name: "jeton", in: "path", required: true, schema: str }],
    get: op({
      resume: "PDF figé du devis (lien public)",
      tag: "Devis en ligne",
      succes: { 200: brut("application/pdf") },
      erreurs: [404],
    }),
  },
  "/v1/public/devis/{jeton}/decision": {
    parameters: [{ name: "jeton", in: "path", required: true, schema: str }],
    post: op({
      resume: "Accepter ou refuser le devis (lien public)",
      tag: "Devis en ligne",
      corps: objet({ decision: enumere("accepte", "refuse"), nom: str }, ["decision", "nom"]),
      succes: { 200: VUE },
      erreurs: [404, 409, 422],
    }),
  },
};

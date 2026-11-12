import {
  affectationAchat,
  affectationDocument,
  affecterAchat,
  affecterDocument,
  dossierChantier,
  dossierFournisseur,
  enregistrerChantier,
  enregistrerFournisseur,
  enregistrerPiece,
  identifiant,
  lireFournisseur,
  listerChantiers,
  listerFournisseurs,
  listerPieces,
  rechercherGestion,
  withTenant,
  ErreurMetier,
} from "@auto/store";
import type { BunRequest } from "bun";
import type { Module, Chemins } from "../modules";
import { avecId, brut, cents, date, enumere, liste, objet, op, ref, str, uuid } from "../openapi-outils";
import { classeurGestion, rapportGestion } from "@auto/services/gestion";
import { ecrireXlsx } from "@auto/native";
import { segmentsDe, accesSegment, type Auth } from "@auto/tenancy";
const segmentPiece = (type: string) => (type === "bon_livraison" ? "livraisons" : "commandes");
function dossierPermis<T extends { documents: unknown[]; achats: unknown[]; pieces: { type: string }[] }>(
  d: T,
  a: Auth,
): T {
  return {
    ...d,
    documents: accesSegment(a, "clients") ? d.documents : [],
    achats: accesSegment(a, "fournisseurs") ? d.achats : [],
    pieces: d.pieces.filter((p) => accesSegment(a, segmentPiece(p.type))),
  };
}
export const routes: Module = ({ sql, auth }) => ({
  "/v1/exports/gestion.xlsx": {
    GET: auth(
      "lire",
      async (_req, a) =>
        new Response(
          new Uint8Array(ecrireXlsx(await withTenant(sql, a.tenantId, (tx) => classeurGestion(tx, segmentsDe(a))))),
          {
            headers: {
              "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "content-disposition": 'attachment; filename="gestion-auto.xlsx"',
            },
          },
        ),
    ),
  },
  "/v1/exports/gestion.pdf": {
    GET: auth(
      "lire",
      async (_req, a) =>
        new Response(rapportGestion(await withTenant(sql, a.tenantId, (tx) => classeurGestion(tx, segmentsDe(a)))), {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="gestion-auto.pdf"',
          },
        }),
    ),
  },
  "/v1/recherche-gestion": {
    GET: auth("lire", async (req, a) =>
      Response.json(
        await withTenant(sql, a.tenantId, (tx) =>
          rechercherGestion(tx, new URL(req.url).searchParams.get("q"), segmentsDe(a)),
        ),
      ),
    ),
  },
  "/v1/fournisseurs": {
    GET: auth("lire", async (_req, a) => {
      const f = await withTenant(sql, a.tenantId, listerFournisseurs);
      return Response.json(
        accesSegment(a, "fournisseurs") ? f : f.map(({ id, nom, archive }) => ({ id, nom, archive })),
      );
    }),
    POST: auth("ecrire", async (req, a) => {
      const b = await req.json();
      return Response.json(await withTenant(sql, a.tenantId, (tx) => enregistrerFournisseur(tx, a.userId, b)), {
        status: 201,
      });
    }),
  },
  "/v1/fournisseurs/:id": {
    GET: auth("lire", async (req: BunRequest<"/v1/fournisseurs/:id">, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => lireFournisseur(tx, req.params.id))),
    ),
    PUT: auth("ecrire", async (req: BunRequest<"/v1/fournisseurs/:id">, a) => {
      const b = await req.json();
      return Response.json(
        await withTenant(sql, a.tenantId, (tx) => enregistrerFournisseur(tx, a.userId, b, req.params.id)),
      );
    }),
  },
  "/v1/fournisseurs/:id/dossier": {
    GET: auth("lire", async (req: BunRequest<"/v1/fournisseurs/:id/dossier">, a) =>
      Response.json(
        await withTenant(sql, a.tenantId, async (tx) => {
          const d = await dossierFournisseur(tx, req.params.id);
          return { ...d, pieces: d.pieces.filter((p) => accesSegment(a, segmentPiece(p.type))) };
        }),
      ),
    ),
  },
  "/v1/chantiers": {
    GET: auth("lire", async (_req, a) => {
      const c = await withTenant(sql, a.tenantId, listerChantiers);
      return Response.json(
        accesSegment(a, "chantiers")
          ? c
          : c.map(({ id, nom, code, adresse, archive, clientId }) => ({ id, nom, code, adresse, archive, clientId })),
      );
    }),
    POST: auth("ecrire", async (req, a) => {
      const b = await req.json();
      return Response.json(await withTenant(sql, a.tenantId, (tx) => enregistrerChantier(tx, a.userId, b)), {
        status: 201,
      });
    }),
  },
  "/v1/chantiers/:id": {
    GET: auth("lire", async (req: BunRequest<"/v1/chantiers/:id">, a) =>
      Response.json(dossierPermis(await withTenant(sql, a.tenantId, (tx) => dossierChantier(tx, req.params.id)), a)),
    ),
    PUT: auth("ecrire", async (req: BunRequest<"/v1/chantiers/:id">, a) => {
      const b = await req.json();
      return Response.json(
        await withTenant(sql, a.tenantId, (tx) => enregistrerChantier(tx, a.userId, b, req.params.id)),
      );
    }),
  },
  "/v1/documents/:id/chantier": {
    GET: auth("lire", async (req: BunRequest<"/v1/documents/:id/chantier">, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => affectationDocument(tx, req.params.id))),
    ),
    PUT: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/chantier">, a) => {
      const b = (await req.json()) as { chantierId?: unknown };
      const id = b?.chantierId === null ? null : identifiant(b?.chantierId);
      await withTenant(sql, a.tenantId, (tx) => affecterDocument(tx, a.userId, req.params.id, id));
      return Response.json({ chantierId: id });
    }),
  },
  "/v1/factures-recues/:id/affectation": {
    GET: auth("lire", async (req: BunRequest<"/v1/factures-recues/:id/affectation">, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => affectationAchat(tx, req.params.id))),
    ),
    PUT: auth("ecrire", async (req: BunRequest<"/v1/factures-recues/:id/affectation">, a) => {
      const b = (await req.json()) as { fournisseurId?: unknown; chantierId?: unknown };
      const fournisseurId = identifiant(b?.fournisseurId);
      const chantierId = b?.chantierId == null ? null : identifiant(b.chantierId);
      return Response.json(
        await withTenant(sql, a.tenantId, (tx) =>
          affecterAchat(tx, a.userId, req.params.id, fournisseurId, chantierId),
        ),
      );
    }),
  },
  "/v1/pieces-chantier": {
    GET: auth("lire", async (_req, a) =>
      Response.json(
        (await withTenant(sql, a.tenantId, listerPieces)).filter((p) => accesSegment(a, segmentPiece(p.type))),
      ),
    ),
    POST: auth("ecrire", async (req, a) => {
      const b = await req.json();
      if (!accesSegment(a, segmentPiece(b?.type))) throw new ErreurMetier("accès refusé à ce type de pièce", [], 403);
      if (b?.recueId && !accesSegment(a, "fournisseurs"))
        throw new ErreurMetier("accès fournisseurs requis pour rapprocher une facture", [], 403);
      return Response.json(await withTenant(sql, a.tenantId, (tx) => enregistrerPiece(tx, a.userId, b)), {
        status: 201,
      });
    }),
  },
  "/v1/pieces-chantier/:id": {
    PUT: auth("ecrire", async (req: BunRequest<"/v1/pieces-chantier/:id">, a) => {
      const b = await req.json();
      if (!accesSegment(a, segmentPiece(b?.type))) throw new ErreurMetier("accès refusé à ce type de pièce", [], 403);
      return Response.json(
        await withTenant(sql, a.tenantId, async (tx) => {
          const avant = (await listerPieces(tx)).find((p) => p.id === req.params.id);
          if (!avant || !accesSegment(a, segmentPiece(avant.type)))
            throw new ErreurMetier("pièce introuvable", [], 404);
          if ((b?.recueId ?? null) !== avant.recueId && !accesSegment(a, "fournisseurs"))
            throw new ErreurMetier("accès fournisseurs requis pour modifier un rapprochement", [], 403);
          return enregistrerPiece(tx, a.userId, b, req.params.id);
        }),
      );
    }),
  },
});
const archive = { type: "boolean" };
const fournisseur = objet(
  { nom: str, adresse: str, siret: str, email: str, telephone: str, contact: str, notes: str, archive },
  ["nom"],
);
const chantier = objet(
  {
    nom: str,
    code: str,
    clientId: uuid,
    adresse: str,
    budgetHtCents: cents,
    avancement: { type: "integer", minimum: 0, maximum: 100 },
    statut: enumere("planifie", "en_cours", "termine", "en_pause"),
    debut: { type: ["string", "null"], format: "date" },
    fin: { type: ["string", "null"], format: "date" },
    notes: str,
    archive,
  },
  ["nom", "code", "clientId", "budgetHtCents", "avancement", "statut"],
);
const piece = objet(
  {
    type: enumere("bon_livraison", "confirmation_commande"),
    reference: str,
    fournisseurId: uuid,
    chantierId: uuid,
    recueId: { type: ["string", "null"], format: "uuid" },
    date,
    statut: enumere("a_verifier", "valide", "annule"),
    lignes: liste(ref("Ligne")),
    notes: str,
    archive,
  },
  ["type", "reference", "fournisseurId", "chantierId", "date", "statut", "lignes"],
);
const operation = (resume: string, droit: "lire" | "ecrire", corps?: Record<string, unknown>, creation = false) =>
  op({
    resume,
    tag: "Chantiers et fournisseurs",
    droit,
    corps,
    succes: { [creation ? 201 : 200]: objet({}) },
    erreurs: [404, 409, 422],
  });
export const openapi: Chemins = {
  "/v1/exports/gestion.xlsx": {
    get: op({
      resume: "Classeur de gestion complet : fournisseurs, clients, analytique, livraisons, commandes",
      tag: "Chantiers et fournisseurs",
      droit: "lire",
      succes: { 200: brut("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") },
    }),
  },
  "/v1/exports/gestion.pdf": {
    get: op({
      resume: "Rapport PDF des cinq espaces, données et archives comprises",
      tag: "Chantiers et fournisseurs",
      droit: "lire",
      succes: { 200: brut("application/pdf") },
      erreurs: [413],
    }),
  },
  "/v1/recherche-gestion": {
    get: op({
      resume: "Recherche dans les pièces enregistrées, archives comprises (100 résultats maximum, total retourné)",
      tag: "Chantiers et fournisseurs",
      droit: "lire",
      requete: [{ nom: "q", schema: str, description: "2 à 200 caractères" }],
      succes: { 200: objet({}) },
      erreurs: [422],
    }),
  },
  "/v1/fournisseurs/{id}/dossier": avecId({
    get: operation("Dossier fournisseur : factures classées et pièces rapprochées", "lire"),
  }),
  "/v1/fournisseurs": {
    get: op({
      resume: "Répertoire fournisseurs",
      tag: "Chantiers et fournisseurs",
      droit: "lire",
      succes: { 200: liste(fournisseur) },
    }),
    post: operation("Créer un fournisseur", "ecrire", fournisseur, true),
  },
  "/v1/fournisseurs/{id}": avecId({
    get: operation("Lire un fournisseur", "lire"),
    put: operation("Modifier ou archiver un fournisseur", "ecrire", fournisseur),
  }),
  "/v1/chantiers": {
    get: op({
      resume: "Liste des chantiers",
      tag: "Chantiers et fournisseurs",
      droit: "lire",
      succes: { 200: liste(chantier) },
    }),
    post: operation("Créer un chantier", "ecrire", chantier, true),
  },
  "/v1/chantiers/{id}": avecId({
    get: operation("Dossier et analytique : ventes émises, achats validés en EUR, commandes non facturées", "lire"),
    put: operation("Modifier ou archiver un chantier", "ecrire", chantier),
  }),
  "/v1/documents/{id}/chantier": avecId({
    get: operation("Affectation analytique d'un document", "lire"),
    put: operation(
      "Affecter un document au chantier de son client (null pour retirer)",
      "ecrire",
      objet({ chantierId: { type: ["string", "null"], format: "uuid" } }, ["chantierId"]),
    ),
  }),
  "/v1/factures-recues/{id}/affectation": avecId({
    get: operation("Affectation d'un achat reçu", "lire"),
    put: operation(
      "Classer un achat par fournisseur et chantier",
      "ecrire",
      objet({ fournisseurId: uuid, chantierId: { type: ["string", "null"], format: "uuid" } }, ["fournisseurId"]),
    ),
  }),
  "/v1/pieces-chantier": {
    get: op({
      resume: "Bons de livraison et confirmations de commande, archives comprises",
      tag: "Chantiers et fournisseurs",
      droit: "lire",
      succes: { 200: liste(piece) },
    }),
    post: operation("Créer une pièce de chantier", "ecrire", piece, true),
  },
  "/v1/pieces-chantier/{id}": avecId({ put: operation("Modifier, rapprocher ou archiver une pièce", "ecrire", piece) }),
};

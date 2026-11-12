import { avecMentionsParDefaut, totaux, type Tva } from "@auto/domain";
import { verifierDevis, SCHEMA_DEVIS, type DevisExtrait } from "@auto/ingest";
import {
  sourcesFichiers,
  sauverSource,
  fichiersIndexes,
  rechercherFichiersIndexes,
  fichierIndexe,
  withTenant,
  listerDevisRecus,
  lireDevisRecu,
  lireClient,
  lire,
  creerBrouillon,
  affecterDocument,
  identifiant,
  journaliser,
  ErreurMetier,
  type SourceFichiers,
} from "@auto/store";
import { SEGMENTS, segmentsDe, accesSegment, entreprise, type Segment } from "@auto/tenancy";
import { dossierSource, racinesFichiers, synchroniserSource } from "@auto/services/sources-fichiers";
import { deposerDevis, reextraireDevis } from "@auto/services/devis-recus";
import { lireDepot } from "@auto/services/ingest";
import type { BunRequest } from "bun";
import type { Module, Chemins } from "../modules";
import { avecId, brut, objet, op, liste, str, uuid, enumere, ref, type Schema } from "../openapi-outils";
function decoder(v: string) {
  try {
    return Uint8Array.fromBase64(v);
  } catch {
    throw new ErreurMetier("contenu du fichier invalide");
  }
}
const fichier = (r: { nom: string | null; contenu: Uint8Array<ArrayBuffer>; type_mime: string }) =>
  new Response(r.contenu, {
    headers: {
      "content-type": r.type_mime,
      "content-disposition": `attachment; filename="${(r.nom || "document").replace(/[^\x20-\x7E]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(r.nom || "document").replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
      "cache-control": "private, no-store",
    },
  });
export const routes: Module = ({ sql, auth }) => ({
  "/v1/membres/segments": {
    GET: auth("membres", async (_req, a) =>
      Response.json(
        await withTenant(sql, a.tenantId, (tx) => tx`SELECT user_id AS "userId",segments FROM membre_segments`),
      ),
    ),
  },
  "/v1/membres/:id/segments": {
    PUT: auth("membres", async (req: BunRequest<"/v1/membres/:id/segments">, a) => {
      const b = (await req.json()) as { segments: unknown };
      if (!Array.isArray(b?.segments) || b.segments.some((s) => !SEGMENTS.includes(s)))
        throw new ErreurMetier("segments invalides");
      const segments = [...new Set(b.segments)] as Segment[];
      const id = identifiant(req.params.id);
      const [m] = await sql`SELECT role FROM membership WHERE user_id=${id} AND tenant_id=${a.tenantId}`;
      if (!m) throw new ErreurMetier("membre introuvable", [], 404);
      if (["owner", "admin"].includes(m.role))
        throw new ErreurMetier("les propriétaires et administrateurs conservent tous les segments");
      await withTenant(sql, a.tenantId, async (tx) => {
        await tx`INSERT INTO membre_segments (user_id,segments) VALUES (${id},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(segments)}::text::jsonb))) ON CONFLICT (tenant_id,user_id) DO UPDATE SET segments=excluded.segments`;
        await journaliser(tx, a.userId, "membre.segments", id, { segments });
      });
      return Response.json({ userId: id, segments });
    }),
  },
  "/v1/sources-fichiers/racines": {
    GET: auth("parametres", async (_req, a) => Response.json(Object.keys(racinesFichiers(a.tenantId)))),
  },
  "/v1/sources-fichiers": {
    GET: auth("parametres", async (_req, a) => Response.json(await withTenant(sql, a.tenantId, sourcesFichiers))),
    POST: auth("parametres", async (req, a) => {
      const p = (await req.json()) as Omit<SourceFichiers, "id" | "synchroniseAt" | "erreur">;
      await dossierSource(a.tenantId, p);
      return Response.json(await withTenant(sql, a.tenantId, (tx) => sauverSource(tx, a.userId, p)), { status: 201 });
    }),
  },
  "/v1/sources-fichiers/:id": {
    PUT: auth("parametres", async (req: BunRequest<"/v1/sources-fichiers/:id">, a) => {
      const p = (await req.json()) as Omit<SourceFichiers, "id" | "synchroniseAt" | "erreur">;
      await dossierSource(a.tenantId, p);
      return Response.json(await withTenant(sql, a.tenantId, (tx) => sauverSource(tx, a.userId, p, req.params.id)));
    }),
  },
  "/v1/sources-fichiers/:id/synchroniser": {
    POST: auth("parametres", async (req: BunRequest<"/v1/sources-fichiers/:id/synchroniser">, a) =>
      Response.json(await synchroniserSource(sql, a.tenantId, identifiant(req.params.id), a.userId, req.signal)),
    ),
  },
  "/v1/fichiers-indexes": {
    GET: auth("lire", async (_req, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => fichiersIndexes(tx, segmentsDe(a)))),
    ),
  },
  "/v1/fichiers-indexes/recherche": {
    GET: auth("lire", async (req, a) => {
      const u = new URL(req.url);
      return Response.json(
        await withTenant(sql, a.tenantId, (tx) =>
          rechercherFichiersIndexes(
            tx,
            segmentsDe(a),
            u.searchParams.get("q") ?? "",
            Number(u.searchParams.get("page") ?? 1),
          ),
        ),
      );
    }),
  },
  "/v1/fichiers-indexes/:id/fichier": {
    GET: auth("lire", async (req: BunRequest<"/v1/fichiers-indexes/:id/fichier">, a) =>
      fichier(await withTenant(sql, a.tenantId, (tx) => fichierIndexe(tx, req.params.id, segmentsDe(a)))),
    ),
  },
  "/v1/devis-recus": {
    GET: auth("lire", async (_req, a) => Response.json(await withTenant(sql, a.tenantId, listerDevisRecus))),
    POST: auth("ecrire", async (req, a) => {
      const b = req.headers.get("content-type")?.startsWith("application/json")
        ? ((await req.json()) as { fichier?: string; nom?: string; typeMime?: string })
        : null;
      if (b && (!b.fichier || b.fichier.length > 28000000)) throw new ErreurMetier("pièce invalide", [], 413);
      const e = b
        ? { contenu: decoder(b.fichier!), nom: b.nom, typeMime: b.typeMime || "application/pdf" }
        : await lireDepot(req);
      return Response.json(await deposerDevis(sql, a.tenantId, a.userId, { ...e, canal: "api" }), { status: 201 });
    }),
  },
  "/v1/devis-recus/:id/fichier": {
    GET: auth("lire", async (req: BunRequest<"/v1/devis-recus/:id/fichier">, a) =>
      fichier(
        await withTenant(sql, a.tenantId, async (tx) => {
          const d = await lireDevisRecu(tx, identifiant(req.params.id));
          const [f] = await tx<
            { nom: string; contenu: Uint8Array<ArrayBuffer>; type_mime: string }[]
          >`SELECT nom,contenu,type_mime FROM fichier_recu WHERE id=${d.fichierId}`;
          return f!;
        }),
      ),
    ),
  },
  "/v1/devis-recus/:id/reextraire": {
    POST: auth("ecrire", async (req: BunRequest<"/v1/devis-recus/:id/reextraire">, a) =>
      Response.json(await reextraireDevis(sql, a.tenantId, a.userId, identifiant(req.params.id))),
    ),
  },
  "/v1/devis-recus/:id/decision": {
    POST: auth("ecrire", async (req: BunRequest<"/v1/devis-recus/:id/decision">, a) => {
      const b = (await req.json()) as { statut: string; data?: DevisExtrait };
      if (!["valide", "rejete"].includes(b?.statut)) throw new ErreurMetier("statut invalide");
      const d = await withTenant(sql, a.tenantId, async (tx) => {
        await tx`SELECT id FROM devis_recu WHERE id=${identifiant(req.params.id)} FOR UPDATE`;
        const d = await lireDevisRecu(tx, req.params.id);
        if (d.statut === "rejete" || d.brouillonId) throw new ErreurMetier("devis déjà traité", [], 409);
        const data = b.data ?? d.data;
        const anomalies = b.statut === "valide" ? verifierDevis(data) : d.anomalies;
        if (b.statut === "valide" && anomalies.length)
          throw new ErreurMetier("devis à corriger avant validation", anomalies);
        await tx`UPDATE devis_recu SET data=${JSON.stringify(data)}::text::jsonb,anomalies=${JSON.stringify(anomalies)}::text::jsonb,statut=${b.statut} WHERE id=${d.id}`;
        await journaliser(tx, a.userId, "devis_recu.decider", d.id, { statut: b.statut });
        return lireDevisRecu(tx, d.id);
      });
      return Response.json(d);
    }),
  },
  "/v1/devis-recus/:id/brouillon": {
    POST: auth("ecrire", async (req: BunRequest<"/v1/devis-recus/:id/brouillon">, a) => {
      if (!accesSegment(a, "clients")) throw new ErreurMetier("accès au segment clients requis", [], 403);
      const b = (await req.json()) as { clientId: string; chantierId?: string; type?: "devis" | "facture" };
      const type = b.type ?? "devis";
      if (!["devis", "facture"].includes(type)) throw new ErreurMetier("type de brouillon invalide");
      const doc = await withTenant(sql, a.tenantId, async (tx) => {
        await tx`SELECT id FROM devis_recu WHERE id=${identifiant(req.params.id)} FOR UPDATE`;
        const d = await lireDevisRecu(tx, req.params.id);
        if (d.brouillonId) {
          const existant = await lire(tx, d.brouillonId);
          if (existant?.type !== type) throw new ErreurMetier("un brouillon a déjà été créé pour ce devis", [], 409);
          return existant;
        }
        if (d.statut !== "valide" || !d.data)
          throw new ErreurMetier("validez le devis reçu avant de créer un brouillon");
        const client = await lireClient(tx, identifiant(b.clientId));
        if (!client) throw new ErreurMetier("client introuvable", [], 404);
        const e = await entreprise(sql, a.tenantId);
        const lignes = d.data.lignes.map((l) => ({
          designation: l.designation,
          quantite: l.quantite,
          prixUnitaireHtCents: l.prixUnitaireHtCents,
          tva: l.tauxTva as Tva,
        }));
        if (totaux(lignes).ttcCents !== d.data.totaux.ttcCents)
          throw new ErreurMetier("les remises ou arrondis du devis source nécessitent une saisie manuelle");
        const doc = await creerBrouillon(
          tx,
          a.userId,
          avecMentionsParDefaut({
            type,
            date: new Date().toISOString().slice(0, 10),
            ...(type === "facture"
              ? {
                  datePrestation: d.data.datePrestation ?? new Date().toISOString().slice(0, 10),
                  echeance: d.data.echeance ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
                }
              : {}),
            emetteur: { nom: e.nom, siret: e.siret, adresse: e.adresse },
            client,
            lignes,
            notes: "Prérempli depuis le devis reçu " + d.data.numero,
            franchiseTva: e.franchiseTva,
          }),
          client.id,
        );
        if (b.chantierId) await affecterDocument(tx, a.userId, doc.id, identifiant(b.chantierId));
        await tx`UPDATE devis_recu SET brouillon_id=${doc.id} WHERE id=${d.id}`;
        return doc;
      });
      return Response.json(doc && { ...doc, totaux: totaux(doc.data.lignes) }, { status: 201 });
    }),
  },
});
const segment = enumere(...SEGMENTS),
  nullableTexte = { type: ["string", "null"] };
const permissions = objet({ userId: uuid, segments: liste(segment) }, ["userId", "segments"]);
const sourceEntree = objet(
  {
    nom: str,
    racine: str,
    sousDossier: str,
    segment,
    traitement: enumere("index", "facture", "devis"),
    actif: { type: "boolean" },
  },
  ["nom", "racine", "sousDossier", "segment", "traitement", "actif"],
);
const sourceSortie = {
  ...sourceEntree,
  properties: {
    ...(sourceEntree.properties as Record<string, Schema>),
    id: uuid,
    synchroniseAt: nullableTexte,
    erreur: nullableTexte,
    curseur: nullableTexte,
  },
};
const devisSortie = objet({
  id: uuid,
  fichierId: uuid,
  statut: enumere("a_verifier", "valide", "rejete"),
  data: { anyOf: [SCHEMA_DEVIS, { type: "null" }] },
  anomalies: liste(str),
  texte: str,
  brouillonId: { type: ["string", "null"], format: "uuid" },
  createdAt: str,
});
const indexSortie = objet({
  id: uuid,
  sourceId: uuid,
  nom: str,
  chemin: str,
  segment,
  archive: { type: "boolean" },
  texte: str,
  recueId: nullableTexte,
  devisId: nullableTexte,
});
const bilan = objet({
  nouveaux: { type: "integer" },
  inchanges: { type: "integer" },
  erreurs: liste(objet({ chemin: str, message: str })),
  limiteAtteinte: { type: "boolean" },
  curseur: nullableTexte,
});
const operation = (
  resume: string,
  droit: "lire" | "ecrire" | "parametres" | "membres",
  creation = false,
  sortie: Schema = objet({}),
  corps?: Schema,
) =>
  op({
    resume,
    tag: "Arrivages et permissions",
    droit,
    corps,
    succes: { [creation ? 201 : 200]: sortie },
    erreurs: [403, 404, 409, 413, 422],
  });
export const openapi: Chemins = {
  "/v1/membres/segments": {
    get: operation("Restrictions par segment des membres", "membres", false, liste(permissions)),
  },
  "/v1/membres/{id}/segments": avecId({
    put: operation(
      "Attribuer les segments d’un membre (userId)",
      "membres",
      false,
      permissions,
      objet({ segments: liste(segment) }, ["segments"]),
    ),
  }),
  "/v1/sources-fichiers/racines": {
    get: operation("Alias des montages accordés à cette entreprise", "parametres", false, liste(str)),
  },
  "/v1/sources-fichiers": {
    get: operation("Sources du serveur de fichiers", "parametres", false, liste(sourceSortie)),
    post: operation("Connecter un dossier autorisé", "parametres", true, sourceSortie, sourceEntree),
  },
  "/v1/sources-fichiers/{id}": avecId({
    put: operation("Modifier ou désactiver une source", "parametres", false, sourceSortie, sourceEntree),
  }),
  "/v1/sources-fichiers/{id}/synchroniser": avecId({
    post: operation("Synchroniser une source (copies immuables, extraction et indexation)", "parametres", false, bilan),
  }),
  "/v1/fichiers-indexes": { get: operation("Fichiers accessibles par segment", "lire", false, liste(indexSortie)) },
  "/v1/fichiers-indexes/recherche": {
    get: op({
      resume: "Rechercher dans tout l’index autorisé, 100 fichiers par page",
      tag: "Arrivages",
      droit: "lire",
      requete: [
        {
          nom: "q",
          schema: { type: "string", maxLength: 200 },
          description: "Texte littéral recherché dans le nom, le chemin et le contenu indexé",
        },
        {
          nom: "page",
          schema: { type: "integer", minimum: 1, maximum: 10000 },
          description: "Page à partir de 1 ; 100 résultats par page",
        },
      ],
      succes: { 200: objet({ fichiers: liste(indexSortie), suite: { type: "boolean" } }) },
      erreurs: [422],
    }),
  },
  "/v1/fichiers-indexes/{id}/fichier": avecId({
    get: op({
      resume: "Télécharger une pièce indexée autorisée",
      tag: "Arrivages et permissions",
      droit: "lire",
      succes: { 200: brut("application/octet-stream") },
      erreurs: [404],
    }),
  }),
  "/v1/devis-recus": {
    get: operation("Devis extraits à vérifier", "lire", false, liste(devisSortie)),
    post: operation(
      "Extraire un devis PDF ou image (base64 en JSON ou dépôt binaire)",
      "ecrire",
      true,
      objet({ devis: devisSortie, doublon: { type: "boolean" } }),
      objet({ fichier: { type: "string", contentEncoding: "base64" }, nom: str, typeMime: str }, ["fichier"]),
    ),
  },
  "/v1/devis-recus/{id}/fichier": avecId({
    get: op({
      resume: "Télécharger le devis reçu original",
      tag: "Arrivages et permissions",
      droit: "lire",
      succes: { 200: brut("application/octet-stream") },
      erreurs: [404],
    }),
  }),
  "/v1/devis-recus/{id}/reextraire": avecId({
    post: operation("Relancer l’extraction depuis l’original conservé", "ecrire", false, devisSortie),
  }),
  "/v1/devis-recus/{id}/decision": avecId({
    post: operation(
      "Corriger, valider ou rejeter les informations extraites",
      "ecrire",
      false,
      devisSortie,
      objet({ statut: enumere("valide", "rejete"), data: SCHEMA_DEVIS }, ["statut"]),
    ),
  }),
  "/v1/devis-recus/{id}/brouillon": avecId({
    post: operation(
      "Créer une seule fois un devis ou une facture client préremplis, jamais émis automatiquement",
      "ecrire",
      true,
      ref("Document"),
      objet({ clientId: uuid, chantierId: uuid, type: enumere("devis", "facture") }, ["clientId"]),
    ),
  }),
};

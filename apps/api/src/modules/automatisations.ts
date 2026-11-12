// Automatisations (workflows type n8n) : édition, essai, exécution, historique, secrets et webhooks entrants.
// Le moteur et son catalogue sont dans @auto/automate ; l'exécution réelle dans @auto/services/automatisations.
import { catalogueJson, Definition, estN8n, importerN8n, MODELES, valider, type Element } from "@auto/automate";
import {
  chiffrerSecret,
  ecriture,
  elementWebhook,
  essayer,
  lancer,
  signerCrochet,
  verifierCrochet,
} from "@auto/services/automatisations";
import {
  creerAutomatisation,
  enfiler,
  enregistrerSecret,
  ErreurMetier,
  JOB_AUTOMATISATION,
  lireAutomatisation,
  lireVersion,
  listerVersions,
  lireExecution,
  listerAutomatisations,
  listerBases,
  listerExecutions,
  listerSecrets,
  modifierAutomatisation,
  supprimerAutomatisation,
  supprimerConnaissance,
  supprimerSecret,
  withTenant,
  type ChargeExecution,
} from "@auto/store";
import type { BunRequest } from "bun";
import { z } from "zod";
import { origineApp, type Chemins, type Module } from "../modules";
import { avecId, enumere, liste, objet, op, param, str } from "../openapi-outils";

type Corps = { nom?: unknown; description?: unknown; actif?: unknown; definition?: unknown; donnees?: unknown };

/** Données d'essai du lancement manuel : un objet (un élément) ou une liste d'objets. */
function entree(donnees: unknown): Element[] {
  if (donnees == null) return [{ json: {} }];
  const liste = Array.isArray(donnees) ? donnees : [donnees];
  if (liste.length > 100 || liste.some((d) => !d || typeof d !== "object" || Array.isArray(d)))
    throw new ErreurMetier("donnees : un objet ou une liste de 100 objets au plus");
  return liste.map((d) => ({ json: d as Record<string, unknown> }));
}

export const routes: Module = ({ sql, auth, pub }) => ({
  "/v1/automatisations": {
    GET: auth("lire", async (_req, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => listerAutomatisations(tx))),
    ),
    POST: auth("ecrire", async (req, a) => {
      const b = (await req.json()) as Corps;
      const w = await withTenant(sql, a.tenantId, async (tx) =>
        creerAutomatisation(tx, a.userId, await ecriture(tx, b)),
      );
      return Response.json(w, { status: 201 });
    }),
  },
  "/v1/automatisations/catalogue": { GET: auth("lire", async () => Response.json(catalogueJson())) },
  "/v1/automatisations/modeles": { GET: auth("lire", async () => Response.json(MODELES)) },
  "/v1/automatisations/essai": {
    POST: auth("ecrire", async (req, a) => {
      const b = (await req.json()) as Corps;
      return Response.json(await essayer(sql, a.tenantId, a.userId, b.definition, entree(b.donnees)));
    }),
  },
  "/v1/automatisations/importer-n8n": {
    POST: auth("ecrire", async (req) => {
      const b = (await req.json()) as { workflow?: unknown };
      if (!estN8n(b.workflow)) throw new ErreurMetier("workflow : export JSON de n8n attendu (nodes, connections)");
      if (b.workflow.nodes.length > 100) throw new ErreurMetier("100 nœuds au plus");
      return Response.json(importerN8n(b.workflow));
    }),
  },
  "/v1/automatisations/:id": {
    GET: auth("lire", async (req: BunRequest<"/v1/automatisations/:id">, a) => {
      const w = await withTenant(sql, a.tenantId, (tx) => lireAutomatisation(tx, req.params.id));
      if (!w) throw new ErreurMetier("automatisation introuvable", [], 404);
      return Response.json(w);
    }),
    PUT: auth("ecrire", async (req: BunRequest<"/v1/automatisations/:id">, a) => {
      const b = (await req.json()) as Corps;
      const w = await withTenant(sql, a.tenantId, async (tx) => {
        const avant = await lireAutomatisation(tx, req.params.id);
        if (!avant) throw new ErreurMetier("automatisation introuvable", [], 404);
        return modifierAutomatisation(tx, a.userId, avant.id, await ecriture(tx, b, avant));
      });
      return Response.json(w);
    }),
    DELETE: auth("ecrire", async (req: BunRequest<"/v1/automatisations/:id">, a) => {
      await withTenant(sql, a.tenantId, (tx) => supprimerAutomatisation(tx, a.userId, req.params.id));
      return new Response(null, { status: 204 });
    }),
  },
  "/v1/automatisations/:id/executer": {
    POST: auth("ecrire", async (req: BunRequest<"/v1/automatisations/:id/executer">, a) => {
      const b = (await req.json().catch(() => ({}))) as Corps;
      const { execution } = await lancer(sql, {
        tenantId: a.tenantId,
        automatisationId: req.params.id,
        origine: "manuel",
        entree: entree(b.donnees),
        signal: AbortSignal.timeout(120_000),
      });
      return Response.json(execution);
    }),
  },
  "/v1/automatisations/:id/versions": {
    GET: auth("lire", async (req: BunRequest<"/v1/automatisations/:id/versions">, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => listerVersions(tx, req.params.id))),
    ),
  },
  "/v1/automatisations/:id/versions/:numero/restaurer": {
    // La restauration est une modification comme une autre : l'état remplacé devient lui-même une version.
    POST: auth("ecrire", async (req: BunRequest<"/v1/automatisations/:id/versions/:numero/restaurer">, a) => {
      const w = await withTenant(sql, a.tenantId, async (tx) => {
        const avant = await lireAutomatisation(tx, req.params.id);
        if (!avant) throw new ErreurMetier("automatisation introuvable", [], 404);
        const v = await lireVersion(tx, avant.id, Number(req.params.numero));
        if (!v) throw new ErreurMetier("version introuvable", [], 404);
        const b = { nom: v.nom, description: v.description, definition: v.definition };
        return modifierAutomatisation(tx, a.userId, avant.id, await ecriture(tx, b, avant));
      });
      return Response.json(w);
    }),
  },
  "/v1/automatisations/:id/executions": {
    GET: auth("lire", async (req: BunRequest<"/v1/automatisations/:id/executions">, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => listerExecutions(tx, req.params.id))),
    ),
  },
  "/v1/automatisations/:id/webhook": {
    GET: auth("ecrire", async (req: BunRequest<"/v1/automatisations/:id/webhook">, a) => {
      const w = await withTenant(sql, a.tenantId, (tx) => lireAutomatisation(tx, req.params.id));
      if (!w) throw new ErreurMetier("automatisation introuvable", [], 404);
      const jeton = await signerCrochet({ t: a.tenantId, a: w.id });
      return Response.json({ url: `${origineApp(req)}/v1/public/crochets/${jeton}` });
    }),
  },
  "/v1/executions/:id": {
    GET: auth("lire", async (req: BunRequest<"/v1/executions/:id">, a) => {
      const e = await withTenant(sql, a.tenantId, (tx) => lireExecution(tx, req.params.id));
      if (!e) throw new ErreurMetier("exécution introuvable", [], 404);
      return Response.json(e);
    }),
  },

  "/v1/secrets": {
    GET: auth("parametres", async (_req, a) =>
      Response.json(await withTenant(sql, a.tenantId, (tx) => listerSecrets(tx))),
    ),
    POST: auth("parametres", async (req, a) => {
      const b = (await req.json()) as { nom?: unknown; valeur?: unknown };
      const valeur = typeof b.valeur === "string" ? b.valeur : "";
      // 32 000 : un certificat PKCS #12 en base64 avec sa chaîne (nœud « Signer un PDF »).
      if (!valeur || valeur.length > 32_000) throw new ErreurMetier("valeur : 1 à 32 000 caractères");
      const chiffre = await chiffrerSecret(a.tenantId, valeur);
      const s = await withTenant(sql, a.tenantId, (tx) =>
        enregistrerSecret(tx, a.userId, String(b.nom ?? ""), chiffre),
      );
      return Response.json(s, { status: 201 });
    }),
  },
  "/v1/secrets/:id": {
    DELETE: auth("parametres", async (req: BunRequest<"/v1/secrets/:id">, a) => {
      await withTenant(sql, a.tenantId, (tx) => supprimerSecret(tx, a.userId, req.params.id));
      return new Response(null, { status: 204 });
    }),
  },

  // Base de connaissances (nœuds ia.indexer, ia.rechercher) : comptes par base, suppression d'une base ou d'une source.
  "/v1/connaissances": {
    GET: auth("lire", async (_req, a) => Response.json(await withTenant(sql, a.tenantId, (tx) => listerBases(tx)))),
  },
  "/v1/connaissances/:base": {
    DELETE: auth("ecrire", async (req: BunRequest<"/v1/connaissances/:base">, a) => {
      const source = new URL(req.url).searchParams.get("source") ?? undefined;
      const morceaux = await withTenant(sql, a.tenantId, (tx) =>
        supprimerConnaissance(tx, a.userId, req.params.base, source),
      );
      return Response.json({ morceaux });
    }),
  },

  // Webhook entrant : l'URL secrète porte le tenant et le workflow (jeton signé, sans état).
  "/v1/public/crochets/:jeton": Object.fromEntries(
    ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => [
      m,
      pub(async (req: BunRequest<"/v1/public/crochets/:jeton">) => {
        const c = await verifierCrochet(req.params.jeton);
        if (!c) throw new ErreurMetier("webhook introuvable", [], 404);
        const w = await withTenant(sql, c.t, (tx) => lireAutomatisation(tx, c.a));
        if (!w || w.declencheur !== "webhook") throw new ErreurMetier("webhook introuvable", [], 404);
        if (!w.actif) throw new ErreurMetier("workflow inactif", [], 409);
        const el = await elementWebhook(req);
        const def = valider(w.definition);
        const reponse = (def.noeuds.find((n) => n.type === "declencheur.webhook")?.parametres as { reponse?: string })
          ?.reponse;
        if (reponse === "fin") {
          const { execution, resultat } = await lancer(sql, {
            tenantId: c.t,
            automatisationId: w.id,
            origine: "webhook",
            entree: [el],
            signal: AbortSignal.timeout(30_000),
          });
          if (resultat.statut === "erreur")
            return Response.json({ erreur: execution.erreur, execution: execution.id }, { status: 500 });
          const sortie = resultat.sortie.map((e) => e.json);
          return Response.json(sortie.length === 1 ? sortie[0] : sortie);
        }
        const charge: ChargeExecution = { automatisationId: w.id, origine: "webhook", entree: [el] };
        await withTenant(sql, c.t, (tx) => enfiler(tx, JOB_AUTOMATISATION, charge, { maxEssais: 3 }));
        return Response.json({ recu: true }, { status: 202 });
      }),
    ]),
  ),
});

const DEFINITION = z.toJSONSchema(Definition, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
const STATUT = enumere("en_cours", "succes", "erreur");
const DECLENCHEUR = enumere("manuel", "evenement", "planifie", "webhook");
const RESUME = objet({
  id: str,
  nom: str,
  description: str,
  actif: { type: "boolean" },
  declencheur: DECLENCHEUR,
  createdAt: str,
  updatedAt: str,
  derniereExecution: { ...objet({ id: str, statut: STATUT, debut: str }), nullable: true },
});
const AUTOMATISATION = objet({
  id: str,
  nom: str,
  description: str,
  actif: { type: "boolean" },
  declencheur: DECLENCHEUR,
  definition: DEFINITION,
  createdAt: str,
  updatedAt: str,
});
const ETAPE = objet({
  noeud: str,
  nom: str,
  type: str,
  debut: str,
  dureeMs: { type: "number" },
  entree: { type: "integer" },
  sorties: liste({ type: "integer" }),
  apercu: liste({ type: "object" }),
  erreur: str,
});
const EXECUTION = objet({
  id: str,
  automatisationId: str,
  origine: str,
  statut: STATUT,
  erreur: { type: "string", nullable: true },
  debut: str,
  fin: { type: "string", nullable: true },
  etapes: liste(ETAPE),
});
const VERSION = objet({
  numero: { type: "integer" },
  nom: str,
  description: str,
  definition: DEFINITION,
  auteur: { type: "string", nullable: true },
  createdAt: str,
});
const ECRITURE = objet({ nom: str, description: str, actif: { type: "boolean" }, definition: DEFINITION }, [
  "nom",
  "definition",
]);
const DONNEES = objet({ donnees: { description: "Objet ou liste d'objets : éléments du déclencheur" } });
const T = "Automatisations";

/** Description OpenAPI des routes du module. */
export const openapi: Chemins = {
  "/v1/automatisations": {
    get: op({ resume: "Workflows de l'entreprise", tag: T, droit: "lire", succes: { 200: liste(RESUME) } }),
    post: op({
      resume: "Créer un workflow (définition validée : nœuds, connexions, un déclencheur, sans cycle)",
      tag: T,
      droit: "ecrire",
      corps: ECRITURE,
      succes: { 201: AUTOMATISATION },
      erreurs: [422],
    }),
  },
  "/v1/automatisations/catalogue": {
    get: op({
      resume: "Types de nœuds disponibles, paramètres en JSON Schema",
      tag: T,
      droit: "lire",
      succes: { 200: liste({ type: "object" }) },
    }),
  },
  "/v1/automatisations/modeles": {
    get: op({
      resume: "Modèles de workflows prêts à l'emploi",
      tag: T,
      droit: "lire",
      succes: { 200: liste({ type: "object" }) },
    }),
  },
  "/v1/automatisations/essai": {
    post: op({
      resume: "Essayer une définition sans l'enregistrer",
      tag: T,
      droit: "ecrire",
      corps: objet({ definition: DEFINITION, donnees: {} }, ["definition"]),
      succes: { 200: EXECUTION },
      erreurs: [422],
    }),
  },
  "/v1/automatisations/importer-n8n": {
    post: op({
      resume: "Convertir un workflow exporté de n8n en définition auto (rien n'est enregistré)",
      tag: T,
      droit: "ecrire",
      corps: objet({ workflow: { type: "object" } }, ["workflow"]),
      succes: {
        200: objet({
          nom: str,
          definition: DEFINITION,
          avertissements: liste(str),
          autres: liste(objet({ nom: str, definition: DEFINITION })),
        }),
      },
      erreurs: [422],
    }),
  },
  "/v1/automatisations/{id}": avecId({
    get: op({ resume: "Lire un workflow", tag: T, droit: "lire", succes: { 200: AUTOMATISATION }, erreurs: [404] }),
    put: op({
      resume: "Modifier un workflow (champs partiels)",
      tag: T,
      droit: "ecrire",
      corps: objet({ nom: str, description: str, actif: { type: "boolean" }, definition: DEFINITION }),
      succes: { 200: AUTOMATISATION },
      erreurs: [404, 422],
    }),
    delete: op({ resume: "Supprimer un workflow", tag: T, droit: "ecrire", succes: { 204: null }, erreurs: [404] }),
  }),
  "/v1/automatisations/{id}/executer": avecId({
    post: op({
      resume: "Exécuter maintenant (lancement manuel, synchrone)",
      tag: T,
      droit: "ecrire",
      corps: DONNEES,
      succes: { 200: EXECUTION },
      erreurs: [404],
    }),
  }),
  "/v1/automatisations/{id}/versions": avecId({
    get: op({
      resume: "Versions précédentes (50 au plus), la plus récente d'abord",
      tag: T,
      droit: "lire",
      succes: { 200: liste(VERSION) },
    }),
  }),
  "/v1/automatisations/{id}/versions/{numero}/restaurer": {
    parameters: [param("id"), param("numero", { type: "integer" })],
    post: op({
      resume: "Restaurer une version (l'état remplacé devient lui-même une version)",
      tag: T,
      droit: "ecrire",
      succes: { 200: AUTOMATISATION },
      erreurs: [404, 422],
    }),
  },
  "/v1/automatisations/{id}/executions": avecId({
    get: op({ resume: "Historique des exécutions", tag: T, droit: "lire", succes: { 200: liste(EXECUTION) } }),
  }),
  "/v1/automatisations/{id}/webhook": avecId({
    get: op({
      resume: "URL secrète du webhook entrant",
      tag: T,
      droit: "ecrire",
      succes: { 200: objet({ url: str }) },
      erreurs: [404],
    }),
  }),
  "/v1/executions/{id}": avecId({
    get: op({
      resume: "Détail d'une exécution, étape par étape",
      tag: T,
      droit: "lire",
      succes: { 200: EXECUTION },
      erreurs: [404],
    }),
  }),
  "/v1/secrets": {
    get: op({
      resume: "Secrets des workflows (noms seulement)",
      tag: T,
      droit: "parametres",
      succes: { 200: liste(objet({ id: str, nom: str, createdAt: str })) },
    }),
    post: op({
      resume: "Enregistrer un secret (chiffré, cité par {{ $secret.nom }})",
      tag: T,
      droit: "parametres",
      corps: objet({ nom: str, valeur: str }, ["nom", "valeur"]),
      succes: { 201: objet({ id: str, nom: str, createdAt: str }) },
      erreurs: [422],
    }),
  },
  "/v1/secrets/{id}": avecId({
    delete: op({ resume: "Supprimer un secret", tag: T, droit: "parametres", succes: { 204: null }, erreurs: [404] }),
  }),
  "/v1/connaissances": {
    get: op({
      resume: "Bases de connaissances de l'entreprise : sources, morceaux, modèle et dimension des embeddings",
      tag: T,
      droit: "lire",
      succes: {
        200: liste(
          objet({
            base: str,
            sources: { type: "integer" },
            morceaux: { type: "integer" },
            modele: str,
            dimension: { type: "integer" },
            majAt: str,
          }),
        ),
      },
    }),
  },
  "/v1/connaissances/{base}": avecId(
    {
      delete: op({
        resume: "Supprimer une base de connaissances, ou une seule de ses sources avec ?source=",
        tag: T,
        droit: "ecrire",
        requete: [{ nom: "source", schema: str, description: "Source à supprimer seule (nom donné à l'indexation)" }],
        succes: { 200: objet({ morceaux: { type: "integer", description: "Morceaux supprimés" } }) },
        erreurs: [404, 422],
      }),
    },
    "base",
    { type: "string", pattern: "^[a-z0-9_-]{1,60}$" },
  ),
  "/v1/public/crochets/{jeton}": avecId(
    Object.fromEntries(
      ["get", "post", "put", "patch", "delete"].map((m) => [
        m,
        op({
          resume: "Webhook entrant d'un workflow (202 : exécution en file ; réponse « fin » : sortie du workflow)",
          tag: T,
          succes: { 200: { type: "object" }, 202: objet({ recu: { type: "boolean" } }) },
          erreurs: [404, 409],
        }),
      ]),
    ),
    "jeton",
    str,
  ),
};

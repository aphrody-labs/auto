// Lot pa : connexion du tenant à sa plateforme agréée, dépôt des factures émises, statuts du cycle de
// vie, webhook entrant signé, réception des factures, annuaire, e-reporting.
import {
  chiffrer,
  estStatut,
  PLATEFORMES,
  plateforme,
  secretAleatoire,
  sha256,
  STATUTS,
  type EvenementPa,
  type Ereporting,
  type Identifiants,
  type Mandat,
  type NomPlateforme,
  type StatutCycle,
} from "@auto/pa";
import {
  connecterPa,
  creerDepot,
  deconnecterPa,
  depotActif,
  depotParIdPa,
  enregistrerEreporting,
  ErreurMetier,
  lire,
  lireConnexionPa,
  lireDepot,
  lireFichier,
  lireRecuePa,
  listerDepots,
  listerEreporting,
  listerRecuesPa,
  statutsDepot,
  withTenant,
} from "@auto/store";
import { entreprise } from "@auto/tenancy";
import type { BunRequest } from "bun";
import type { Module, Chemins } from "../modules";
import { avecId, brut, enumere, liste, objet, op, uuid } from "../openapi-outils";
import {
  type EvenementLot,
  UUID,
  VENDEUR,
  cleMaitre,
  options,
  pa,
  connexion,
  synchroniser,
  exigerConnexion,
  appliquerStatut,
  reporter,
  recevoir,
  lireMandat,
} from "@auto/services/pa";

export const routes: Module = ({ sql, publier, pub, auth }) => {
  /** Publication hors transaction métier : l'événement entre dans l'outbox par sa propre transaction. */
  const emettre = (type: EvenementLot, tenantId: string, data: unknown) =>
    withTenant(sql, tenantId, (tx) => publier(tx, type, data));

  return {
    "/v1/pa": {
      GET: auth("lire", async (_req, a) => {
        const c = await withTenant(sql, a.tenantId, (tx) => lireConnexionPa(tx));
        if (!c) return Response.json({ erreur: "aucune plateforme agréée connectée" }, { status: 404 });
        return Response.json({
          plateforme: c.plateforme,
          mandat: c.mandat,
          mandatReference: c.mandatReference,
          connecteLe: c.connecteLe,
          webhook: `/v1/pa/webhook/${a.tenantId}`,
        });
      }),
      PUT: auth("parametres", async (req, a) => {
        const b = (await req.json()) as {
          plateforme: NomPlateforme;
          identifiants?: Record<string, string>;
          mandat?: Partial<Mandat>;
        };
        if (!PLATEFORMES.includes(b.plateforme))
          throw new ErreurMetier("plateforme inconnue", [`attendu : ${PLATEFORMES.join(", ")}`]);
        // La PA simulée sert au développement et aux tests : en production, seules les PA réelles se connectent.
        if (b.plateforme === "mock" && Bun.env.NODE_ENV === "production")
          throw new ErreurMetier("plateforme simulée indisponible en production", ["attendu : b2brouter"]);
        const e = await entreprise(sql, a.tenantId);
        const mandat = lireMandat(b.mandat, e.siret.slice(0, 9));
        // Mock : compte et secret de webhook fixés par le serveur (un compte simulé par tenant).
        const ids: Identifiants =
          b.plateforme === "mock"
            ? { compte: a.tenantId, secretWebhook: secretAleatoire() }
            : {
                cleApi: b.identifiants?.cleApi ?? "",
                compte: b.identifiants?.compte ?? "",
                secretWebhook: b.identifiants?.secretWebhook ?? "",
              };
        const p = await pa(async () => plateforme(b.plateforme, ids, options()));
        const { reference } = await pa(() => p.mandater(mandat));
        const chiffre = await chiffrer(cleMaitre(), a.tenantId, ids);
        await withTenant(sql, a.tenantId, (tx) =>
          connecterPa(tx, a.userId, {
            plateforme: b.plateforme,
            identifiants: chiffre,
            mandat,
            mandatReference: reference,
          }),
        );
        return Response.json({
          plateforme: b.plateforme,
          mandat,
          mandatReference: reference,
          webhook: `/v1/pa/webhook/${a.tenantId}`,
          // Secret à reporter dans la PA simulée ; pour une PA réelle, c'est elle qui le fournit.
          ...(b.plateforme === "mock" ? { secretWebhook: (ids as { secretWebhook: string }).secretWebhook } : {}),
        });
      }),
      DELETE: auth("parametres", async (_req, a) => {
        const ok = await withTenant(sql, a.tenantId, (tx) => deconnecterPa(tx, a.userId));
        return ok
          ? new Response(null, { status: 204 })
          : Response.json({ erreur: "aucune connexion" }, { status: 404 });
      }),
    },

    "/v1/pa/depots": {
      GET: auth("lire", async (_req, a) => Response.json(await withTenant(sql, a.tenantId, (tx) => listerDepots(tx)))),
      POST: auth("ecrire", async (req, a) => {
        const { documentId } = (await req.json()) as { documentId: string };
        if (!UUID.test(documentId ?? "")) throw new ErreurMetier("documentId invalide");
        // Document verrouillé pendant le dépôt : deux dépôts simultanés de la même facture sont exclus.
        const d = await withTenant(sql, a.tenantId, async (tx) => {
          await tx`SELECT id FROM document WHERE id = ${documentId} FOR UPDATE`;
          const doc = await lire(tx, documentId);
          if (!doc) throw new ErreurMetier("document introuvable", [], 404);
          if (doc.type === "devis" || doc.statut === "brouillon")
            throw new ErreurMetier("seule une facture, un acompte ou un avoir émis se dépose", [], 409);
          if (await depotActif(tx, documentId)) throw new ErreurMetier("facture déjà déposée", [], 409);
          const f = await lireFichier(tx, documentId, "facturx");
          if (!f) throw new ErreurMetier("exemplaire Factur-X introuvable", [], 409);
          const c = await exigerConnexion(tx, a.tenantId);
          const siren = doc.data.client.siret?.replace(/\s/g, "").slice(0, 9) || null;
          const r = await pa(() => c.p.deposer({ facturx: f.contenu, numero: doc.numero!, destinataireSiren: siren }));
          const depot = await creerDepot(tx, a.userId, {
            documentId,
            plateforme: c.nom,
            idPa: r.idPa,
            sha256: sha256(f.contenu),
            premier: {
              statut: r.statut,
              code: STATUTS[r.statut],
              motif: r.motif,
              source: "depot",
              at: new Date().toISOString(),
            },
          });
          await reporter(tx, a.userId, documentId, r.statut);
          return depot;
        });
        await emettre("pa.statut", a.tenantId, d);
        return Response.json(d, { status: 201 });
      }),
    },

    "/v1/pa/depots/:id": {
      GET: auth("lire", async (req: BunRequest<"/v1/pa/depots/:id">, a) => {
        if (!UUID.test(req.params.id)) return Response.json({ erreur: "introuvable" }, { status: 404 });
        const r = await withTenant(sql, a.tenantId, async (tx) => {
          const d = await lireDepot(tx, req.params.id);
          return d && { ...d, statuts: await statutsDepot(tx, d.id) };
        });
        return r ? Response.json(r) : Response.json({ erreur: "introuvable" }, { status: 404 });
      }),
    },

    "/v1/pa/depots/:id/statut": {
      POST: auth("ecrire", async (req: BunRequest<"/v1/pa/depots/:id/statut">, a) => {
        const { statut, motif } = (await req.json()) as { statut: StatutCycle; motif?: string };
        if (!VENDEUR.includes(statut)) throw new ErreurMetier(`statut attendu : ${VENDEUR.join(", ")}`);
        if (!UUID.test(req.params.id)) throw new ErreurMetier("dépôt introuvable", [], 404);
        const d = await withTenant(sql, a.tenantId, async (tx) => {
          const dep = await lireDepot(tx, req.params.id);
          if (!dep) throw new ErreurMetier("dépôt introuvable", [], 404);
          const c = await exigerConnexion(tx, a.tenantId);
          await pa(() => c.p.signaler(dep.idPa, statut, motif));
          return appliquerStatut(tx, dep.id, dep.documentId, {
            statut,
            motif,
            source: "vendeur",
            at: new Date().toISOString(),
          });
        });
        if (d) await emettre("pa.statut", a.tenantId, d);
        return Response.json(d);
      }),
    },

    "/v1/pa/synchroniser": {
      POST: auth("ecrire", async (_req, a) => Response.json(await synchroniser(sql, publier, a.tenantId))),
    },

    "/v1/pa/webhook/:tenant": {
      POST: pub(async (req: BunRequest<"/v1/pa/webhook/:tenant">) => {
        const tenantId = req.params.tenant;
        if (!UUID.test(tenantId)) return Response.json({ erreur: "introuvable" }, { status: 404 });
        const corps = await req.text();
        const c = await withTenant(sql, tenantId, (tx) => connexion(tx, tenantId));
        if (!c) return Response.json({ erreur: "introuvable" }, { status: 404 });
        let evs: EvenementPa[] | null;
        try {
          evs = await c.p.webhook(corps, req.headers);
        } catch {
          evs = null;
        }
        if (!evs) return Response.json({ erreur: "signature invalide" }, { status: 401 });
        let traites = 0;
        for (const ev of evs) {
          if (ev.type === "statut") {
            if (!estStatut(ev.statut)) continue;
            const d = await withTenant(sql, tenantId, async (tx) => {
              const dep = await depotParIdPa(tx, c.nom, ev.idPa);
              return dep && appliquerStatut(tx, dep.id, dep.documentId, { ...ev, source: "webhook", at: ev.date });
            });
            if (d) {
              traites++;
              await emettre("pa.statut", tenantId, d);
            }
          } else {
            const r = await recevoir(sql, tenantId, c, ev.idPa, ev.date);
            if (r) {
              traites++;
              await emettre("facture.recue", tenantId, r);
            }
          }
        }
        return Response.json({ traites });
      }),
    },

    "/v1/pa/recues": {
      GET: auth("lire", async (_req, a) =>
        Response.json(await withTenant(sql, a.tenantId, (tx) => listerRecuesPa(tx))),
      ),
    },
    "/v1/pa/recues/:id": {
      GET: auth("lire", async (req: BunRequest<"/v1/pa/recues/:id">, a) => {
        const r =
          UUID.test(req.params.id) && (await withTenant(sql, a.tenantId, (tx) => lireRecuePa(tx, req.params.id)));
        if (!r) return Response.json({ erreur: "introuvable" }, { status: 404 });
        const { contenu: _, ...meta } = r;
        return Response.json(meta);
      }),
    },
    "/v1/pa/recues/:id/pdf": {
      GET: auth("lire", async (req: BunRequest<"/v1/pa/recues/:id/pdf">, a) => {
        const r =
          UUID.test(req.params.id) && (await withTenant(sql, a.tenantId, (tx) => lireRecuePa(tx, req.params.id)));
        if (!r) return Response.json({ erreur: "introuvable" }, { status: 404 });
        return new Response(r.contenu, { headers: { "content-type": "application/pdf", etag: `"${r.sha256}"` } });
      }),
    },

    "/v1/pa/annuaire/:siren": {
      GET: auth("lire", async (req: BunRequest<"/v1/pa/annuaire/:siren">, a) => {
        if (!/^\d{9}$/.test(req.params.siren)) throw new ErreurMetier("SIREN attendu : 9 chiffres");
        const c = await withTenant(sql, a.tenantId, (tx) => exigerConnexion(tx, a.tenantId));
        const r = await pa(() => c.p.annuaire(req.params.siren));
        return r ? Response.json(r) : Response.json({ erreur: "non inscrit à l'annuaire" }, { status: 404 });
      }),
    },

    "/v1/pa/ereporting": {
      GET: auth("lire", async (_req, a) =>
        Response.json(await withTenant(sql, a.tenantId, (tx) => listerEreporting(tx))),
      ),
      POST: auth("ecrire", async (req, a) => {
        const e = (await req.json()) as Ereporting;
        if (e.nature !== "b2c" && e.nature !== "international")
          throw new ErreurMetier("nature attendue : b2c ou international");
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.periode ?? "")) throw new ErreurMetier("periode attendue : AAAA-MM");
        if (!Array.isArray(e.lignes) || e.lignes.some((l) => ![l.tva, l.htCents, l.tvaCents].every(Number.isInteger)))
          throw new ErreurMetier("lignes : tva, htCents et tvaCents entiers");
        const decl = { nature: e.nature, periode: e.periode, lignes: e.lignes };
        const c = await withTenant(sql, a.tenantId, (tx) => exigerConnexion(tx, a.tenantId));
        const r = await pa(() => c.p.ereporting(decl));
        const out = await withTenant(sql, a.tenantId, (tx) =>
          enregistrerEreporting(tx, a.userId, {
            plateforme: c.nom,
            idPa: r.idPa,
            statut: r.statut,
            nature: decl.nature,
            periode: decl.periode,
            data: decl,
          }),
        );
        return Response.json(out, { status: 201 });
      }),
    },
  };
};

/** Description OpenAPI des routes du lot. */
export const openapi: Chemins = {
  "/v1/pa": {
    get: op({
      resume: "Plateforme agréée connectée (sans secrets)",
      tag: "PA",
      droit: "lire",
      succes: { 200: objet({}) },
    }),
    put: op({
      resume: "Connecter une PA (b2brouter ; mock hors production) avec le mandat ; identifiants chiffrés au repos",
      tag: "PA",
      droit: "parametres",
      corps: objet({ plateforme: enumere("mock", "b2brouter"), identifiants: objet({}), mandat: objet({}) }, [
        "plateforme",
      ]),
      succes: { 200: objet({}) },
      erreurs: [422],
    }),
    delete: op({ resume: "Déconnecter la PA", tag: "PA", droit: "parametres", succes: { 204: null } }),
  },
  "/v1/pa/depots": {
    get: op({
      resume: "Dépôts de factures auprès de la PA",
      tag: "PA",
      droit: "lire",
      succes: { 200: liste(objet({})) },
    }),
    post: op({
      resume: "Déposer une facture émise (exemplaire Factur-X figé)",
      tag: "PA",
      droit: "ecrire",
      corps: objet({ documentId: uuid }, ["documentId"]),
      succes: { 201: objet({}) },
      erreurs: [404, 409, 422],
    }),
  },
  "/v1/pa/depots/{id}": avecId({
    get: op({ resume: "Dépôt et ses statuts", tag: "PA", droit: "lire", succes: { 200: objet({}) }, erreurs: [404] }),
  }),
  "/v1/pa/depots/{id}/statut": avecId({
    post: op({
      resume: "Relever le statut d'un dépôt auprès de la PA",
      tag: "PA",
      droit: "ecrire",
      succes: { 200: objet({}) },
      erreurs: [404],
    }),
  }),
  "/v1/pa/synchroniser": {
    post: op({
      resume: "Relever statuts et factures entrantes (sans webhook)",
      tag: "PA",
      droit: "ecrire",
      succes: { 200: objet({}) },
    }),
  },
  "/v1/pa/webhook/{tenant}": avecId(
    {
      post: op({
        resume: "Webhook de la PA (signature vérifiée avec le secret du tenant)",
        tag: "PA",
        corps: objet({}),
        succes: { 200: objet({}) },
        erreurs: [400, 401],
      }),
    },
    "tenant",
  ),
  "/v1/pa/recues": {
    get: op({ resume: "Factures reçues par la PA", tag: "PA", droit: "lire", succes: { 200: liste(objet({})) } }),
  },
  "/v1/pa/recues/{id}": avecId({
    get: op({
      resume: "Facture reçue par la PA",
      tag: "PA",
      droit: "lire",
      succes: { 200: objet({}) },
      erreurs: [404],
    }),
  }),
  "/v1/pa/recues/{id}/pdf": avecId({
    get: op({
      resume: "Factur-X reçu",
      tag: "PA",
      droit: "lire",
      succes: { 200: brut("application/pdf") },
      erreurs: [404],
    }),
  }),
  "/v1/pa/annuaire/{siren}": avecId(
    {
      get: op({
        resume: "Annuaire : plateforme de réception d'un SIREN",
        tag: "PA",
        droit: "lire",
        succes: { 200: objet({}) },
        erreurs: [404],
      }),
    },
    "siren",
    { type: "string", pattern: "^[0-9]{9}$" },
  ),
  "/v1/pa/ereporting": {
    get: op({ resume: "Transmissions d'e-reporting", tag: "PA", droit: "lire", succes: { 200: liste(objet({})) } }),
    post: op({
      resume: "Transmettre un e-reporting (B2C, international)",
      tag: "PA",
      droit: "ecrire",
      corps: objet({}),
      succes: { 201: objet({}) },
      erreurs: [422],
    }),
  },
};

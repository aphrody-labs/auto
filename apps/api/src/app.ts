import {
  avecMentionsParDefaut,
  totaux,
  type Document,
  type Employe,
  type Partie,
  type Statut,
  type StatutAbsence,
  type Type,
  type TypeAbsence,
} from "@auto/domain";
import {
  changerStatut,
  affecterDocument,
  affectationDocument,
  creerBrouillon,
  emettre,
  enregistrerFichier,
  lireFichier,
  lireGabarit,
  ErreurMetier,
  lire,
  lister,
  modifierBrouillon,
  supprimerBrouillon,
  verifierAudit,
  withTenant,
  aRelancer,
  creerClient,
  creerProduit,
  enregistrerPaiement,
  lireClient,
  listerClients,
  listerPaiements,
  listerProduits,
  marquerRelance,
  modifierClient,
  resteDu,
  creerEmploye,
  deciderAbsence,
  demanderAbsence,
  lireEmploye,
  listerAbsences,
  listerEmployes,
  modifierEmploye,
  soldeConges,
  type Produit,
  type Sql,
  type Tx,
} from "@auto/store";
import {
  appelant,
  creerAuth,
  enregistrerAuth,
  entreprise,
  exiger,
  exigerSegments,
  rechercherSiren,
  type Action,
  type Auth,
  type OptionsAuth,
} from "@auto/tenancy";
import { extraireXml, facturx, rendrePdf, totalTtcCents } from "@auto/native";
import type { BunRequest } from "bun";
import { outbox, type Emetteur } from "@auto/services";
import { specificationComplete } from "./openapi";
import type { Contexte } from "./modules";
import { noterTenant } from "./observabilite";
import * as comptes from "./modules/comptes";
import * as imports from "./modules/imports";
import * as pa from "./modules/pa";
import * as mail from "./modules/mail";
import * as courrier from "./modules/courrier";
import * as ingest from "./modules/ingest";
import * as abonnement from "./modules/abonnement";
import * as conformite from "./modules/conformite";
import * as gabarit from "./modules/gabarit";
import * as webhooks from "./modules/webhooks";
import * as admin from "./modules/admin";
import * as agentsAdmin from "./modules/agents-admin";
import * as devisPublic from "./modules/devis-public";
import * as encaissement from "./modules/encaissement";
import * as automatisations from "./modules/automatisations";
import * as chantiers from "./modules/chantiers";
import * as arrivages from "./modules/arrivages";
import * as atelier from "./modules/atelier";
import * as importsFichiers from "./modules/imports-fichiers";

export const MODULES = [
  comptes,
  imports,
  importsFichiers,
  pa,
  mail,
  courrier,
  ingest,
  abonnement,
  conformite,
  gabarit,
  webhooks,
  admin,
  agentsAdmin,
  devisPublic,
  encaissement,
  automatisations,
  chantiers,
  arrivages,
  atelier,
];

const TYPES: Type[] = ["devis", "facture", "acompte", "avoir"];
function erreur(e: unknown): Response {
  if (e instanceof ErreurMetier) return Response.json({ erreur: e.message, details: e.details }, { status: e.status });
  if (e instanceof SyntaxError) return Response.json({ erreur: "JSON invalide" }, { status: 400 });
  console.error(e);
  return Response.json({ erreur: "erreur interne" }, { status: 500 });
}

/** Session Better Auth portée par cookie (`auto.session_token`, préfixé `__Secure-` en HTTPS). */
const cookieSession = (req: Request) =>
  /(?:^|;\s*)(?:__Secure-)?auto\.session_token=/.test(req.headers.get("cookie") ?? "");

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Anti-CSRF : une modification authentifiée par cookie doit être en JSON. Un formulaire d'un autre
 * site ne peut pas envoyer ce type sans pré-requête CORS. Les jetons Bearer ne sont pas concernés.
 */
function csrfRefuse(req: Request): boolean {
  if (!MUTATIONS.has(req.method) || req.headers.get("authorization")?.startsWith("Bearer ")) return false;
  if (!cookieSession(req)) return false;
  // Cette route vérifie ensuite l’Origin exact de Better Auth avant de lire le formulaire.
  if (
    req.method === "POST" &&
    new URL(req.url).pathname === "/v1/imports-fichiers" &&
    req.headers.get("x-auto-import") === "1" &&
    req.headers.get("content-type")?.startsWith("multipart/form-data;")
  )
    return false;
  return !(req.headers.get("content-type") ?? "").startsWith("application/json");
}

export interface OptionsApp {
  /** Better Auth : origine publique, secret, limitation de débit (packages/tenancy/src/auth.ts). */
  auth?: OptionsAuth;
}

export function creerApp(sql: Sql, publier: Emetteur = outbox, options: OptionsApp = {}) {
  const ba = enregistrerAuth(sql, creerAuth(sql, options.auth));
  /** Route publique : erreurs métier converties en réponses JSON. */
  const pub =
    <R extends Request>(fn: (req: R) => Promise<Response>) =>
    async (req: R) => {
      try {
        return await fn(req);
      } catch (e) {
        return erreur(e);
      }
    };

  /** Route authentifiée : droit exigé, puis transaction isolée sur le tenant de l'appelant. */
  const auth = <R extends Request>(action: Action, fn: (req: R, a: Auth) => Promise<Response>) =>
    pub(async (req: R) => {
      if (csrfRefuse(req)) return Response.json({ erreur: "Content-Type application/json requis" }, { status: 415 });
      const a = await appelant(sql, req);
      if (!a) return Response.json({ erreur: "non authentifié" }, { status: 401 });
      noterTenant(a.tenantId);
      exiger(a, action);
      exigerSegments(a, req);
      return fn(req, a);
    });

  /**
   * Mentions de l'émetteur imposées par le serveur depuis la fiche entreprise ; avec `clientId`,
   * le client est relu (sous RLS) depuis la fiche client enregistrée.
   */
  async function normaliser(
    a: Auth,
    tx: Tx,
    body: unknown,
  ): Promise<{ doc: Document; clientId: string | null; chantierId: string | null | undefined }> {
    const {
      clientId = null,
      chantierId,
      ...d
    } = (body ?? {}) as Partial<Document> & { clientId?: string | null; chantierId?: string | null };
    if (!TYPES.includes(d.type as Type)) throw new ErreurMetier("type invalide", [`attendu : ${TYPES.join(", ")}`]);
    if (!Array.isArray(d.lignes)) throw new ErreurMetier("lignes manquantes");
    let client = d.client;
    if (clientId) {
      const c = await lireClient(tx, clientId);
      if (!c) throw new ErreurMetier("client enregistré introuvable", [], 404);
      const { id: _, ...partie } = c;
      client = partie;
    }
    if (!client) throw new ErreurMetier("client manquant");
    const e = await entreprise(sql, a.tenantId);
    const doc = avecMentionsParDefaut({
      ...(d as Document),
      client,
      date: d.date ?? new Date().toISOString().slice(0, 10),
      emetteur: { nom: e.nom, siret: e.siret, adresse: e.adresse, tvaIntracom: e.tvaIntracom ?? undefined },
      franchiseTva: e.franchiseTva,
    });
    return { doc, clientId, chantierId };
  }

  const avecTotaux = <T extends { data: Document }>(d: T) => ({ ...d, totaux: totaux(d.data.lignes) });
  const ctx: Contexte = { sql, publier, pub, auth, ba };

  // Quotas du plan (lot abonnement) appliqués aux points d'entrée concernés.
  return abonnement.appliquerQuotas(sql, {
    ...Object.assign({}, ...MODULES.map((m) => m.routes(ctx))),
    // Version livrée : identifiant de livraison et commit Git posés par scripts/release-vps.ts.
    "/health": () =>
      Response.json({ ok: true, version: Bun.env.AUTO_VERSION ?? null, commit: Bun.env.AUTO_COMMIT ?? null }),
    "/v1/openapi.json": {
      GET: async () => Response.json(await specificationComplete(() => ba.api.generateOpenAPISchema())),
    },

    "/v1/siren/:siren": {
      GET: pub(async (req: BunRequest<"/v1/siren/:siren">) => {
        const r = await rechercherSiren(req.params.siren);
        return r ? Response.json(r) : Response.json({ erreur: "siren inconnu" }, { status: 404 });
      }),
    },

    "/v1/documents": {
      GET: auth("lire", async (req, a) => {
        const t = new URL(req.url).searchParams.get("type") as Type | null;
        const docs = await withTenant(sql, a.tenantId, (tx) => lister(tx, t && TYPES.includes(t) ? t : undefined));
        return Response.json(docs.map(avecTotaux));
      }),
      POST: auth("ecrire", async (req, a) => {
        const body = await req.json();
        const d = await withTenant(sql, a.tenantId, async (tx) => {
          const { doc, clientId, chantierId } = await normaliser(a, tx, body);
          const d = await creerBrouillon(tx, a.userId, doc, clientId);
          if (chantierId !== undefined) await affecterDocument(tx, a.userId, d.id, chantierId);
          return d;
        });
        return Response.json(avecTotaux(d), { status: 201 });
      }),
    },

    "/v1/documents/:id": {
      GET: auth("lire", async (req: BunRequest<"/v1/documents/:id">, a) => {
        const d = await withTenant(sql, a.tenantId, (tx) => lire(tx, req.params.id));
        return d ? Response.json(avecTotaux(d)) : Response.json({ erreur: "introuvable" }, { status: 404 });
      }),
      PUT: auth("ecrire", async (req: BunRequest<"/v1/documents/:id">, a) => {
        const body = await req.json();
        const d = await withTenant(sql, a.tenantId, async (tx) => {
          const { doc, clientId, chantierId } = await normaliser(a, tx, body);
          const d = await modifierBrouillon(tx, a.userId, req.params.id, doc, clientId);
          const affectation = chantierId === undefined ? (await affectationDocument(tx, d.id)).chantierId : chantierId;
          if (affectation !== null || chantierId !== undefined) await affecterDocument(tx, a.userId, d.id, affectation);
          return d;
        });
        return Response.json(avecTotaux(d));
      }),
      DELETE: auth("ecrire", async (req: BunRequest<"/v1/documents/:id">, a) => {
        await withTenant(sql, a.tenantId, (tx) => supprimerBrouillon(tx, a.userId, req.params.id));
        return new Response(null, { status: 204 });
      }),
    },

    "/v1/documents/:id/emettre": {
      POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/emettre">, a) => {
        // Numérotation et exemplaire figé dans la même transaction : une facture dont le Factur-X
        // n'est pas conforme n'est pas émise.
        const d = await withTenant(sql, a.tenantId, async (tx) => {
          const e = await emettre(tx, a.userId, req.params.id);
          const doc = { ...e.data, numero: e.numero, gabarit: await lireGabarit(tx) };
          if (e.type === "devis") await enregistrerFichier(tx, a.userId, e.id, "pdf", rendrePdf(doc));
          else {
            const fx = facturx(doc, new Date(e.emisAt!));
            // Le Factur-X (calculé en Rust) doit porter exactement le TTC enregistré (calculé en TS).
            const ttcXml = totalTtcCents(extraireXml(fx) ?? "");
            if (ttcXml !== e.ttcCents)
              throw new ErreurMetier(
                "Factur-X incohérent avec la facture : émission annulée",
                [`TTC enregistré ${e.ttcCents}, TTC du XML ${ttcXml}`],
                500,
              );
            await enregistrerFichier(tx, a.userId, e.id, "facturx", fx);
          }
          await publier(tx, "document.emis", avecTotaux(e));
          return e;
        });
        return Response.json(avecTotaux(d));
      }),
    },

    "/v1/documents/:id/pdf": {
      GET: auth("lire", async (req: BunRequest<"/v1/documents/:id/pdf">, a) => {
        const r = await withTenant(sql, a.tenantId, async (tx) => {
          const d = await lire(tx, req.params.id);
          if (!d) return null;
          if (d.statut === "brouillon")
            return { nom: "brouillon", contenu: rendrePdf({ ...d.data, numero: "", gabarit: await lireGabarit(tx) }) };
          const f = await lireFichier(tx, d.id, d.type === "devis" ? "pdf" : "facturx");
          return f && { nom: d.numero!, contenu: f.contenu, sha256: f.sha256 };
        });
        if (!r) return Response.json({ erreur: "introuvable" }, { status: 404 });
        return new Response(r.contenu, {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="${r.nom}.pdf"`,
            ...("sha256" in r ? { etag: `"${r.sha256}"` } : {}),
          },
        });
      }),
    },

    "/v1/documents/:id/xml": {
      GET: auth("lire", async (req: BunRequest<"/v1/documents/:id/xml">, a) => {
        const f = await withTenant(sql, a.tenantId, (tx) => lireFichier(tx, req.params.id, "facturx"));
        const xml = f && extraireXml(f.contenu);
        if (!xml) return Response.json({ erreur: "aucune facture émise" }, { status: 404 });
        return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
      }),
    },

    "/v1/documents/:id/statut": {
      POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/statut">, a) => {
        const { statut } = (await req.json()) as { statut: Statut };
        const d = await withTenant(sql, a.tenantId, async (tx) => {
          const d = await changerStatut(tx, a.userId, req.params.id, statut);
          await publier(tx, "document.statut", avecTotaux(d));
          return d;
        });
        return Response.json(avecTotaux(d));
      }),
    },

    "/v1/clients": {
      GET: auth("lire", async (req, a) => {
        const q = new URL(req.url).searchParams.get("q") ?? undefined;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => listerClients(tx, q)));
      }),
      POST: auth("ecrire", async (req, a) => {
        const p = (await req.json()) as Partie;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => creerClient(tx, a.userId, p)), { status: 201 });
      }),
    },
    "/v1/clients/:id": {
      GET: auth("lire", async (req: BunRequest<"/v1/clients/:id">, a) => {
        const c = await withTenant(sql, a.tenantId, (tx) => lireClient(tx, req.params.id));
        return c ? Response.json(c) : Response.json({ erreur: "introuvable" }, { status: 404 });
      }),
      PUT: auth("ecrire", async (req: BunRequest<"/v1/clients/:id">, a) => {
        const p = (await req.json()) as Partie;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => modifierClient(tx, a.userId, req.params.id, p)));
      }),
    },

    "/v1/produits": {
      GET: auth("lire", async (_req, a) =>
        Response.json(await withTenant(sql, a.tenantId, (tx) => listerProduits(tx))),
      ),
      POST: auth("ecrire", async (req, a) => {
        const p = (await req.json()) as Omit<Produit, "id">;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => creerProduit(tx, a.userId, p)), { status: 201 });
      }),
    },

    "/v1/documents/:id/paiements": {
      GET: auth("lire", async (req: BunRequest<"/v1/documents/:id/paiements">, a) =>
        Response.json(
          await withTenant(sql, a.tenantId, async (tx) => ({
            ...(await resteDu(tx, req.params.id)),
            paiements: await listerPaiements(tx, req.params.id),
          })),
        ),
      ),
      POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/paiements">, a) => {
        const p = (await req.json()) as Parameters<typeof enregistrerPaiement>[3];
        const r = await withTenant(sql, a.tenantId, async (tx) => {
          const r = await enregistrerPaiement(tx, a.userId, req.params.id, p);
          await publier(tx, "paiement.enregistre", { documentId: req.params.id, ...r });
          return r;
        });
        return Response.json(r, { status: 201 });
      }),
    },

    "/v1/relances": {
      GET: auth("lire", async (req, a) => {
        const jour = new URL(req.url).searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        return Response.json(await withTenant(sql, a.tenantId, (tx) => aRelancer(tx, jour)));
      }),
    },
    "/v1/documents/:id/relances": {
      POST: auth("ecrire", async (req: BunRequest<"/v1/documents/:id/relances">, a) => {
        const { niveau, canal = "mail" } = (await req.json()) as {
          niveau: 1 | 2 | 3;
          canal?: "mail" | "courrier" | "telephone";
        };
        await withTenant(sql, a.tenantId, (tx) => marquerRelance(tx, a.userId, req.params.id, niveau, canal));
        return new Response(null, { status: 204 });
      }),
    },

    "/v1/employes": {
      GET: auth("rh", async (req, a) => {
        const tous = new URL(req.url).searchParams.has("tous");
        return Response.json(await withTenant(sql, a.tenantId, (tx) => listerEmployes(tx, tous)));
      }),
      POST: auth("rh", async (req, a) => {
        const e = (await req.json()) as Employe;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => creerEmploye(tx, a.userId, e)), { status: 201 });
      }),
    },
    "/v1/employes/:id": {
      GET: auth("rh", async (req: BunRequest<"/v1/employes/:id">, a) => {
        const e = await withTenant(sql, a.tenantId, (tx) => lireEmploye(tx, req.params.id));
        return e ? Response.json(e) : Response.json({ erreur: "introuvable" }, { status: 404 });
      }),
      PUT: auth("rh", async (req: BunRequest<"/v1/employes/:id">, a) => {
        const e = (await req.json()) as Employe;
        return Response.json(
          await withTenant(sql, a.tenantId, (tx) => modifierEmploye(tx, a.userId, req.params.id, e)),
        );
      }),
    },
    "/v1/employes/:id/conges": {
      GET: auth("rh", async (req: BunRequest<"/v1/employes/:id/conges">, a) => {
        const au = new URL(req.url).searchParams.get("au") ?? undefined;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => soldeConges(tx, req.params.id, au)));
      }),
    },
    "/v1/employes/:id/absences": {
      GET: auth("rh", async (req: BunRequest<"/v1/employes/:id/absences">, a) =>
        Response.json(await withTenant(sql, a.tenantId, (tx) => listerAbsences(tx, { employeId: req.params.id }))),
      ),
      POST: auth("rh", async (req: BunRequest<"/v1/employes/:id/absences">, a) => {
        const b = (await req.json()) as { type: TypeAbsence; debut: string; fin: string; motif?: string };
        const r = await withTenant(sql, a.tenantId, async (tx) => {
          const r = await demanderAbsence(tx, a.userId, req.params.id, b);
          await publier(tx, "absence.demandee", r);
          return r;
        });
        return Response.json(r, { status: 201 });
      }),
    },
    "/v1/absences": {
      GET: auth("rh", async (req, a) => {
        const statut = (new URL(req.url).searchParams.get("statut") ?? undefined) as StatutAbsence | undefined;
        return Response.json(await withTenant(sql, a.tenantId, (tx) => listerAbsences(tx, { statut })));
      }),
    },
    "/v1/absences/:id/decision": {
      POST: auth("rh", async (req: BunRequest<"/v1/absences/:id/decision">, a) => {
        const { statut } = (await req.json()) as { statut: Exclude<StatutAbsence, "demandee"> };
        if (!["validee", "refusee", "annulee"].includes(statut))
          throw new ErreurMetier("statut attendu : validee, refusee ou annulee");
        const r = await withTenant(sql, a.tenantId, async (tx) => {
          const r = await deciderAbsence(tx, a.userId, req.params.id, statut);
          await publier(tx, "absence.decidee", r);
          return r;
        });
        return Response.json(r);
      }),
    },

    "/v1/audit/verification": {
      GET: auth("lire", async (_req, a) => Response.json(await withTenant(sql, a.tenantId, (tx) => verifierAudit(tx)))),
    },
  });
}

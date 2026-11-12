// Lot abonnement : plans, consommation, Stripe (Checkout, portail, webhooks) et garde des quotas.
// Les factures de l'abonnement sont émises par le tenant opérateur (AUTO_TENANT_OPERATEUR), en Factur-X.
import {
  configStripeDepuisEnv,
  consommation,
  consommer,
  estPeriodicite,
  estPlan,
  jourParis,
  definirJauge,
  PAYANTS,
  periode,
  planEffectif,
  PLANS,
  Stripe,
  tarifInverse,
  verifierQuota,
  verifierSignatureStripe,
  type ConfigStripe,
  type EvenementStripe,
  type Periodicite,
  type PlanId,
  type Ressource,
} from "@auto/billing";
import { avecMentionsParDefaut, totaux, type Document } from "@auto/domain";
import { extraireXml, facturx, totalTtcCents } from "@auto/native";
import {
  conclureEvenementStripe,
  creerBrouillon,
  creerClient,
  emettre,
  enregistrerFichier,
  enregistrerPaiement,
  ErreurMetier,
  factureStripeEmise,
  lire,
  lireAbonnement,
  listerClients,
  majAbonnement,
  poserTenant,
  recevoirEvenementStripe,
  withTenant,
  type Abonnement,
  type Ligne,
  type Sql,
  type Tx,
} from "@auto/store";
import { appelant, entreprise, type Entreprise } from "@auto/tenancy";
import type { BunRequest } from "bun";
import type { Module } from "../modules";
import { enumere, liste, objet, op, str } from "../openapi-outils";
import type { Chemins } from "../modules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EN_COURS = new Set(["trialing", "active", "past_due"]);

export interface ConfigAbonnement {
  stripe: ConfigStripe | null;
  /** Tenant qui émet les factures de l'abonnement. */
  operateur: string | null;
  /** Adresse de contact facturation de l'opérateur, portée sur ses factures. */
  emailOperateur: string;
  /** Base des URL de retour (Checkout, portail). */
  urlApp: string;
}

export const EMAIL_OPERATEUR = "contact@aphrody.com";

/** Relue à chaque requête : `STRIPE_*`, `AUTO_TENANT_OPERATEUR`, `AUTO_URL_APP`. */
export function configAbonnement(env: Record<string, string | undefined> = Bun.env): ConfigAbonnement {
  return {
    stripe: configStripeDepuisEnv(env),
    operateur: env.AUTO_TENANT_OPERATEUR || null,
    emailOperateur: env.AUTO_EMAIL_OPERATEUR || EMAIL_OPERATEUR,
    urlApp: (env.AUTO_URL_APP ?? "http://localhost:3000").replace(/\/$/, ""),
  };
}

function exigerStripe(c: ConfigAbonnement): ConfigStripe {
  if (!c.stripe) throw new ErreurMetier("paiement en ligne non configuré (STRIPE_SECRET_KEY)", [], 503);
  return c.stripe;
}

const date = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null);
const idDe = (x: unknown) =>
  typeof x === "string" ? x : x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id) : undefined;

// Webhooks -------------------------------------------------------------------

const GERES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

// Objets Stripe : seuls les champs lus sont typés.
interface Meta {
  tenant_id?: string;
  plan?: string;
  periodicite?: string;
  essai?: string;
}
interface ObjetStripe {
  id?: string;
  object?: string;
  mode?: string;
  status?: string;
  customer?: unknown;
  subscription?: unknown;
  client_reference_id?: string | null;
  metadata?: Meta;
  items?: { data?: { price?: { id?: string }; current_period_end?: number }[] };
  trial_end?: number | null;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  amount_paid?: number;
  total_excluding_tax?: number | null;
  subtotal?: number;
  number?: string | null;
  period_start?: number;
  period_end?: number;
  status_transitions?: { paid_at?: number | null };
  lines?: { data?: { period?: { start?: number; end?: number } }[] };
  parent?: { subscription_details?: { metadata?: Meta } };
  subscription_details?: { metadata?: Meta };
}

/** Tenant d'un événement : métadonnées posées par l'application sur le client, le Checkout et l'abonnement. */
function tenantDe(o: ObjetStripe): string | null {
  const t =
    o.client_reference_id ??
    o.metadata?.tenant_id ??
    o.parent?.subscription_details?.metadata?.tenant_id ??
    o.subscription_details?.metadata?.tenant_id;
  return t && UUID.test(t) ? t : null;
}

const metaDe = (o: ObjetStripe): Meta =>
  o.parent?.subscription_details?.metadata ?? o.subscription_details?.metadata ?? o.metadata ?? {};

interface Resultat {
  resultat: string;
  documentId?: string;
  emis?: Ligne;
}

interface Parties {
  operateur: Entreprise & { email: string };
  abonne: Entreprise;
}

async function clientOperateur(tx: Tx, abonne: Entreprise): Promise<string> {
  const c = (await listerClients(tx, abonne.siret)).find((x) => x.siret === abonne.siret);
  if (c) return c.id;
  const p = {
    nom: abonne.nom,
    siret: abonne.siret,
    adresse: abonne.adresse,
    tvaIntracom: abonne.tvaIntracom ?? undefined,
  };
  return (await creerClient(tx, null, p)).id;
}

/**
 * Facture de l'abonnement, émise par le tenant opérateur (tenant courant de `tx`) avec les fonctions
 * de l'API : brouillon, émission numérotée, Factur-X figé contrôlé, puis paiement carte qui la solde.
 */
async function emettreFactureAbonnement(tx: Tx, p: Parties, inv: ObjetStripe, ab: Abonnement): Promise<Ligne> {
  const meta = metaDe(inv);
  const plan = PLANS[estPlan(meta.plan) ? meta.plan : ab.plan];
  const periodicite: Periodicite = estPeriodicite(meta.periodicite) ? meta.periodicite : (ab.periodicite ?? "mensuel");
  const ligne = inv.lines?.data?.[0];
  const debut = jourParis(new Date((ligne?.period?.start ?? inv.period_start ?? 0) * 1000));
  const fin = jourParis(new Date((ligne?.period?.end ?? inv.period_end ?? 0) * 1000));
  const jour = jourParis(inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : undefined);
  const ht = inv.total_excluding_tax ?? inv.subtotal ?? 0;
  const op = p.operateur;
  const doc = avecMentionsParDefaut({
    type: "facture",
    date: jour,
    emetteur: {
      nom: op.nom,
      siret: op.siret,
      adresse: op.adresse,
      tvaIntracom: op.tvaIntracom ?? undefined,
      email: op.email,
    },
    client: {
      nom: p.abonne.nom,
      siret: p.abonne.siret,
      adresse: p.abonne.adresse,
      tvaIntracom: p.abonne.tvaIntracom ?? undefined,
    },
    lignes: [
      {
        designation: `Abonnement auto ${plan.nom} (${periodicite}), du ${debut} au ${fin}`,
        quantite: 1,
        prixUnitaireHtCents: ht,
        tva: op.franchiseTva ? 0 : 200,
      },
    ],
    datePrestation: debut,
    echeance: jour,
    conditionsPaiement: "Payée par carte bancaire (Stripe)",
    franchiseTva: op.franchiseTva,
    notes: `Facture Stripe ${inv.number ?? inv.id}. Contact facturation : ${op.email}`,
  } satisfies Document);
  const ttc = totaux(doc.lignes).ttcCents;
  if (ttc !== inv.amount_paid)
    throw new ErreurMetier(
      "facture Stripe : montant payé différent du TTC de la facture à émettre",
      [`HT ${ht}`, `TTC calculé ${ttc}`, `payé ${inv.amount_paid}`, "vérifier le taux de TVA Stripe (STRIPE_TAUX_TVA)"],
      422,
    );
  const b = await creerBrouillon(tx, null, doc, await clientOperateur(tx, p.abonne));
  const e = await emettre(tx, null, b.id);
  const fx = facturx({ ...e.data, numero: e.numero }, new Date(e.emisAt!));
  const ttcXml = totalTtcCents(extraireXml(fx) ?? "");
  if (ttcXml !== e.ttcCents)
    throw new ErreurMetier("Factur-X incohérent avec la facture : émission annulée", [`TTC du XML ${ttcXml}`], 500);
  await enregistrerFichier(tx, null, e.id, "facturx", fx);
  await enregistrerPaiement(tx, null, e.id, { date: jour, montantCents: e.ttcCents, mode: "carte", reference: inv.id });
  return (await lire(tx, e.id))!;
}

/** Applique un événement, dans `tx` passée au rôle `auto_app`. */
async function appliquer(
  tx: Tx,
  c: ConfigAbonnement,
  evt: EvenementStripe,
  tenantId: string,
  parties: Parties | null,
): Promise<Resultat> {
  const o = evt.data.object as ObjetStripe;
  await poserTenant(tx, tenantId);
  const ab = await lireAbonnement(tx);
  const client = idDe(o.customer);
  if (ab.stripeCustomerId && client && ab.stripeCustomerId !== client) return { resultat: "client_incoherent" };
  const quand = new Date(evt.created * 1000);
  switch (evt.type) {
    case "checkout.session.completed": {
      if (o.mode !== "subscription") return { resultat: "ignore" };
      const m = o.metadata ?? {};
      const essai = m.essai === "1";
      await majAbonnement(
        tx,
        {
          stripeCustomerId: client,
          stripeSubscriptionId: idDe(o.subscription),
          ...(estPlan(m.plan) ? { plan: m.plan } : {}),
          ...(estPeriodicite(m.periodicite) ? { periodicite: m.periodicite } : {}),
          statut: essai ? "trialing" : "active",
          ...(essai ? { essaiUtilise: true as const } : {}),
        },
        quand,
      );
      return { resultat: "abonnement" };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const item = o.items?.data?.[0];
      const m = o.metadata ?? {};
      const t =
        tarifInverse(c.stripe!, item?.price?.id) ??
        (estPlan(m.plan) && estPeriodicite(m.periodicite) ? { plan: m.plan, periodicite: m.periodicite } : {});
      const ok = await majAbonnement(
        tx,
        {
          ...t,
          stripeCustomerId: client,
          stripeSubscriptionId: o.id,
          statut: o.status,
          essaiFin: date(o.trial_end),
          periodeFin: date(o.cancel_at ?? o.current_period_end ?? item?.current_period_end),
          annulationFinPeriode: !!o.cancel_at_period_end || (typeof o.cancel_at === "number" && o.cancel_at > 0),
          ...(o.trial_end ? { essaiUtilise: true as const } : {}),
        },
        quand,
      );
      return { resultat: ok ? "abonnement" : "perime" };
    }
    case "customer.subscription.deleted":
      await majAbonnement(tx, { statut: "canceled", annulationFinPeriode: false }, quand);
      return { resultat: "resilie" };
    case "invoice.payment_failed":
      if (ab.statut === "active" || ab.statut === "trialing") await majAbonnement(tx, { statut: "past_due" });
      return { resultat: "impaye" };
    case "invoice.paid": {
      if (ab.statut === "past_due") await majAbonnement(tx, { statut: "active" });
      if (!o.amount_paid || o.amount_paid <= 0) return { resultat: "montant_nul" };
      await poserTenant(tx, c.operateur!);
      const emis = await emettreFactureAbonnement(tx, parties!, o, ab);
      return { resultat: "facture_emise", documentId: emis.id, emis };
    }
  }
  return { resultat: "ignore" };
}

/**
 * Traitement idempotent : l'événement est inscrit (clé primaire = id Stripe) dans la transaction qui
 * l'applique. Un rejeu répond sans effet ; un échec annule tout et Stripe renverra l'événement.
 */
export async function traiterEvenementStripe(sql: Sql, c: ConfigAbonnement, evt: EvenementStripe): Promise<Resultat> {
  const o = evt.data.object as ObjetStripe;
  let tenantId = GERES.has(evt.type) ? tenantDe(o) : null;
  if (tenantId && !(await sql`SELECT 1 FROM tenant WHERE id = ${tenantId}`).length) tenantId = null;
  let parties: Parties | null = null;
  if (evt.type === "invoice.paid" && tenantId && (o.amount_paid ?? 0) > 0) {
    if (!c.operateur || !UUID.test(c.operateur))
      throw new ErreurMetier("AUTO_TENANT_OPERATEUR non configuré : facture d'abonnement non émise", [], 503);
    parties = {
      operateur: { ...(await entreprise(sql, c.operateur)), email: c.emailOperateur },
      abonne: await entreprise(sql, tenantId),
    };
  }
  return sql.begin(async (tx) => {
    const nouveau = await recevoirEvenementStripe(tx, {
      id: evt.id,
      type: evt.type,
      creeAt: new Date(evt.created * 1000),
      objetId: o.id ?? null,
    });
    if (!nouveau) return { resultat: "rejeu" };
    let r: Resultat;
    if (!GERES.has(evt.type)) r = { resultat: "ignore" };
    else if (!tenantId) r = { resultat: "tenant_inconnu" };
    else if (evt.type === "invoice.paid" && o.id && (await factureStripeEmise(tx, o.id)))
      r = { resultat: "facture_deja_emise" };
    else {
      await tx`SET LOCAL ROLE auto_app`;
      r = await appliquer(tx, c, evt, tenantId, parties);
      await tx`SET LOCAL ROLE NONE`;
    }
    await conclureEvenementStripe(tx, evt.id, { resultat: r.resultat, tenantId, documentId: r.documentId });
    return r;
  });
}

// Garde des quotas -------------------------------------------------------------

type Regle = (tx: Tx, req: Request) => Promise<void>;

/**
 * Points d'entrée soumis à quota (chemin Bun.serve → méthode → contrôle dans la transaction du tenant).
 * Les lots mail (boîtes) et agent (appels LLM) ajoutent leur entrée ici, ou appellent `exigerQuota`
 * et `consommerAppelsLlm` depuis leur route.
 */
export const REGLES: Record<string, Partial<Record<"POST" | "PUT", Regle>>> = {
  "/v1/documents/:id/emettre": {
    POST: async (tx, req) => {
      const id = (req as BunRequest<"/v1/documents/:id/emettre">).params?.id;
      if (!id || !UUID.test(id)) return;
      const [d] = await tx<{ type: string }[]>`SELECT type FROM document WHERE id = ${id}`;
      if (!d) return;
      if (d.type === "facture" || d.type === "acompte") await verifierQuota(tx, "factures");
      await verifierQuota(tx, "stockage");
    },
  },
  "/v1/employes": { POST: (tx) => verifierQuota(tx, "employes") },
  // Une boîte déjà connectée est remplacée : seul l'ajout d'une première boîte consomme le quota.
  "/v1/mail/boite": {
    PUT: async (tx) => {
      if (!(await tx`SELECT 1 FROM boite_mail LIMIT 1`).length) await verifierQuota(tx, "boites_mail");
    },
  },
};

definirJauge("boites_mail", async (tx) => (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM boite_mail`)[0]!.n);

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Hook de l'intégrateur : enveloppe les routes `Bun.serve` concernées par `regles`. Avant le
 * gestionnaire, l'appelant authentifié est contrôlé sous RLS ; quota dépassé : 402 explicite. Les
 * requêtes non authentifiées passent telles quelles (le gestionnaire répond 401). Le compteur des
 * factures est tenu par la base (déclencheur `consommation_facture`), dans la transaction d'émission.
 */
export function appliquerQuotas<T extends Record<string, unknown>>(sql: Sql, routes: T, regles = REGLES): T {
  const res: Record<string, unknown> = { ...routes };
  for (const [chemin, methodes] of Object.entries(regles)) {
    const r = res[chemin];
    if (!r || typeof r !== "object") continue;
    const copie: Record<string, unknown> = { ...(r as Record<string, unknown>) };
    for (const [m, regle] of Object.entries(methodes)) {
      const h = copie[m] as Handler | undefined;
      if (typeof h !== "function" || !regle) continue;
      copie[m] = async (req: Request) => {
        const a = await appelant(sql, req);
        if (a) {
          try {
            await withTenant(sql, a.tenantId, (tx) => regle(tx, req));
          } catch (e) {
            if (!(e instanceof ErreurMetier)) throw e;
            return Response.json({ erreur: e.message, details: e.details }, { status: e.status });
          }
        }
        return h(req);
      };
    }
    res[chemin] = copie;
  }
  return res as T;
}

/** Pour les autres lots : 402 si le quota de `r` est atteint pour le tenant. */
export const exigerQuota = (sql: Sql, tenantId: string, r: Ressource, ajout = 1) =>
  withTenant(sql, tenantId, (tx) => verifierQuota(tx, r, ajout));

/** Pour le lot agent : vérifie et compte `n` appels LLM du mois. */
export const consommerAppelsLlm = (sql: Sql, tenantId: string, n = 1) =>
  withTenant(sql, tenantId, (tx) => consommer(tx, "appels_llm", n));

// Routes -----------------------------------------------------------------------

export const routes: Module = ({ sql, publier, pub, auth }) => ({
  "/v1/abonnement/plans": {
    GET: () =>
      Response.json(
        Object.values(PLANS).map((p) => ({ ...p, devise: "EUR", prix: "HT" })),
        { headers: { "cache-control": "public, max-age=3600" } },
      ),
  },

  "/v1/abonnement": {
    GET: auth("lire", async (_req, a) =>
      Response.json(
        await withTenant(sql, a.tenantId, async (tx) => {
          const ab = await lireAbonnement(tx);
          const { stripeCustomerId: _c, stripeSubscriptionId: _s, ...visible } = ab;
          return {
            ...visible,
            planEffectif: planEffectif(ab).id,
            periode: periode(),
            consommation: await consommation(tx),
          };
        }),
      ),
    ),
  },

  "/v1/abonnement/checkout": {
    POST: auth("parametres", async (req, a) => {
      const c = configAbonnement();
      const s = exigerStripe(c);
      const b = (await req.json()) as { plan?: PlanId; periodicite?: Periodicite };
      const periodicite = b.periodicite ?? "mensuel";
      if (!b.plan || !PAYANTS.includes(b.plan)) throw new ErreurMetier("plan attendu : pro ou business");
      if (!estPeriodicite(periodicite)) throw new ErreurMetier("périodicité attendue : mensuel ou annuel");
      const ab = await withTenant(sql, a.tenantId, lireAbonnement);
      if (EN_COURS.has(ab.statut))
        throw new ErreurMetier("abonnement déjà en cours : changer de plan depuis le portail", [], 409);
      const prix = s.tarifs[`${b.plan as "pro" | "business"}_${periodicite}`];
      if (!prix) throw new ErreurMetier(`prix Stripe non configuré pour ${b.plan} ${periodicite}`, [], 503);
      const stripe = new Stripe(s);
      let client = ab.stripeCustomerId;
      if (!client) {
        const e = await entreprise(sql, a.tenantId);
        const [u] = await sql<{ email: string }[]>`SELECT email FROM app_user WHERE id = ${a.userId}`;
        client = (await stripe.creerClient({ tenantId: a.tenantId, nom: e.nom, email: u?.email })).id;
        await withTenant(sql, a.tenantId, (tx) => majAbonnement(tx, { stripeCustomerId: client }));
      }
      const plan = PLANS[b.plan];
      const essaiJours = plan.essaiJours && !ab.essaiUtilise ? plan.essaiJours : 0;
      const retour = `${c.urlApp}/app/parametres`;
      const session = await stripe.creerCheckout({
        tenantId: a.tenantId,
        client,
        prix,
        plan: b.plan,
        periodicite,
        essaiJours,
        succes: `${retour}?checkout=succes&session_id={CHECKOUT_SESSION_ID}`,
        annulation: `${retour}?checkout=annule`,
      });
      return Response.json({ id: session.id, url: session.url, essaiJours }, { status: 201 });
    }),
  },

  "/v1/abonnement/portail": {
    POST: auth("parametres", async (_req, a) => {
      const c = configAbonnement();
      const s = exigerStripe(c);
      const ab = await withTenant(sql, a.tenantId, lireAbonnement);
      if (!ab.stripeCustomerId) throw new ErreurMetier("aucun abonnement Stripe pour cette entreprise", [], 409);
      const p = await new Stripe(s).creerPortail(ab.stripeCustomerId, `${c.urlApp}/app/parametres`);
      return Response.json({ url: p.url }, { status: 201 });
    }),
  },

  "/v1/abonnement/webhook": {
    POST: pub(async (req) => {
      const c = configAbonnement();
      const s = exigerStripe(c);
      const corps = await req.text();
      if (!verifierSignatureStripe(corps, req.headers.get("stripe-signature"), s.secretWebhook))
        return Response.json({ erreur: "signature Stripe invalide" }, { status: 400 });
      const evt = JSON.parse(corps) as EvenementStripe;
      if (typeof evt?.id !== "string" || typeof evt.type !== "string" || !evt.data?.object)
        return Response.json({ erreur: "événement Stripe invalide" }, { status: 400 });
      const r = await traiterEvenementStripe(sql, c, evt);
      if (r.emis && c.operateur)
        await withTenant(sql, c.operateur, (tx) =>
          publier(tx, "document.emis", { ...r.emis!, totaux: totaux(r.emis!.data.lignes) }),
        );
      return Response.json({ recu: true, resultat: r.resultat, documentId: r.documentId ?? null });
    }),
  },
});

/** Description OpenAPI des routes du lot. */
export const openapi: Chemins = {
  "/v1/abonnement/plans": {
    get: op({ resume: "Plans, prix HT et quotas", tag: "Abonnement", succes: { 200: liste(objet({})) } }),
  },
  "/v1/abonnement": {
    get: op({
      resume: "Abonnement courant et consommation de la période",
      tag: "Abonnement",
      droit: "lire",
      succes: { 200: objet({}) },
    }),
  },
  "/v1/abonnement/checkout": {
    post: op({
      resume: "Démarrer un paiement Stripe Checkout",
      tag: "Abonnement",
      droit: "parametres",
      corps: objet({ plan: enumere("pro", "business"), periodicite: enumere("mensuel", "annuel") }, ["plan"]),
      succes: { 201: objet({ url: str }) },
      erreurs: [409, 422, 503],
    }),
  },
  "/v1/abonnement/portail": {
    post: op({
      resume: "Ouvrir le portail client Stripe",
      tag: "Abonnement",
      droit: "parametres",
      succes: { 201: objet({ url: str }) },
      erreurs: [409, 503],
    }),
  },
  "/v1/abonnement/webhook": {
    post: op({
      resume: "Webhook Stripe (signature Stripe-Signature vérifiée)",
      tag: "Abonnement",
      corps: objet({}),
      succes: { 200: objet({ recu: { type: "boolean" } }) },
      erreurs: [400],
    }),
  },
};

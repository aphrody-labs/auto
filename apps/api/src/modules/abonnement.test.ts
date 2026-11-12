import { afterAll, beforeAll, expect, test } from "bun:test";
import { periode, signerStripe } from "@auto/billing";
import { incrementerCompteur, testDb, withTenant, type Sql } from "@auto/store";
import { creerApp } from "../app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let stripe: ReturnType<typeof Bun.serve>;
const SECRET = "whsec_test_auto";
const ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_API_BASE",
  "STRIPE_PRIX_PRO_MENSUEL",
  "STRIPE_PRIX_BUSINESS_ANNUEL",
  "AUTO_TENANT_OPERATEUR",
  "AUTO_URL_APP",
];

/** Requêtes reçues par le faux Stripe : chemin, clé, corps décodé. */
const recues: { chemin: string; auth: string | null; idem: string | null; corps: URLSearchParams }[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  // Faux serveur Stripe : mêmes chemins, même encodage de formulaire que l'API REST.
  stripe = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const corps = new URLSearchParams(await req.text());
      recues.push({
        chemin: u.pathname,
        auth: req.headers.get("authorization"),
        idem: req.headers.get("idempotency-key"),
        corps,
      });
      if (req.headers.get("authorization") !== "Bearer sk_test_faux")
        return Response.json({ error: { message: "Invalid API Key" } }, { status: 401 });
      if (u.pathname === "/v1/customers") return Response.json({ id: "cus_1", object: "customer" });
      if (u.pathname === "/v1/checkout/sessions")
        return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" });
      if (u.pathname === "/v1/billing_portal/sessions")
        return Response.json({ id: "bps_1", url: "https://billing.stripe.test/p/bps_1" });
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });
  Object.assign(Bun.env, {
    STRIPE_SECRET_KEY: "sk_test_faux",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_API_BASE: stripe.url.origin,
    STRIPE_PRIX_PRO_MENSUEL: "price_pro_m",
    STRIPE_PRIX_BUSINESS_ANNUEL: "price_biz_a",
    AUTO_URL_APP: "https://app.auto.test",
  });
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  for (const k of ENV) delete Bun.env[k];
  await server.stop(true);
  await stripe.stop(true);
  await drop();
});

async function api(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(new URL(path, server.url), {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function webhook(evt: object, signature?: string) {
  const corps = JSON.stringify(evt);
  const res = await fetch(new URL("/v1/abonnement/webhook", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature ?? signerStripe(SECRET, corps) },
    body: corps,
  });
  return { status: res.status, body: await res.json() };
}

const inscription = (email: string, nom: string) => ({
  email,
  motDePasse: "un mot de passe long",
  entreprise: { nom, siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
});

const evenement = (id: string, type: string, object: object, created = Math.floor(Date.now() / 1000)) => ({
  id,
  object: "event",
  type,
  created,
  data: { object },
});

test("plans publics", async () => {
  const r = await api("/v1/abonnement/plans");
  expect(r.status).toBe(200);
  expect(r.body.map((p: { id: string }) => p.id)).toEqual(["gratuit", "pro", "business"]);
  expect(r.body[1]).toMatchObject({ prixHtCents: { mensuel: 1400, annuel: 14000 }, essaiJours: 30, prix: "HT" });
});

test("Checkout, webhooks signés et idempotents, facture émise par l'opérateur", async () => {
  const op = await api("/v1/auth/inscription", undefined, { body: inscription("contact@aphrody.com", "Aphrody SAS") });
  Bun.env.AUTO_TENANT_OPERATEUR = op.body.tenantId;
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("abonne@exemple.fr", "Abonné SARL") });
  const t = a.body.session;
  const tenant = a.body.tenantId;

  const ab0 = await api("/v1/abonnement", t);
  expect(ab0.body).toMatchObject({ plan: "gratuit", statut: "aucun", planEffectif: "gratuit", periode: periode() });
  expect(ab0.body.consommation.find((c: { ressource: string }) => c.ressource === "factures")).toMatchObject({
    utilise: 0,
    limite: 10,
  });
  expect(ab0.body.stripeCustomerId).toBeUndefined();

  // Portail sans client Stripe ; plan invalide ; prix non configuré.
  expect((await api("/v1/abonnement/portail", t, { body: {} })).status).toBe(409);
  expect((await api("/v1/abonnement/checkout", t, { body: { plan: "gratuit" } })).status).toBe(422);
  expect((await api("/v1/abonnement/checkout", t, { body: { plan: "pro", periodicite: "annuel" } })).status).toBe(503);

  // Checkout : client Stripe créé (idempotent par tenant), essai de 30 jours sur Pro.
  const co = await api("/v1/abonnement/checkout", t, { body: { plan: "pro" } });
  expect(co.status).toBe(201);
  expect(co.body).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1", essaiJours: 30 });
  const [client, session] = recues.slice(-2);
  expect(client!.chemin).toBe("/v1/customers");
  expect(client!.idem).toBe(`client-${tenant}`);
  expect(client!.corps.get("metadata[tenant_id]")).toBe(tenant);
  expect(client!.corps.get("email")).toBe("abonne@exemple.fr");
  expect(session!.chemin).toBe("/v1/checkout/sessions");
  expect(session!.corps.get("mode")).toBe("subscription");
  expect(session!.corps.get("customer")).toBe("cus_1");
  expect(session!.corps.get("client_reference_id")).toBe(tenant);
  expect(session!.corps.get("line_items[0][price]")).toBe("price_pro_m");
  expect(session!.corps.get("subscription_data[trial_period_days]")).toBe("30");
  expect(session!.corps.get("subscription_data[metadata][tenant_id]")).toBe(tenant);
  expect(session!.corps.get("success_url")).toBe(
    "https://app.auto.test/app/parametres?checkout=succes&session_id={CHECKOUT_SESSION_ID}",
  );
  expect(session!.corps.get("cancel_url")).toBe("https://app.auto.test/app/parametres?checkout=annule");

  // Signature absente, fausse ou périmée : 400.
  const e1 = evenement("evt_1", "checkout.session.completed", {
    id: "cs_test_1",
    object: "checkout.session",
    mode: "subscription",
    customer: "cus_1",
    subscription: "sub_1",
    client_reference_id: tenant,
    metadata: { tenant_id: tenant, plan: "pro", periodicite: "mensuel", essai: "1" },
  });
  expect((await webhook(e1, "t=1,v1=00")).status).toBe(400);
  expect((await webhook(e1, signerStripe("whsec_autre", JSON.stringify(e1)))).status).toBe(400);
  expect((await webhook(e1, signerStripe(SECRET, JSON.stringify(e1), 1_000_000))).status).toBe(400);

  // Checkout terminé : abonnement en essai ; rejeu sans effet.
  expect((await webhook(e1)).body).toMatchObject({ recu: true, resultat: "abonnement" });
  expect((await webhook(e1)).body).toMatchObject({ recu: true, resultat: "rejeu" });
  const ab1 = await api("/v1/abonnement", t);
  expect(ab1.body).toMatchObject({ plan: "pro", statut: "trialing", planEffectif: "pro", essaiUtilise: true });
  expect(ab1.body.consommation.find((c: { ressource: string }) => c.ressource === "factures").limite).toBe(200);
  expect((await api("/v1/abonnement/checkout", t, { body: { plan: "business" } })).status).toBe(409);
  expect((await api("/v1/abonnement/portail", t, { body: {} })).body.url).toBe("https://billing.stripe.test/p/bps_1");
  expect(recues.at(-1)!.corps.get("customer")).toBe("cus_1");
  expect(recues.at(-1)!.corps.get("return_url")).toBe("https://app.auto.test/app/parametres");

  // Mise à jour d'abonnement : prix → plan ; un événement plus ancien est ignoré.
  const maintenant = Math.floor(Date.now() / 1000);
  const sub = {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    metadata: { tenant_id: tenant, plan: "pro", periodicite: "mensuel" },
    items: { data: [{ price: { id: "price_biz_a" }, current_period_end: maintenant + 365 * 86400 }] },
    trial_end: maintenant - 60,
    cancel_at_period_end: false,
  };
  const maj = await webhook(evenement("evt_2", "customer.subscription.updated", sub, maintenant + 5));
  expect(maj.body.resultat).toBe("abonnement");
  const vieux = await webhook(
    evenement("evt_0", "customer.subscription.updated", { ...sub, status: "incomplete" }, maintenant - 100),
  );
  expect(vieux.body.resultat).toBe("perime");
  expect((await api("/v1/abonnement", t)).body).toMatchObject({
    plan: "business",
    periodicite: "annuel",
    statut: "active",
  });

  // Portail Stripe en mode flexible : cancel_at est renseigné, cancel_at_period_end reste false.
  const annulation = await webhook(
    evenement(
      "evt_2_annulation",
      "customer.subscription.updated",
      {
        ...sub,
        cancel_at: maintenant + 365 * 86400,
      },
      maintenant + 6,
    ),
  );
  expect(annulation.body.resultat).toBe("abonnement");
  expect((await api("/v1/abonnement", t)).body).toMatchObject({
    statut: "active",
    planEffectif: "business",
    annulationFinPeriode: true,
    periodeFin: new Date((maintenant + 365 * 86400) * 1000).toISOString(),
  });
  await webhook(
    evenement("evt_2_reactivation", "customer.subscription.updated", { ...sub, cancel_at: null }, maintenant + 7),
  );
  expect((await api("/v1/abonnement", t)).body.annulationFinPeriode).toBe(false);

  // Facture Stripe payée : facture émise par l'opérateur, Factur-X figé, soldée par carte.
  const facture = {
    id: "in_1",
    object: "invoice",
    number: "ABC-0001",
    customer: "cus_1",
    amount_paid: 46800,
    total_excluding_tax: 39000,
    subtotal: 39000,
    status_transitions: { paid_at: maintenant },
    lines: { data: [{ period: { start: maintenant, end: maintenant + 365 * 86400 } }] },
    parent: { subscription_details: { metadata: { tenant_id: tenant, plan: "business", periodicite: "annuel" } } },
  };
  const paye = await webhook(evenement("evt_3", "invoice.paid", facture));
  expect(paye.status).toBe(200);
  expect(paye.body.resultat).toBe("facture_emise");
  const doc = await api(`/v1/documents/${paye.body.documentId}`, op.body.session);
  expect(doc.body).toMatchObject({ statut: "paye", numero: expect.stringMatching(/^F-\d{4}-0001$/), ttcCents: 46800 });
  expect(doc.body.data.client.nom).toBe("Abonné SARL");
  expect(doc.body.data.emetteur.email).toBe("contact@aphrody.com");
  expect(doc.body.data.lignes[0].designation).toStartWith("Abonnement auto Business (annuel)");
  const xml = await fetch(new URL(`/v1/documents/${paye.body.documentId}/xml`, server.url), {
    headers: { authorization: `Bearer ${op.body.session}` },
  });
  expect(await xml.text()).toContain("<ram:GrandTotalAmount>468.00</ram:GrandTotalAmount>");
  // Invisible pour l'abonné (tenant opérateur).
  expect((await api(`/v1/documents/${paye.body.documentId}`, t)).status).toBe(404);
  // Rejeu et doublon d'événement pour la même facture : une seule facture.
  expect((await webhook(evenement("evt_3", "invoice.paid", facture))).body.resultat).toBe("rejeu");
  expect((await webhook(evenement("evt_3b", "invoice.paid", facture))).body.resultat).toBe("facture_deja_emise");
  expect((await api("/v1/documents", op.body.session)).body).toHaveLength(1);
  // Montant incohérent (TVA absente côté Stripe) : refus, Stripe renverra l'événement.
  const ko = await webhook(evenement("evt_4", "invoice.paid", { ...facture, id: "in_2", amount_paid: 39000 }));
  expect(ko.status).toBe(422);
  expect((await webhook(evenement("evt_4", "invoice.paid", { ...facture, id: "in_2" }))).body.resultat).toBe(
    "facture_emise",
  );

  // Facture d'essai à 0 € : rien à émettre.
  const zero = await webhook(evenement("evt_5", "invoice.paid", { ...facture, id: "in_0", amount_paid: 0 }));
  expect(zero.body.resultat).toBe("montant_nul");

  // Impayé puis résiliation : retour aux quotas Gratuit.
  expect((await webhook(evenement("evt_6", "invoice.payment_failed", { ...facture, id: "in_3" }))).body.resultat).toBe(
    "impaye",
  );
  expect((await api("/v1/abonnement", t)).body).toMatchObject({ statut: "past_due", planEffectif: "business" });
  const fin = await webhook(evenement("evt_7", "customer.subscription.deleted", sub, maintenant + 10));
  expect(fin.body.resultat).toBe("resilie");
  expect((await api("/v1/abonnement", t)).body).toMatchObject({ statut: "canceled", planEffectif: "gratuit" });

  // Événement non géré, tenant inconnu, client incohérent.
  expect((await webhook(evenement("evt_8", "customer.created", { id: "cus_9" }))).body.resultat).toBe("ignore");
  expect(
    (await webhook(evenement("evt_9", "customer.subscription.updated", { ...sub, metadata: {} }))).body.resultat,
  ).toBe("tenant_inconnu");
  expect(
    (await webhook(evenement("evt_10", "customer.subscription.updated", { ...sub, customer: "cus_autre" }))).body
      .resultat,
  ).toBe("client_incoherent");

  // Journal opérateur : non lisible par le rôle applicatif.
  expect(await sql`SELECT count(*)::int AS n FROM stripe_evenement`).toEqual([{ n: 14 }]);
  await expect(withTenant(sql, tenant, (tx) => tx`SELECT * FROM stripe_evenement`)).rejects.toThrow();
});

test("quotas : factures émises par mois, employés, erreur 402 explicite", async () => {
  const g = await api("/v1/auth/inscription", undefined, { body: inscription("gratuit@exemple.fr", "Gratuit SARL") });
  const t = g.body.session;
  const brouillon = (type = "facture") => ({
    type,
    client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
    datePrestation: "2026-10-15",
    echeance: "2026-11-21",
  });
  await withTenant(sql, g.body.tenantId, (tx) => incrementerCompteur(tx, periode(), "factures", 9));

  const d1 = await api("/v1/documents", t, { body: brouillon() });
  expect((await api(`/v1/documents/${d1.body.id}/emettre`, t, { body: {} })).status).toBe(200);
  const conso = (await api("/v1/abonnement", t)).body.consommation;
  expect(conso.find((c: { ressource: string }) => c.ressource === "factures").utilise).toBe(10);

  const d2 = await api("/v1/documents", t, { body: brouillon() });
  const refus = await api(`/v1/documents/${d2.body.id}/emettre`, t, { body: {} });
  expect(refus.status).toBe(402);
  expect(refus.body.erreur).toBe("quota atteint : 10 factures émises par mois sur le plan Gratuit");
  expect(refus.body.details).toContain("ressource factures");
  expect((await api(`/v1/documents/${d2.body.id}`, t)).body.statut).toBe("brouillon");
  // Un devis ne compte pas.
  const devis = await api("/v1/documents", t, { body: { ...brouillon("devis"), validiteJours: 30 } });
  expect((await api(`/v1/documents/${devis.body.id}/emettre`, t, { body: {} })).status).toBe(200);
  // Sans authentification, le gestionnaire répond 401.
  expect((await api(`/v1/documents/${d2.body.id}/emettre`, undefined, { body: {} })).status).toBe(401);

  const employe = (nom: string) => ({
    nom,
    prenom: "Léa",
    poste: "Assistante",
    contrat: "cdi",
    dateEntree: "2025-01-06",
    tempsTravail: 100,
    salaireBrutMensuelCents: 220000,
  });
  expect((await api("/v1/employes", t, { body: employe("Martin") })).status).toBe(201);
  expect((await api("/v1/employes", t, { body: employe("Petit") })).status).toBe(201);
  const e2 = await api("/v1/employes", t, { body: employe("Bernard") });
  expect(e2.status).toBe(402);
  expect(e2.body.erreur).toContain("2 employés sur le plan Gratuit");
});

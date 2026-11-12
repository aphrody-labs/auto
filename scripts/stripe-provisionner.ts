// Catalogue, TVA, portail et webhook Stripe réels. Aucun client ni paiement créé.
// bun --env-file=<secrets> scripts/stripe-provisionner.ts <configuration-sortie> [--production]
import { encoderForm } from "../packages/billing/src/stripe";
import { PLANS } from "../packages/billing/src/plans";

const cle = Bun.env.STRIPE_SECRET_KEY ?? "";
const production = Bun.argv.includes("--production");
if (!cle.startsWith(production ? "sk_live_" : "sk_test_")) throw new Error("Clé Stripe du mode demandé requise");
const origine = new URL(Bun.env.AUTO_URL_APP ?? "");
if (origine.protocol !== "https:" || origine.username || origine.password || origine.pathname !== "/")
  throw new Error("Origine HTTPS requise");
const sortie = Bun.argv[2];
if (!sortie || sortie.startsWith("--")) throw new Error("Fichier de configuration de sortie requis, hors dépôt");
const existant = (await Bun.file(sortie).exists())
  ? Object.fromEntries(
      (await Bun.file(sortie).text())
        .trim()
        .split(/\r?\n/)
        .map((ligne) => {
          const i = ligne.indexOf("=");
          return [ligne.slice(0, i), ligne.slice(i + 1)];
        }),
    )
  : {};
const version = "2026-09-30.endive";
async function appel(chemin: string, corps?: Parameters<typeof encoderForm>[0], idempotence?: string) {
  const r = await fetch(`https://api.stripe.com/v1/${chemin}`, {
    method: corps ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${cle}`,
      "stripe-version": version,
      ...(corps ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotence ? { "idempotency-key": idempotence } : {}),
    },
    body: corps ? encoderForm(corps) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`Stripe ${chemin.split("?")[0]} : HTTP ${r.status} (${b.error?.code ?? "erreur"})`);
  return b;
}
const compte = await appel("account");
if (production && !compte.charges_enabled)
  throw new Error("Compte Stripe non autorisé à encaisser : terminer sa vérification");
const env: Record<string, string> = { STRIPE_API_VERSION: version };
const url = `${origine.origin}/v1/abonnement/webhook`;
const endpoints = await appel("webhook_endpoints?limit=100");
const endpoint = endpoints.data.find((e: any) => e.url === url);
if (endpoint && !existant.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"))
  throw new Error("Webhook existant : fournir son secret dans le fichier de sortie pour reprendre sans doublon");
const produits: { product: string; prices: string[] }[] = [];
for (const plan of ["pro", "business"] as const) {
  const catalogue = await appel(`products?limit=100&active=true`);
  const produit =
    catalogue.data.find((p: any) => p.metadata?.auto_plan === plan && p.metadata?.application === "auto") ??
    (await appel(
      "products",
      { name: `Auto ${PLANS[plan].nom}`, metadata: { application: "auto", auto_plan: plan } },
      `auto-${plan}-v1`,
    ));
  const prixDuProduit: string[] = [];
  for (const periodicite of ["mensuel", "annuel"] as const) {
    const lookup = `auto_${plan}_${periodicite}_eur_v1`;
    const trouves = await appel(`prices?lookup_keys[]=${lookup}&active=true`);
    const montant = PLANS[plan].prixHtCents[periodicite];
    const interval = periodicite === "mensuel" ? "month" : "year";
    const prix =
      trouves.data[0] ??
      (await appel(
        "prices",
        {
          product: produit.id,
          currency: "eur",
          unit_amount: montant,
          recurring: { interval },
          tax_behavior: "exclusive",
          lookup_key: lookup,
          metadata: { application: "auto", plan, periodicite },
        },
        lookup,
      ));
    if (
      prix.unit_amount !== montant ||
      prix.currency !== "eur" ||
      prix.recurring?.interval !== interval ||
      prix.product !== produit.id ||
      prix.tax_behavior !== "exclusive"
    )
      throw new Error(`Prix incompatible : ${lookup}`);
    env[`STRIPE_PRIX_${plan.toUpperCase()}_${periodicite.toUpperCase()}`] = prix.id;
    prixDuProduit.push(prix.id);
  }
  produits.push({ product: produit.id, prices: prixDuProduit });
}
const taxes = await appel("tax_rates?active=true&limit=100");
const taxe =
  taxes.data.find((t: any) => t.percentage === 20 && !t.inclusive && t.country === "FR") ??
  (await appel(
    "tax_rates",
    { display_name: "TVA", percentage: 20, inclusive: false, country: "FR", description: "TVA française 20 %" },
    "auto-tva-fr-20-v1",
  ));
env.STRIPE_TAUX_TVA = taxe.id;
const portails = await appel("billing_portal/configurations?limit=100");
const portail = portails.data.find((p: any) => p.metadata?.application === "auto");
const configPortail = {
  business_profile: { headline: "Gérer votre abonnement Auto" },
  default_return_url: `${origine.origin}/app/parametres`,
  features: {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      products: produits,
    },
  },
  metadata: { application: "auto" },
};
await appel(
  portail ? `billing_portal/configurations/${portail.id}` : "billing_portal/configurations",
  configPortail,
  `auto-portail-${new Bun.CryptoHasher("sha256").update(JSON.stringify(configPortail)).digest("hex").slice(0, 32)}`,
);
const configWebhook = {
  url,
  api_version: version,
  description: `Auto ${production ? "production" : "recette"}`,
  enabled_events: [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ],
  metadata: { application: "auto" },
};
const webhook = endpoint ?? (await appel("webhook_endpoints", configWebhook, `auto-webhook-${origine.hostname}-v1`));
env.STRIPE_WEBHOOK_SECRET = webhook.secret ?? existant.STRIPE_WEBHOOK_SECRET;
if (!env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) throw new Error("Secret webhook absent");
await Bun.write(
  sortie,
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
);
console.log(
  JSON.stringify({
    compte: compte.id,
    production,
    encaissementActif: compte.charges_enabled,
    prix: produits.flatMap((p) => p.prices),
    webhook: webhook.id,
    url,
    configurationEcrite: true,
  }),
);

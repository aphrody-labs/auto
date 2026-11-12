// Client REST Stripe (fetch, sans SDK) et vérification des webhooks signés.
import { ErreurMetier } from "@auto/store";
import type { Periodicite, PlanId } from "./plans";

export type CleTarif = `${Exclude<PlanId, "gratuit">}_${Periodicite}`;

export interface ConfigStripe {
  /** Clé secrète (`sk_test_…` ou `sk_live_…`). */
  cle: string;
  /** Secret de signature de l'endpoint webhook (`whsec_…`). */
  secretWebhook: string;
  /** Base de l'API ; remplacée par un faux serveur dans les tests. */
  base: string;
  /** Version d'API épinglée (en-tête `Stripe-Version`), sinon celle du compte. */
  version?: string;
  /** Identifiants des prix Stripe (`price_…`) par plan et périodicité. */
  tarifs: Partial<Record<CleTarif, string>>;
  /** Taux de TVA Stripe (`txr_…`) appliqué aux abonnements, pour que la facture Stripe soit TTC. */
  tauxTva?: string;
}

const CLES: CleTarif[] = ["pro_mensuel", "pro_annuel", "business_mensuel", "business_annuel"];

/** Lit `STRIPE_*` ; `null` si Stripe n'est pas configuré. */
export function configStripeDepuisEnv(env: Record<string, string | undefined> = Bun.env): ConfigStripe | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  const tarifs: ConfigStripe["tarifs"] = {};
  for (const k of CLES) {
    const v = env[`STRIPE_PRIX_${k.toUpperCase()}`];
    if (v) tarifs[k] = v;
  }
  return {
    cle: env.STRIPE_SECRET_KEY,
    secretWebhook: env.STRIPE_WEBHOOK_SECRET,
    base: env.STRIPE_API_BASE ?? "https://api.stripe.com",
    version: env.STRIPE_API_VERSION || undefined,
    tarifs,
    tauxTva: env.STRIPE_TAUX_TVA || undefined,
  };
}

/** Plan et périodicité d'un prix Stripe configuré. */
export function tarifInverse(c: ConfigStripe, prix: string | undefined) {
  const k = CLES.find((x) => prix && c.tarifs[x] === prix);
  if (!k) return null;
  const [plan, periodicite] = k.split("_") as [Exclude<PlanId, "gratuit">, Periodicite];
  return { plan, periodicite };
}

type Valeur = string | number | boolean | null | undefined | Valeur[] | { [k: string]: Valeur };

/** Encodage `application/x-www-form-urlencoded` de Stripe : `a[b][0][c]=v`. */
export function encoderForm(obj: Record<string, Valeur>): string {
  const p = new URLSearchParams();
  const ajouter = (cle: string, v: Valeur) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => ajouter(`${cle}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) ajouter(`${cle}[${k}]`, x);
    else p.append(cle, String(v));
  };
  for (const [k, v] of Object.entries(obj)) ajouter(k, v);
  return p.toString();
}

export class Stripe {
  constructor(
    private readonly c: ConfigStripe,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post<T>(chemin: string, corps: Record<string, Valeur>, idempotence?: string): Promise<T> {
    const res = await this.fetcher(new URL(chemin, this.c.base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.c.cle}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(this.c.version ? { "stripe-version": this.c.version } : {}),
        ...(idempotence ? { "idempotency-key": idempotence } : {}),
      },
      body: encoderForm(corps),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new ErreurMetier(`Stripe : ${body.error?.message ?? `HTTP ${res.status}`}`, [], 502);
    return body;
  }

  /** Client Stripe du tenant ; `metadata.tenant_id` relie les événements au tenant. */
  creerClient(p: { tenantId: string; nom: string; email?: string }) {
    return this.post<{ id: string }>(
      "/v1/customers",
      { name: p.nom, email: p.email, preferred_locales: ["fr"], metadata: { tenant_id: p.tenantId } },
      `client-${p.tenantId}`,
    );
  }

  /** Checkout Session en mode abonnement. */
  creerCheckout(p: {
    tenantId: string;
    client: string;
    prix: string;
    plan: PlanId;
    periodicite: Periodicite;
    essaiJours: number;
    succes: string;
    annulation: string;
  }) {
    const meta = { tenant_id: p.tenantId, plan: p.plan, periodicite: p.periodicite, essai: p.essaiJours ? "1" : "0" };
    return this.post<{ id: string; url: string }>("/v1/checkout/sessions", {
      mode: "subscription",
      customer: p.client,
      client_reference_id: p.tenantId,
      line_items: [{ price: p.prix, quantity: 1 }],
      success_url: p.succes,
      cancel_url: p.annulation,
      locale: "fr",
      metadata: meta,
      subscription_data: {
        metadata: meta,
        trial_period_days: p.essaiJours || undefined,
        default_tax_rates: this.c.tauxTva ? [this.c.tauxTva] : undefined,
      },
    });
  }

  /** Session du portail client (moyen de paiement, factures Stripe, résiliation). */
  creerPortail(client: string, retour: string) {
    return this.post<{ id: string; url: string }>("/v1/billing_portal/sessions", {
      customer: client,
      return_url: retour,
      locale: "fr",
    });
  }
}

// Webhooks -------------------------------------------------------------------

const hmac = (secret: string, contenu: string) => new Bun.CryptoHasher("sha256", secret).update(contenu).digest("hex");

function egal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** En-tête `Stripe-Signature` d'un corps : `t=<horodatage>,v1=<HMAC-SHA256 de "t.corps">`. */
export function signerStripe(secret: string, corps: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmac(secret, `${t}.${corps}`)}`;
}

/**
 * Vérification selon la documentation Stripe : HMAC-SHA256 de `t.corps_brut` avec le secret de
 * l'endpoint, comparé en temps constant à chaque signature `v1` ; horodatage à ±`tolerance` secondes
 * (300 par défaut) contre le rejeu.
 */
export function verifierSignatureStripe(
  corps: string,
  entete: string | null,
  secret: string,
  tolerance = 300,
  maintenant = Math.floor(Date.now() / 1000),
): boolean {
  if (!entete) return false;
  let t = Number.NaN;
  const v1: string[] = [];
  for (const part of entete.split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (!Number.isInteger(t) || !v1.length || Math.abs(maintenant - t) > tolerance) return false;
  const attendu = hmac(secret, `${t}.${corps}`);
  return v1.some((s) => egal(s, attendu));
}

export interface EvenementStripe {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

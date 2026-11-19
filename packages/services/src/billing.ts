// Plans, metered usage quota checks, Stripe Checkout form encoding, HMAC-SHA256 webhook verification,
// and 7-day subscription renewal reminders.
import { formatEur } from "@aphrody/auto-domain";
import { t, type Locale } from "@aphrody/auto-i18n";
import type { Tx } from "@aphrody/auto-platform";
import { asNum, reqCompany, StoreError } from "@aphrody/auto-store";
import { outbox } from "./events";
import type { Mailer } from "./mail";

export type PlanId = "free" | "pro" | "enterprise";
export type BillingPeriod = "monthly" | "annual";

export interface PlanSpec {
  id: PlanId;
  name: string;
  priceExclVatCents: Record<BillingPeriod, number>;
  limits: {
    invoicesPerMonth: number;
    llmCallsPerMonth: number;
    automations: number;
    storageMb: number;
  };
}

export const PLANS: Record<PlanId, PlanSpec> = {
  free: {
    id: "free",
    name: "Free",
    priceExclVatCents: { monthly: 0, annual: 0 },
    limits: { invoicesPerMonth: 25, llmCallsPerMonth: 100, automations: 3, storageMb: 500 },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceExclVatCents: { monthly: 2900, annual: 29000 },
    limits: { invoicesPerMonth: 1000, llmCallsPerMonth: 5000, automations: 50, storageMb: 25_000 },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceExclVatCents: { monthly: 9900, annual: 99000 },
    limits: { invoicesPerMonth: 100_000, llmCallsPerMonth: 100_000, automations: 1000, storageMb: 250_000 },
  },
};

export type QuotaMetric = "invoices" | "llm_calls";

export async function currentPlan(tx: Tx): Promise<PlanId> {
  const companyId = reqCompany(tx);
  const [row] = await tx<{ plan: PlanId }[]>`SELECT plan FROM company WHERE id = ${companyId}`;
  return row?.plan ?? "free";
}

export async function checkQuota(
  tx: Tx,
  metric: QuotaMetric,
  now = new Date(),
): Promise<{ used: number; limit: number; remaining: number }> {
  const companyId = reqCompany(tx);
  const plan = PLANS[await currentPlan(tx)];
  const limit = metric === "invoices" ? plan.limits.invoicesPerMonth : plan.limits.llmCallsPerMonth;
  const period = now.toISOString().slice(0, 7);
  const [row] = await tx<{ quantity: number }[]>`
    SELECT quantity FROM usage_counter WHERE company_id = ${companyId} AND metric = ${metric} AND period = ${period}`;
  const used = asNum(row?.quantity);
  if (used >= limit) {
    throw new StoreError(`Monthly quota exceeded for ${metric} (${used}/${limit})`, [], 402);
  }
  return { used, limit, remaining: limit - used };
}

export async function incrementUsage(tx: Tx, metric: QuotaMetric, delta = 1, now = new Date()): Promise<void> {
  const companyId = reqCompany(tx);
  const period = now.toISOString().slice(0, 7);
  await tx`
    INSERT INTO usage_counter (company_id, metric, period, quantity)
    VALUES (${companyId}, ${metric}, ${period}, ${delta})
    ON CONFLICT (company_id, metric, period) DO UPDATE SET quantity = quantity + ${delta}`;
}

export function encodeStripeForm(input: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const append = (prefix: string, val: unknown) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((item, idx) => append(`${prefix}[${idx}]`, item));
      return;
    }
    if (typeof val === "object") {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        append(`${prefix}[${k}]`, v);
      }
      return;
    }
    params.append(prefix, String(val));
  };
  for (const [k, v] of Object.entries(input)) append(k, v);
  return params;
}

export async function createStripeCheckoutSession(opts: {
  stripeKey: string;
  amountCents: number;
  currency?: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  baseUrl?: string;
  fetcher?: typeof fetch;
}): Promise<{ id: string; url: string }> {
  const body = encodeStripeForm({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: opts.currency ?? "eur",
          unit_amount: opts.amountCents,
          product_data: { name: opts.productName },
        },
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
  const base = opts.baseUrl ?? "https://api.stripe.com";
  const res = await (opts.fetcher ?? fetch)(`${base.replace(/\/+$/, "")}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.stripeKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !parsed.url) {
    throw new StoreError(`Stripe error: ${parsed.error?.message ?? `HTTP ${res.status}`}`, [], 502);
  }
  return { id: parsed.id ?? "", url: parsed.url };
}

export async function verifyStripeWebhookSignature(
  payload: string,
  header: string | null,
  secret: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const timestamp = Number(parts.t);
  const sigHex = parts.v1;
  if (!Number.isFinite(timestamp) || !sigHex) return false;
  const nowSec = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > (opts.toleranceSeconds ?? 300)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
  );
  const expectedHex = [...expectedBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expectedHex.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

export const RENEWAL_REMINDER_DAYS = 7;

export interface RenewalReminder {
  companyId: string;
  plan: PlanId;
  period: BillingPeriod;
  dueDate: string;
  trial: boolean;
  amountExclVatCents: number;
}

export async function checkRenewalReminder(
  tx: Tx,
  todayIso: string,
  opts: { mailer?: Mailer | null; appUrl?: string; locale?: Locale } = {},
): Promise<RenewalReminder | null> {
  const companyId = reqCompany(tx);
  const [comp] = await tx<
    {
      plan: PlanId;
      billing_period: BillingPeriod | null;
      subscription_status: string;
      trial_ends_at: string | null;
      period_ends_at: string | null;
    }[]
  >`SELECT plan, billing_period, subscription_status, trial_ends_at, period_ends_at FROM company WHERE id = ${companyId}`;
  if (!comp || comp.plan === "free") return null;
  const trial = comp.subscription_status === "trialing";
  if (!trial && comp.subscription_status !== "active") return null;
  const targetDue = new Date(Date.parse(`${todayIso}T12:00:00Z`) + RENEWAL_REMINDER_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const dueRaw = trial ? comp.trial_ends_at : comp.period_ends_at;
  if (!dueRaw || dueRaw.slice(0, 10) !== targetDue) return null;

  const period: BillingPeriod = comp.billing_period ?? "monthly";
  const amount = PLANS[comp.plan].priceExclVatCents[period];
  const reminder: RenewalReminder = {
    companyId,
    plan: comp.plan,
    period,
    dueDate: dueRaw,
    trial,
    amountExclVatCents: amount,
  };
  await outbox(tx, "subscription.renewal_soon", reminder);

  if (opts.mailer) {
    const owners = await tx<{ email: string }[]>`
      SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.company_id = ${companyId} AND m.role = 'owner' ORDER BY u.email`;
    const locale = opts.locale ?? "en";
    const url = `${(opts.appUrl ?? "https://auto.aphrody.com").replace(/\/+$/, "")}/app/settings`;
    const price = formatEur(amount, locale);
    const subject = trial
      ? t(locale, "Your Auto trial ends on {date}", { date: targetDue })
      : t(locale, "Your Auto subscription renews on {date}", { date: targetDue });
    if (owners.length) {
      await opts.mailer.send({
        to: owners.map((o) => o.email),
        subject,
        text: `${subject}\n${t(locale, "Plan:")} ${PLANS[comp.plan].name} (${price})\n${t(locale, "Manage:")} ${url}`,
      });
    }
  }
  return reminder;
}

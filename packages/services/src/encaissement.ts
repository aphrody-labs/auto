// Paiement en ligne des factures : le client paie par carte sur le compte Stripe de l'entreprise (sa propre clé,
// chiffrée au repos). Au retour, la session Checkout est relue chez Stripe avec cette clé : seul un paiement
// confirmé par Stripe est enregistré, une seule fois (référence `stripe:<session>`, index unique).
import { encoderForm } from "@auto/billing";
import {
  enregistrerPaiement,
  ErreurMetier,
  lire,
  lireEncaissement,
  paiementExiste,
  resteDu,
  withTenant,
  type Sql,
} from "@auto/store";
import { chiffrer, dechiffrer } from "@auto/tenancy";
import type { Emetteur } from "./evenements";

const usage = (tenantId: string) => `encaissement:stripe:${tenantId}`;
const base = () => Bun.env.AUTO_STRIPE_API ?? "https://api.stripe.com";

/** Clé secrète ou restreinte Stripe (`sk_…`, `rk_…`, test ou live). */
export const cleValide = (c: string) => /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(c);

export async function chiffrerCle(tenantId: string, cle: string) {
  if (!cleValide(cle)) throw new ErreurMetier("clé Stripe invalide (sk_live_…, sk_test_… ou rk_…)", ["cle"]);
  return { chiffree: await chiffrer(usage(tenantId), new TextEncoder().encode(cle)), apercu: `…${cle.slice(-4)}` };
}

async function cleDuTenant(sql: Sql, tenantId: string): Promise<string | null> {
  const e = await withTenant(sql, tenantId, (tx) => lireEncaissement(tx));
  return e && new TextDecoder().decode(await dechiffrer(usage(tenantId), e.cleChiffree));
}

async function stripe<T>(cle: string, methode: "GET" | "POST", chemin: string, corps?: Record<string, unknown>) {
  const signal = AbortSignal.timeout(15_000);
  const authorization = `Bearer ${cle}`;
  const r =
    methode === "GET"
      ? await fetch(new URL(chemin, base()), { headers: { authorization }, signal })
      : await fetch(new URL(chemin, base()), {
          method: "POST",
          headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
          body: encoderForm((corps ?? {}) as Parameters<typeof encoderForm>[0]),
          signal,
        });
  const b = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new ErreurMetier(`Stripe : ${b.error?.message ?? `HTTP ${r.status}`}`, [], 502);
  return b;
}

/** Vérifie la clé auprès de Stripe (compte lisible) avant de l'enregistrer. */
export async function verifierCle(cle: string) {
  return stripe<{ id: string; business_profile?: { name?: string } }>(cle, "GET", "/v1/account");
}

/** Session Checkout pour le reste dû d'une facture ; null si l'entreprise n'encaisse pas en ligne. */
export async function creerSessionPaiement(
  sql: Sql,
  tenantId: string,
  documentId: string,
  urls: { succes: string; annulation: string },
): Promise<{ url: string } | null> {
  const cle = await cleDuTenant(sql, tenantId);
  if (!cle) return null;
  const { d, reste } = await withTenant(sql, tenantId, async (tx) => {
    const d = await lire(tx, documentId);
    return { d, reste: d ? (await resteDu(tx, documentId)).resteCents : 0 };
  });
  if (!d || !["facture", "acompte"].includes(d.type) || !["emis", "envoye", "depose"].includes(d.statut) || reste <= 0)
    throw new ErreurMetier("cette facture n'attend pas de paiement", [], 409);
  const s = await stripe<{ id: string; url: string }>(cle, "POST", "/v1/checkout/sessions", {
    mode: "payment",
    locale: "fr",
    client_reference_id: documentId,
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "eur", unit_amount: reste, product_data: { name: `Facture ${d.numero}` } },
      },
    ],
    success_url: urls.succes,
    cancel_url: urls.annulation,
    metadata: { tenant_id: tenantId, document_id: documentId },
    payment_intent_data: { metadata: { tenant_id: tenantId, document_id: documentId } },
  });
  return { url: s.url };
}

/**
 * Retour du client : la session est relue chez Stripe ; payée, elle devient un paiement par carte de son montant.
 * Rejouable sans effet (référence unique). Renvoie le reste dû après coup.
 */
export async function confirmerPaiement(
  sql: Sql,
  tenantId: string,
  documentId: string,
  sessionId: string,
  publier: Emetteur,
): Promise<{ enregistre: boolean; resteCents: number }> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new ErreurMetier("session de paiement invalide", [], 404);
  const cle = await cleDuTenant(sql, tenantId);
  if (!cle) throw new ErreurMetier("paiement en ligne non configuré", [], 409);
  const s = await stripe<{
    payment_status: string;
    amount_total: number;
    currency: string;
    client_reference_id: string | null;
    metadata?: Record<string, string>;
  }>(cle, "GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (s.client_reference_id !== documentId || s.metadata?.tenant_id !== tenantId)
    throw new ErreurMetier("session de paiement invalide", [], 404);
  const reference = `stripe:${sessionId}`;
  return withTenant(sql, tenantId, async (tx) => {
    if (s.payment_status !== "paid" || s.currency !== "eur" || (await paiementExiste(tx, reference)))
      return { enregistre: false, resteCents: (await resteDu(tx, documentId)).resteCents };
    const jour = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());
    const r = await enregistrerPaiement(tx, null, documentId, {
      date: jour,
      montantCents: s.amount_total,
      mode: "carte",
      reference,
    });
    await publier(tx, "paiement.enregistre", { ...r.paiement, canal: "en_ligne" });
    return { enregistre: true, resteCents: r.resteCents };
  });
}

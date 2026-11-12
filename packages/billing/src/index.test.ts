import { expect, test } from "bun:test";
import {
  configStripeDepuisEnv,
  encoderForm,
  periode,
  planEffectif,
  PLANS,
  signerStripe,
  tarifInverse,
  verifierSignatureStripe,
} from "./index";

test("plans : prix HT, annuel à dix mois, essai Pro, quotas croissants", () => {
  expect(PLANS.pro.prixHtCents).toEqual({ mensuel: 1400, annuel: 14000 });
  expect(PLANS.business.prixHtCents.annuel).toBe(PLANS.business.prixHtCents.mensuel * 10);
  expect(PLANS.pro.essaiJours).toBe(30);
  expect(PLANS.gratuit.quotas.factures).toBeLessThan(PLANS.pro.quotas.factures!);
  expect(PLANS.business.quotas.factures).toBeNull();
  expect(planEffectif({ plan: "pro", statut: "trialing" }).id).toBe("pro");
  expect(planEffectif({ plan: "pro", statut: "past_due" }).id).toBe("pro");
  expect(planEffectif({ plan: "business", statut: "canceled" }).id).toBe("gratuit");
  expect(planEffectif({ plan: "gratuit", statut: "aucun" }).id).toBe("gratuit");
});

test("période au fuseau de Paris", () => {
  expect(periode(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11");
  expect(periode(new Date("2026-10-31T22:30:00Z"))).toBe("2026-10");
});

test("encodage de formulaire Stripe", () => {
  const f = new URLSearchParams(
    encoderForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      metadata: { a: "b" },
      x: undefined,
    }),
  );
  expect(f.get("line_items[0][price]")).toBe("price_1");
  expect(f.get("line_items[0][quantity]")).toBe("1");
  expect(f.get("metadata[a]")).toBe("b");
  expect(f.has("x")).toBe(false);
});

test("signature des webhooks : HMAC, plusieurs v1, tolérance, corps altéré", () => {
  const secret = "whsec_test";
  const corps = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const h = signerStripe(secret, corps, t);
  expect(verifierSignatureStripe(corps, h, secret, 300, t + 10)).toBe(true);
  expect(verifierSignatureStripe(corps, `t=${t},v1=${"0".repeat(64)},${h.split(",")[1]}`, secret, 300, t)).toBe(true);
  expect(verifierSignatureStripe(`${corps} `, h, secret, 300, t)).toBe(false);
  expect(verifierSignatureStripe(corps, h, "whsec_autre", 300, t)).toBe(false);
  expect(verifierSignatureStripe(corps, h, secret, 300, t + 301)).toBe(false);
  expect(verifierSignatureStripe(corps, null, secret)).toBe(false);
  expect(verifierSignatureStripe(corps, `t=${t}`, secret, 300, t)).toBe(false);
});

test("configuration Stripe depuis l'environnement", () => {
  expect(configStripeDepuisEnv({})).toBeNull();
  const c = configStripeDepuisEnv({
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRIX_PRO_MENSUEL: "price_pm",
  })!;
  expect(c.base).toBe("https://api.stripe.com");
  expect(tarifInverse(c, "price_pm")).toEqual({ plan: "pro", periodicite: "mensuel" });
  expect(tarifInverse(c, "price_inconnu")).toBeNull();
});

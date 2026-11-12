import { expect, test } from "bun:test";
import { verifierConfiguration } from "./diagnostic";

test("diagnostic : aucune intégration absente n'est annoncée prête", () => {
  const controles = verifierConfiguration({});
  expect(controles).toHaveLength(7);
  expect(controles.every((c) => !c.ok)).toBe(true);
});

test("diagnostic : Resend sélectionné n'exige pas de relais SMTP", () => {
  const controles = verifierConfiguration({ AUTO_MAIL_FOURNISSEUR: "resend", AUTO_RESEND_CLE_API: "re_factice" });
  expect(controles.find((c) => c.service === "resend")?.ok).toBe(true);
  expect(controles.some((c) => c.service === "smtp")).toBe(false);
  expect(JSON.stringify(controles)).not.toContain("re_factice");
});

test("diagnostic : configuration complète, secrets absents du rapport, Stripe test refusé", () => {
  const env = {
    AUTO_URL_APP: "https://auto.example.com",
    AUTO_CLE_MAITRE: "secret-maitre".repeat(4),
    AUTO_GOOGLE_CLIENT_ID: "id-google",
    AUTO_GOOGLE_CLIENT_SECRET: "secret-google",
    AUTO_MICROSOFT_CLIENT_ID: "id-ms",
    AUTO_MICROSOFT_CLIENT_SECRET: "secret-ms",
    AUTO_SMTP_MOT_DE_PASSE: "secret-mail",
    DATABASE_URL: "postgres://user:secret-db@localhost/auto",
    STRIPE_SECRET_KEY: "sk_live_secret-stripe",
    STRIPE_WEBHOOK_SECRET: "whsec_secret-webhook",
  };
  const controles = verifierConfiguration(env);
  expect(controles.every((c) => c.ok)).toBe(true);
  expect(JSON.stringify(controles)).not.toContain("secret-");
  expect(
    verifierConfiguration({ ...env, STRIPE_SECRET_KEY: "sk_test_secret" }).find((c) => c.service === "stripe")?.ok,
  ).toBe(false);
  expect(verifierConfiguration({ ...env, AUTO_URL_APP: "http://auto.example.com" })[0]?.ok).toBe(false);
});

import { afterAll, expect, test } from "bun:test";
import { EN_TETE_ID, livrer, SIGNATURE, signer, webhookDepuisEnv } from "./evenements";

const recus: { corps: string; signature: string | null; id: string | null }[] = [];
let statut = 204;
const recepteur = Bun.serve({
  port: 0,
  routes: {
    "/hook": {
      POST: async (req) => {
        recus.push({ corps: await req.text(), signature: req.headers.get(SIGNATURE), id: req.headers.get(EN_TETE_ID) });
        return new Response(null, { status: statut });
      },
    },
  },
});

afterAll(() => recepteur.stop(true));

const w = { url: new URL("/hook", recepteur.url).href, secret: "s3cret" };

test("signature HMAC-SHA256", () => {
  // Vecteur de référence HMAC-SHA256.
  expect(signer("key", "The quick brown fox jumps over the lazy dog")).toBe(
    "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  expect(signer("secret", "{}")).not.toBe(signer("autre", "{}"));
});

test("livraison : corps brut signé, identifiant d'événement en en-tête", async () => {
  const corps = JSON.stringify({ id: "e1", type: "document.emis", tenantId: "t1", date: "x", data: {} });
  await livrer(w, "e1", corps);
  expect(recus.at(-1)).toEqual({ corps, signature: signer("s3cret", corps), id: "e1" });
});

test("réponse non 2xx : erreur levée (nouvel essai par le worker)", async () => {
  statut = 503;
  await expect(livrer(w, "e2", "{}")).rejects.toThrow("HTTP 503");
  statut = 204;
});

test("sans URL, aucune livraison ; URL sans secret refusée", () => {
  expect(webhookDepuisEnv({})).toBeNull();
  expect(() => webhookDepuisEnv({ N8N_WEBHOOK_URL: "http://x" })).toThrow("N8N_WEBHOOK_SECRET");
  expect(webhookDepuisEnv({ N8N_WEBHOOK_URL: "http://x", N8N_WEBHOOK_SECRET: "s" })).toEqual({
    url: "http://x",
    secret: "s",
  });
});

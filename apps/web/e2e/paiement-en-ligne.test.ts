// Paiement en ligne : clé Stripe activée dans les paramètres, lien de paiement depuis la fiche, page publique,
// « Stripe » (faux serveur) qui encaisse et renvoie le client, confirmation affichée et facture soldée.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { auditer } from "./audit";
import { chrome, demarrerBanc, type Banc } from "./support";

const executable = chrome();
let b: Banc;
let stripe: ReturnType<typeof Bun.serve>;
const sessions = new Map<string, { montant: number; doc: string; tenant: string; succes: string; paye: boolean }>();

beforeAll(async () => {
  if (!executable) return;
  stripe = Bun.serve({
    port: 0,
    routes: {
      "/v1/account": () => Response.json({ id: "acct_1" }),
      "/v1/checkout/sessions": {
        POST: async (req) => {
          const f = new URLSearchParams(await req.text());
          const id = `cs_test_${sessions.size + 1}`;
          sessions.set(id, {
            montant: Number(f.get("line_items[0][price_data][unit_amount]")),
            doc: f.get("client_reference_id")!,
            tenant: f.get("metadata[tenant_id]")!,
            succes: f.get("success_url")!,
            paye: false,
          });
          return Response.json({ id, url: new URL(`/payer/${id}`, stripe.url).toString() });
        },
      },
      "/v1/checkout/sessions/:id": (req) => {
        const s = sessions.get(req.params.id)!;
        return Response.json({
          payment_status: s.paye ? "paid" : "unpaid",
          amount_total: s.montant,
          currency: "eur",
          client_reference_id: s.doc,
          metadata: { tenant_id: s.tenant },
        });
      },
      // Page de paiement : encaisse puis renvoie vers success_url, comme Checkout.
      "/payer/:id": (req) => {
        const s = sessions.get(req.params.id)!;
        s.paye = true;
        return Response.redirect(s.succes.replace("{CHECKOUT_SESSION_ID}", req.params.id), 303);
      },
    },
  });
  Bun.env.AUTO_STRIPE_API = stripe.url.toString();
  b = await demarrerBanc(executable);
}, 60_000);

afterAll(async () => {
  delete Bun.env.AUTO_STRIPE_API;
  await b?.arreter();
  await stripe?.stop(true);
}, 30_000);

test.skipIf(!executable)(
  "activation, lien de paiement, paiement par carte, facture soldée",
  async () => {
    const s = await b.inscrire("paiement-en-ligne@exemple.fr", "Atelier Carte");
    const id = await b.facture(s);
    const ctx = await b.connecte(s);
    const page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));

    await page.goto(b.url("/app/parametres"));
    await page.getByLabel("Clé secrète Stripe").fill("sk_test_abcdefghij1234");
    await page.getByRole("button", { name: "Activer" }).click();
    await page.getByText(/Actif : vos clients peuvent payer/).waitFor();

    await page.goto(b.url(`/app/documents/${id}`));
    await page.getByRole("button", { name: "Lien de paiement" }).click();
    const lien = page.locator(".lien-partage a");
    await lien.waitFor();
    const chemin = new URL((await lien.getAttribute("href"))!).pathname;
    expect(chemin).toStartWith("/facture/");

    const client = await b.navigateur.newContext({ viewport: { width: 375, height: 800 }, locale: "fr-FR" });
    const p = await client.newPage();
    p.on("pageerror", (e) => erreurs.push(e.message));
    await p.goto(b.url(chemin));
    await p.getByRole("heading", { level: 1, name: /^Facture F-/ }).waitFor();
    expect(await p.evaluate(auditer)).toEqual([]);
    await p.getByRole("button", { name: /^Payer 1\s?200,00\s€ par carte$/ }).click();
    await p.getByText("Paiement reçu. Merci : l'émetteur est prévenu.").waitFor();
    expect(new URL(p.url()).search).toBe("");
    expect(await p.locator("#reste").textContent()).toMatch(/^0,00\s€$/);
    expect(await p.getByRole("button", { name: /par carte/ }).isVisible()).toBe(false);

    await page.reload();
    await page.locator(".badge", { hasText: "Payée" }).first().waitFor();
    expect(erreurs).toEqual([]);
    await client.close();
    await ctx.close();
  },
  60_000,
);

// Facture émise → paiement (saisies invalides, partiel puis solde), relance consignée, isolation entre comptes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chrome, demarrerBanc, type Banc } from "./support";

const executable = chrome();
let b: Banc;

beforeAll(async () => {
  if (executable) b = await demarrerBanc(executable);
}, 60_000);
afterAll(async () => {
  await b?.arreter();
}, 30_000);

test.skipIf(!executable)(
  "paiement : montant invalide refusé, partiel puis solde",
  async () => {
    const s = await b.inscrire("paie@exemple.fr", "Atelier Paie");
    const id = await b.facture(s);
    const ctx = await b.connecte(s);
    const page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.goto(b.url(`/app/documents/${id}`));
    await page.getByText(/Reste dû : 1.200,00/).waitFor();
    const form = page.getByRole("form", { name: "Enregistrer un paiement" });
    const envoyer = () => form.getByRole("button", { name: "Enregistrer le paiement" }).click();

    // Négatifs : vide, texte, supérieur au reste dû. Rien n'est enregistré.
    await envoyer();
    await page.getByText("Montant en euros, par exemple 120,50.").waitFor();
    await form.getByLabel("Montant (€)").fill("abc");
    await envoyer();
    await page.getByText("Montant en euros, par exemple 120,50.").waitFor();
    await form.getByLabel("Montant (€)").fill("5000");
    await envoyer();
    await page.getByText(/Au plus le reste dû/).waitFor();
    expect((await b.appel(`/v1/documents/${id}/paiements`, s)).paiements).toHaveLength(0);

    // Partiel puis solde.
    await form.getByLabel("Montant (€)").fill("500");
    await form.getByLabel("Référence").fill("VIR-001");
    await envoyer();
    await page.getByText(/Reste dû : 700,00/).waitFor();
    await page.getByRole("cell", { name: "VIR-001" }).waitFor();
    await form.getByLabel("Montant (€)").fill("700,00");
    await envoyer();
    await page.getByText(/Reste dû : 0,00/).waitFor();
    await page.getByRole("form", { name: "Enregistrer un paiement" }).waitFor({ state: "detached" });
    expect((await b.appel(`/v1/documents/${id}/paiements`, s)).paiements).toHaveLength(2);
    expect(erreurs).toEqual([]);
    await ctx.close();
  },
  60_000,
);

test.skipIf(!executable)(
  "relance : palier et canal choisis, relance consignée",
  async () => {
    const s = await b.inscrire("relance@exemple.fr", "Atelier Relance");
    const id = await b.facture(s);
    const ctx = await b.connecte(s);
    const page = await ctx.newPage();
    await page.goto(b.url(`/app/documents/${id}`));
    await page.getByLabel("Palier de relance").selectOption("2");
    await page.getByLabel("Canal").selectOption("courrier");
    await page.getByRole("button", { name: "Enregistrer la relance" }).click();
    await page.getByText("Relance de palier 2 enregistrée").waitFor();
    await ctx.close();
  },
  60_000,
);

test.skipIf(!executable)(
  "isolation : le document d'un autre compte est introuvable, sans fuite",
  async () => {
    const a = await b.inscrire("a@exemple.fr", "Société A");
    const autre = await b.inscrire("b@exemple.fr", "Société B");
    const id = await b.facture(a);
    const ctx = await b.connecte(autre);
    const page = await ctx.newPage();
    await page.goto(b.url(`/app/documents/${id}`));
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.waitForLoadState("networkidle");
    expect(await page.getByText("Client SAS").count()).toBe(0);
    expect(await page.getByText("Conseil").count()).toBe(0);
    const r = await fetch(new URL(`/v1/documents/${id}`, b.api.url), { headers: { authorization: `Bearer ${autre}` } });
    expect(r.status).toBe(404);
    await ctx.close();
  },
  60_000,
);

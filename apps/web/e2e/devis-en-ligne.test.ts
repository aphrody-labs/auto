// Devis en ligne : l'émetteur partage le lien depuis la fiche, le client (sans compte) consulte, laisse le nom
// vide (erreur), accepte ; la fiche de l'émetteur passe à « accepté ». Audit d'accessibilité de la page publique.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { auditer } from "./audit";
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
  "partage du lien, réponse du client, statut mis à jour",
  async () => {
    const s = await b.inscrire("devis@exemple.fr", "Atelier Devis");
    const d = await b.appel("/v1/documents", s, {
      type: "devis",
      validiteJours: 30,
      client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
      lignes: [{ designation: "Refonte du site", quantite: 1, prixUnitaireHtCents: 180000, tva: 200 }],
    });
    await b.appel(`/v1/documents/${d.id}/emettre`, s, {});

    const ctx = await b.connecte(s);
    const page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.goto(b.url(`/app/documents/${d.id}`));
    await page.getByRole("button", { name: "Partager le lien" }).click();
    const lien = page.locator(".lien-partage a");
    await lien.waitFor();
    const url = new URL((await lien.getAttribute("href"))!);
    expect(url.pathname).toStartWith("/devis/");

    // Le client n'a pas de session : contexte vierge, mobile.
    const client = await b.navigateur.newContext({ viewport: { width: 375, height: 800 }, locale: "fr-FR" });
    const p = await client.newPage();
    p.on("pageerror", (e) => erreurs.push(e.message));
    await p.goto(b.url(url.pathname));
    await p.getByRole("heading", { level: 1, name: /^Devis D-/ }).waitFor();
    await p.getByText("De Atelier Devis pour Client SAS").waitFor();
    expect(await p.locator("#total-ttc").textContent()).toMatch(/2\s?160,00/);
    expect(await p.getByRole("link", { name: "Télécharger le PDF" }).getAttribute("href")).toEndWith("/pdf");
    expect(await p.evaluate(auditer)).toEqual([]);

    await p.getByRole("button", { name: "Accepter le devis" }).click();
    await p.getByText("Indiquez votre nom et votre fonction.").waitFor();
    await p.getByLabel("Nom et fonction").fill("Claire Dupont, gérante");
    await p.getByRole("button", { name: "Accepter le devis" }).click();
    await p.getByText("Devis accepté.").waitFor();
    expect(await p.getByRole("button", { name: "Accepter le devis" }).isVisible()).toBe(false);

    await page.reload();
    await page.locator(".badge", { hasText: "Accepté" }).first().waitFor();
    expect(await page.getByRole("button", { name: "Partager le lien" }).count()).toBe(0);

    await p.goto(b.url("/devis/lien-invalide"));
    await p.getByText("Ce lien est invalide ou a expiré.").waitFor();
    expect(erreurs).toEqual([]);
    await client.close();
    await ctx.close();
  },
  60_000,
);

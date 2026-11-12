// Parcours réel, sur base jetable : fournisseur → chantier → devis prérempli → pièce → achat classé.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { enregistrerRecue, withTenant } from "@auto/store";
import { chrome, demarrerBanc, type Banc } from "./support";
import { auditer } from "./audit";
const executable = chrome();
const scenario = executable ? test : test.skip;
let banc: Banc;
beforeAll(async () => {
  if (executable) banc = await demarrerBanc(executable);
});
afterAll(async () => {
  if (banc) await banc.arreter();
});
scenario(
  "fournisseur, chantier, devis, livraison et classement ; mobile et thèmes",
  async () => {
    const session = await banc.inscrire("parcours-chantier@exemple.fr", "Bâtir ensemble");
    await banc.appel("/v1/clients", session, {
      nom: "Maison Moreau",
      siret: "",
      adresse: "12 allée des Pins",
      email: "client@exemple.fr",
    });
    const ctx = await banc.connecte(session, 1440);
    const page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.goto(banc.url("/app/fournisseurs"));
    await page.getByRole("button", { name: "Nouveau fournisseur" }).click();
    const modale = page.getByRole("dialog");
    await modale.getByLabel("Nom ou raison sociale").fill("Matériaux Provence");
    await modale.getByLabel("Contact", { exact: true }).fill("Service livraison");
    await modale.getByLabel("E-mail").fill("contact@exemple.fr");
    await modale.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.getByText("Fournisseur enregistré", { exact: true }).waitFor();
    await page.getByRole("cell", { name: "Matériaux Provence", exact: true }).waitFor();
    await page.getByRole("link", { name: "Chantiers et analytique", exact: true }).click();
    await page.getByRole("button", { name: "Nouveau chantier" }).click();
    await modale.getByLabel("Nom du chantier").fill("Villa des Pins");
    await modale.getByLabel("Code analytique").fill("CH-001");
    await modale.getByLabel("Client").selectOption({ label: "Maison Moreau" });
    await modale.getByLabel("Budget HT (€)").fill("48000");
    await modale.getByLabel("Avancement (%)").fill("70");
    await modale.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.getByRole("link", { name: "Villa des Pins", exact: true }).click();
    await page.getByRole("heading", { name: "Villa des Pins", exact: true }).waitFor();
    const chantierUrl = page.url();
    await page.getByRole("link", { name: "Créer un devis", exact: true }).click();
    expect(await page.getByLabel("Client enregistré").inputValue()).not.toBe("");
    expect(await page.getByLabel("Chantier / code analytique").inputValue()).not.toBe("");
    await page.getByLabel("Désignation, ligne 1").fill("Travaux de maçonnerie");
    await page.getByLabel("Prix unitaire HT (€)").fill("1250");
    await page.getByRole("button", { name: "Enregistrer le brouillon", exact: true }).click();
    await page.getByRole("heading", { name: "Devis (brouillon)", exact: true }).waitFor();
    await page.getByRole("link", { name: "Villa des Pins", exact: true }).click();
    await page.getByRole("button", { name: "Livraisons et commandes", exact: true }).click();
    await page.getByRole("button", { name: "Ajouter une pièce" }).click();
    await modale.getByLabel("Référence fournisseur").fill("BL-042");
    await modale.getByRole("combobox", { name: /^Fournisseur/ }).selectOption({ label: "Matériaux Provence" });
    await modale.getByLabel("Désignation").fill("Ciment 35 kg");
    await modale.getByLabel("Quantité").fill("40");
    await modale.getByLabel("Prix unitaire HT (€)").fill("8.50");
    await modale.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.getByText("BL-042", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Modifier BL-042", exact: true }).click();
    await modale.getByLabel("Pièce archivée").check();
    await modale.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.getByText("À vérifier · Archivé", { exact: true }).waitFor();
    const moi = await banc.appel("/v1/moi", session);
    const recue = await withTenant(banc.sql, moi.tenantId, (tx) =>
      enregistrerRecue(
        tx,
        null,
        {
          contenu: new TextEncoder().encode("facture de test " + crypto.randomUUID()),
          typeMime: "application/pdf",
          canal: "api",
        },
        {
          source: "ocr",
          statut: "a_verifier",
          anomalies: [],
          facture: {
            type: "facture",
            numero: "ACH-123",
            date: "2026-10-24",
            devise: "EUR",
            fournisseur: { nom: "Matériaux Provence" },
            lignes: [],
            totaux: { htCents: 34000, tvaCents: 6800, ttcCents: 40800 },
          },
        },
      ),
    );
    await page.getByRole("link", { name: "Factures reçues", exact: true }).click();
    await page.getByRole("button", { name: "Classer", exact: true }).click();
    await modale.getByRole("combobox", { name: /^Fournisseur/ }).selectOption({ label: "Matériaux Provence" });
    await modale.getByLabel("Chantier", { exact: true }).selectOption({ label: "CH-001 · Villa des Pins" });
    await modale.getByRole("button", { name: "Enregistrer le classement" }).click();
    await page.getByRole("button", { name: "Valider", exact: true }).click();
    await page.goto(chantierUrl);
    await page.getByRole("button", { name: "Synthèse analytique", exact: true }).waitFor();
    await page.getByText("340,00 €", { exact: true }).waitFor();
    const captures = Bun.env.AUTO_CAPTURES || `${process.cwd()}/.cache/chantiers-qa`;
    await page.screenshot({ path: captures + "/chantier-desktop.png", fullPage: true });
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await page.evaluate(auditer)).toEqual([]);
      await page.screenshot({ path: captures + `/chantier-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: captures + "/chantier-sombre.png", fullPage: true });
    expect(erreurs).toEqual([]);
    await page.goto(banc.url("/app/fournisseurs"));
    await page.getByRole("link", { name: "Matériaux Provence", exact: true }).click();
    await page.getByRole("heading", { name: "Matériaux Provence", exact: true }).waitFor();
    await page.getByRole("link", { name: "ACH-123", exact: true }).waitFor();
    await page.goto(banc.url("/app/recherche"));
    await page.getByLabel("Votre recherche").fill("BL-042");
    await page.getByRole("link", { name: "BL-042", exact: true }).click();
    await page.getByRole("button", { name: "Modifier BL-042", exact: true }).waitFor();
    expect(await page.getByLabel("Afficher").inputValue()).toBe("archives");
    await page.goto(banc.url("/app/commandes"));
    await page.getByRole("heading", { name: "Confirmations de commande", exact: true }).waitFor();
    await page.getByRole("button", { name: "Nouvelle pièce" }).click();
    expect(await modale.getByLabel("Type de pièce").inputValue()).toBe("confirmation_commande");
    await modale.getByRole("button", { name: "Annuler", exact: true }).click();
    expect(recue.id).toBeTruthy();
    await ctx.close();
  },
  60000,
);

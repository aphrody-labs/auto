// Qualification publique explicite : compte QA privé obligatoire, aucune émission de facture.
import { expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chrome } from "./support";
const fichier = join(homedir(), ".auto/qa-parcours-auto.json"),
  q = await Bun.file(fichier).json();
expect(q.email).toMatch(/@example\.test$/);
expect(q.moi.tenantId).toMatch(/^[a-f0-9-]{36}$/);
const base = "https://auto.aphrody.com";
async function api(path: string) {
  const r = await fetch(base + path, { headers: { authorization: "Bearer " + q.session } });
  const j = await r.json();
  expect(r.status).toBe(200);
  return j;
}
const indexes = await api("/v1/fichiers-indexes");
const f = indexes.find((f: any) => f.nom === "devis-qa-parcours.docx");
expect(f?.devisId).toBeTruthy();
q.indexId = f.id;
q.devisInitialId = f.devisId;
const initial = (await api("/v1/devis-recus")).find((d: any) => d.id === f.devisId);
expect(initial.anomalies).toEqual([]);
expect(initial.data.totaux.ttcCents).toBe(60000);
console.log("IMPORT_IA_INITIAL_OK", f.id, initial.id, 60000);
const browser = await chromium.launch({ executablePath: chrome()! });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fr-FR" });
await ctx.addCookies([{ ...q.cookie, url: base }]);
const page = await ctx.newPage();
const erreurs: string[] = [];
page.on("pageerror", (e) => erreurs.push(e.message));
try {
  await page.goto(base + "/app/fichiers");
  const row = page.getByRole("row").filter({ hasText: "devis-qa-parcours.docx" });
  await row.getByRole("button", { name: "Travailler sur une copie" }).click();
  await page.waitForURL(/\/app\/atelier\/[a-f0-9-]+/);
  q.atelierId = new URL(page.url()).pathname.split("/").at(-1);
  await Bun.write(fichier, JSON.stringify(q, null, 2));
  await page.getByText("Prêt à travailler", { exact: false }).waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f) => f.url().includes("/craft/word/"))!;
  expect(frame).toBeTruthy();
  await frame.locator("canvas").click({ position: { x: 330, y: 300 } });
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+a");
  const texte = [
    "DEVIS DEV-QA-20261025-01",
    "Date du devis : 2026-10-25",
    "Fournisseur : Atelier QA Controle",
    "SIRET : 73282932000074",
    "Adresse fournisseur : 1 rue du Controle, 69001 Lyon",
    "Client : Maison Controle QA",
    "Adresse client : 12 rue des Tests, 69001 Lyon",
    "Prestation : Pose de fenetres corrigee dans Craft",
    "Quantite : 2",
    "Prix unitaire HT : 300,00 EUR",
    "Total HT : 600,00 EUR",
    "TVA : 20 % soit 120,00 EUR",
    "Total TTC : 720,00 EUR",
    "Devise : EUR",
  ].join("\n");
  await page.keyboard.type(texte, { delay: 1 });
  await page.keyboard.press("Control+s");
  let modifie: any;
  for (let n = 0; n < 60; n++) {
    modifie = await api("/v1/atelier/" + q.atelierId);
    if (modifie.document.revision >= 2) break;
    await page.waitForTimeout(500);
  }
  expect(modifie.document.revision).toBeGreaterThanOrEqual(2);
  expect(modifie.inspection.extrait).toContain("300,00 EUR");
  expect(modifie.inspection.extrait).not.toContain("250,00 EUR");
  console.log("CRAFT_SAUVEGARDE_OK", q.atelierId, modifie.document.revision);
  await page.screenshot({ path: ".cache/parcours-reel-craft.png" });
  const reponse = page.waitForResponse((r) => r.url().endsWith("/extraire-devis") && r.request().method() === "POST", {
    timeout: 360000,
  });
  await page.getByRole("button", { name: "Extraire ce devis", exact: true }).click();
  const r = await reponse;
  const extraction = await r.json();
  expect(r.status()).toBe(200);
  expect(extraction.devis.anomalies).toEqual([]);
  expect(extraction.devis.data.totaux.ttcCents).toBe(72000);
  q.devisModifieId = extraction.devis.id;
  await Bun.write(fichier, JSON.stringify(q, null, 2));
  console.log("IA_VERSION_MODIFIEE_OK", q.devisModifieId, 72000);
  await page.waitForURL(/\/app\/devis-recus/);
  const lignes = page.getByRole("row").filter({ hasText: "DEV-QA-20261025-01" });
  const corrige = lignes.filter({ hasText: "720,00" });
  await corrige.getByRole("button", { name: "Vérifier", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("button", { name: "Valider les informations", exact: true }).click();
  await page.getByText("Informations validées", { exact: true }).waitFor();
  await modal.getByLabel("Document à préparer").selectOption("facture");
  await modal.getByLabel("Client pour le nouveau brouillon").selectOption(q.clientId);
  await modal.getByRole("button", { name: "Créer un brouillon client prérempli", exact: true }).click();
  await page.getByRole("heading", { name: "Facture (brouillon)", exact: true }).waitFor();
  q.factureId = new URL(page.url()).pathname.split("/").at(-1);
  const facture = await api("/v1/documents/" + q.factureId);
  expect(facture.type).toBe("facture");
  expect(facture.statut).toBe("brouillon");
  expect(facture.numero).toBeNull();
  expect(facture.ttcCents).toBe(72000);
  expect(facture.data.lignes[0].prixUnitaireHtCents).toBe(30000);
  await Bun.write(fichier, JSON.stringify(q, null, 2));
  console.log("FACTURE_BROUILLON_OK", q.factureId, 72000);
  await page.screenshot({ path: ".cache/parcours-reel-facture.png" });
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: ".cache/parcours-reel-facture-" + width + ".png" });
  }
  expect(erreurs).toEqual([]);
  console.log(
    "PARCOURS_REEL_REUSSI",
    JSON.stringify({
      tenant: q.moi.tenantId,
      source: q.sourceId,
      original: q.devisInitialId,
      atelier: q.atelierId,
      devisModifie: q.devisModifieId,
      facture: q.factureId,
      ttcCents: 72000,
      erreurs,
    }),
  );
} finally {
  await browser.close();
}

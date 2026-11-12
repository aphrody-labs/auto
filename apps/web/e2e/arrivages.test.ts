import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { enregistrerDevisRecu, withTenant } from "@auto/store";
import { chrome, demarrerBanc, type Banc } from "./support";
import { auditer } from "./audit";
const executable = chrome();
const scenario = executable ? test : test.skip;
let banc: Banc, dossier: string;
const racinesAvant = Bun.env.AUTO_DOSSIERS_RACINES;
beforeAll(async () => {
  if (executable) {
    banc = await demarrerBanc(executable);
    dossier = await mkdtemp(join(tmpdir(), "auto-arrivages-ui-"));
  }
});
afterAll(async () => {
  if (banc) await banc.arreter();
  if (racinesAvant === undefined) delete Bun.env.AUTO_DOSSIERS_RACINES;
  else Bun.env.AUTO_DOSSIERS_RACINES = racinesAvant;
  if (
    dossier &&
    relative(resolve(tmpdir()), resolve(dossier)).startsWith("auto-arrivages-ui-") &&
    !relative(resolve(tmpdir()), resolve(dossier)).includes("..")
  )
    await rm(dossier, { recursive: true, force: true });
});
scenario(
  "connexion, relève, revue de devis, brouillon prérempli et navigation segmentée",
  async () => {
    const session = await banc.inscrire("arrivages-ui@exemple.fr", "Atelier Provence");
    const moi = await banc.appel("/v1/moi", session);
    Bun.env.AUTO_DOSSIERS_RACINES = JSON.stringify({ comptabilite: { tenantId: moi.tenantId, chemin: dossier } });
    await Bun.write(join(dossier, "livraison.txt"), "Bon de livraison BL-PROVENCE : quarante sacs de ciment");
    await banc.appel("/v1/clients", session, { nom: "Maison Moreau", siret: "", adresse: "12 allée des Pins" });
    await withTenant(banc.sql, moi.tenantId, (tx) =>
      enregistrerDevisRecu(
        tx,
        null,
        {
          contenu: new TextEncoder().encode("original devis"),
          nom: "devis.pdf",
          typeMime: "application/pdf",
          canal: "api",
        },
        {
          devis: {
            type: "devis",
            numero: "DEV-PROVENCE",
            date: "2026-10-24",
            devise: "EUR",
            fournisseur: { nom: "Menuiserie Provence", siret: "73282932000074", adresse: "1 rue A" },
            lignes: [
              {
                designation: "Pose des fenêtres",
                quantite: 2,
                prixUnitaireHtCents: 25000,
                tauxTva: 200,
                htCents: 50000,
              },
            ],
            totaux: { htCents: 50000, tvaCents: 10000, ttcCents: 60000 },
          },
          anomalies: [],
          texte: "Deux fenêtres, pose comprise : 600 euros TTC",
        },
      ),
    );
    const ctx = await banc.connecte(session, 1440),
      page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.goto(banc.url("/app/sources-fichiers"));
    await page.getByRole("button", { name: "Connecter un dossier", exact: true }).click();
    const modale = page.getByRole("dialog");
    await modale.getByLabel("Nom du dossier").fill("Archives livraisons");
    await modale.getByLabel("Segment autorisé à consulter").selectOption("livraisons");
    await modale.getByRole("button", { name: "Enregistrer la connexion" }).click();
    await page.getByRole("button", { name: "Synchroniser", exact: true }).click();
    await page.getByText("1 nouvelle(s) pièce(s), 0 inchangée(s), 0 erreur(s)", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Consulter les fichiers indexés" }).click();
    await page.getByRole("link", { name: "livraison.txt", exact: true }).waitFor();
    expect(await page.evaluate(auditer)).toEqual([]);
    await page.goto(banc.url("/app/devis-recus"));
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    expect(await modale.getByLabel("Référence du devis").inputValue()).toBe("DEV-PROVENCE");
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await page.evaluate(auditer)).toEqual([]);
      await page.screenshot({ path: `.cache/arrivages-qa/devis-${width}.png`, fullPage: true, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(await page.evaluate(auditer)).toEqual([]);
    await page.screenshot({ path: ".cache/arrivages-qa/devis-sombre.png", fullPage: true, animations: "disabled" });
    await modale.getByRole("button", { name: "Valider les informations" }).click();
    await page.getByText("Informations validées", { exact: true }).waitFor();
    await modale.getByLabel("Client pour le nouveau brouillon").selectOption({ label: "Maison Moreau" });
    await modale.getByRole("button", { name: "Créer un brouillon client prérempli" }).click();
    await page.getByRole("heading", { name: "Devis (brouillon)", exact: true }).waitFor();
    const collegue = await banc.inscrire("livraisons-ui@exemple.fr", "Compte collègue");
    const autre = await banc.appel("/v1/moi", collegue);
    await banc.sql`INSERT INTO membership(tenant_id,user_id,role) VALUES (${moi.tenantId},${autre.userId},'comptable')`;
    await page.goto(banc.url("/app/parametres"));
    await page.getByLabel("Membre à configurer").selectOption({ label: "livraisons-ui@exemple.fr" });
    for (const nom of [
      "Comptabilité clients",
      "Comptabilité fournisseurs",
      "Analytique chantier",
      "Confirmations de commande",
    ])
      await page.getByRole("checkbox", { name: nom, exact: true }).uncheck();
    await page.getByRole("button", { name: "Enregistrer les permissions" }).click();
    await page.getByText("Permissions enregistrées", { exact: true }).waitFor();
    const restrictions = await banc.appel("/v1/membres/segments", session);
    expect(restrictions.find((r: any) => r.userId === autre.userId).segments).toEqual(["livraisons"]);
    await withTenant(
      banc.sql,
      moi.tenantId,
      (tx) => tx`INSERT INTO membre_segments(user_id,segments) VALUES (${moi.userId},${["livraisons"]}::text[])`,
    );
    await banc.sql`UPDATE membership SET role='comptable' WHERE tenant_id=${moi.tenantId} AND user_id=${moi.userId}`;
    await page.goto(banc.url("/app/livraisons"));
    await page.getByRole("heading", { name: "Bons de livraison", exact: true }).waitFor();
    expect(await page.getByRole("link", { name: "Devis reçus", exact: true }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Fournisseurs", exact: true }).count()).toBe(0);
    await page.goto(banc.url("/app/devis-recus"));
    await page.getByRole("heading", { name: "Accès restreint", exact: true }).waitFor();
    expect(erreurs).toEqual([]);
    await ctx.close();
  },
  60000,
);

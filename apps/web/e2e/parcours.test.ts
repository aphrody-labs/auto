// Parcours de bout en bout dans Chrome headless : inscription (3 étapes, SIREN prérempli) → devis émis →
// conversion en facture émise → tableau de bord. API réelle sur une base Postgres jetable, front servi par
// Bun.serve et proxy same-origin (cookie de session HttpOnly). Captures écrites dans AUTO_CAPTURES.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, type Sql } from "@auto/store";
import { chromium, type Browser, type Page } from "playwright-core";
import { creerApp } from "@auto/api/app";
import { demarrerWeb } from "../src/serveur";

/** Chrome headless de Playwright déjà installé (aucun téléchargement). */
function chrome(): string | null {
  if (Bun.env.AUTO_CHROME) return Bun.env.AUTO_CHROME;
  const racine =
    Bun.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(Bun.env.LOCALAPPDATA ?? join(Bun.env.HOME ?? "", ".cache"), "ms-playwright");
  const motifs = [
    "chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium-*/chrome-win64/chrome.exe",
    "chromium-*/chrome-linux64/chrome",
  ];
  for (const m of motifs)
    for (const f of existsSync(racine) ? new Bun.Glob(m).scanSync({ cwd: racine, onlyFiles: true }) : [])
      return join(racine, f);
  return null;
}

const executable = chrome();
const CAPTURES = Bun.env.AUTO_CAPTURES ?? join(tmpdir(), "auto-captures");

let sql: Sql;
let drop: () => Promise<void>;
let api: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof demarrerWeb>;
let navigateur: Browser;
let page: Page;

beforeAll(async () => {
  if (!executable) return;
  mkdirSync(CAPTURES, { recursive: true });
  ({ sql, drop } = await testDb());
  api = Bun.serve({
    port: 0,
    routes: creerApp(sql),
    fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
  });
  web = demarrerWeb({ api: api.url });
  navigateur = await chromium.launch({ executablePath: executable });
  page = await navigateur.newPage({
    viewport: { width: 1280, height: 900 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });
  page.on("pageerror", (e) => console.error(`[navigateur] ${e.message}`));
  // L'annuaire des entreprises est simulé : le test ne dépend pas du réseau.
  await page.route("**/v1/siren/*", (r) =>
    r.fulfill({
      json: {
        siren: "732829320",
        nom: "Atelier Martin SARL",
        siretSiege: "73282932000074",
        adresse: "12 rue des Lilas, 75011 Paris",
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await navigateur?.close();
  await web?.stop(true);
  await api?.stop(true);
  await drop?.();
}, 30_000);

const capture = (nom: string) => page.screenshot({ path: join(CAPTURES, `${nom}.png`), fullPage: true });
const url = (c: string) => new URL(c, web.url).toString();

test.skipIf(!executable)(
  "inscription → devis émis → facture émise → tableau de bord",
  async () => {
    // Inscription, étape 1 : compte.
    await page.goto(url("/app/inscription"));
    await page.getByRole("heading", { name: "Créer votre compte" }).waitFor();
    await page.getByRole("button", { name: "Continuer" }).click();
    await expect(page.getByText("Saisissez une adresse e-mail valide").isVisible()).resolves.toBe(true);
    await page.getByLabel("E-mail professionnel").fill("martin@exemple.fr");
    await page.getByLabel("Mot de passe").fill("un mot de passe très long");
    await capture("01-inscription-compte");
    await page.getByRole("button", { name: "Continuer" }).click();

    // Étape 2 : entreprise préremplie depuis le SIREN.
    await page.getByLabel("SIREN").fill("732 829 320");
    await page.getByRole("button", { name: "Rechercher" }).click();
    await page.getByText("Entreprise trouvée").waitFor();
    expect(await page.getByLabel("Raison sociale").inputValue()).toBe("Atelier Martin SARL");
    expect(await page.getByLabel("SIRET").inputValue()).toBe("732 829 320 00074");
    await capture("02-inscription-entreprise");
    await page.getByRole("button", { name: "Créer mon entreprise" }).click();

    // Étape 3 : connexions à venir.
    await page.getByText("Compte créé").waitFor();
    expect(await page.getByText("À connecter", { exact: true }).count()).toBe(2);
    await capture("03-inscription-connexions");
    await page.getByRole("button", { name: "Accéder au tableau de bord" }).click();
    await page.getByRole("heading", { name: "Créez votre premier devis" }).waitFor();
    await capture("04-tableau-vide");

    // Devis : client libre, une ligne remisée, totaux en direct.
    await page.getByRole("link", { name: "Créer un devis" }).click();
    await page.getByRole("heading", { name: /Nouveau document : devis/ }).waitFor();
    await page.getByLabel("Nom ou raison sociale").fill("Boulangerie Durand");
    await page.getByLabel(/^Adresse/).fill("3 place du Marché, 69002 Lyon");
    await page.getByLabel("Désignation, ligne 1").fill("Refonte du site vitrine");
    await page.getByLabel("Quantité").fill("2");
    await page.getByLabel("Prix unitaire HT (€)").fill("450");
    await page.getByLabel("Remise (%)").fill("10");
    const totaux = page.getByRole("complementary", { name: "Totaux" });
    await expect(totaux.textContent()).resolves.toMatch(/Total HT\s*810,00\s€/);
    await expect(totaux.textContent()).resolves.toMatch(/TVA 20 %\s*162,00\s€/);
    await expect(totaux.textContent()).resolves.toMatch(/Total TTC\s*972,00\s€/);
    await capture("05-editeur-devis");
    await page.getByRole("button", { name: "Enregistrer et émettre" }).click();
    await page.getByRole("heading", { name: /Devis D-\d{4}-0001/ }).waitFor();

    // Conversion en facture, émission (Factur-X figé côté API).
    await page.getByRole("link", { name: "Convertir en facture" }).click();
    await page.getByRole("heading", { name: /Nouveau document : facture/ }).waitFor();
    expect(await page.getByLabel("Désignation, ligne 1").inputValue()).toBe("Refonte du site vitrine");
    await page.getByRole("button", { name: "Enregistrer et émettre" }).click();
    await page.getByRole("heading", { name: /Facture F-\d{4}-0001/ }).waitFor();
    await page.getByText("Statut : Émise").waitFor();
    await page.getByText(/Reste dû : 972,00/).waitFor();
    await capture("06-facture-emise");

    // PDF Factur-X servi par le proxy avec le cookie de session.
    const href = await page.getByRole("link", { name: /^PDF/ }).getAttribute("href");
    const pdf = await page.request.get(url(href!));
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

    // Liste des factures et tableau de bord.
    await page
      .getByRole("navigation", { name: "Navigation principale" })
      .getByRole("link", { name: "Factures", exact: true })
      .click();
    await page.getByRole("cell", { name: /F-\d{4}-0001/ }).waitFor();
    await capture("07-liste-factures");
    await page
      .getByRole("navigation", { name: "Navigation principale" })
      .getByRole("link", { name: "Tableau de bord" })
      .click();
    const ca = page.getByRole("region", { name: /Chiffre d'affaires HT/ });
    await expect(ca.textContent()).resolves.toContain("810,00");
    await expect(page.getByRole("region", { name: /TVA collectée/ }).textContent()).resolves.toContain("162,00");
    await expect(page.getByRole("region", { name: "Impayés" }).textContent()).resolves.toContain("972,00");
    await capture("08-tableau-de-bord");

    // Thème sombre (data-theme) et mobile : tableaux en cartes, tiroir de navigation.
    await page.evaluate(() => (document.documentElement.dataset.theme = "sombre"));
    await capture("09-tableau-sombre");
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByRole("button", { name: "Ouvrir le menu" }).click();
    await capture("10-menu-mobile-sombre");
    await page
      .getByRole("navigation", { name: "Navigation principale" })
      .getByRole("link", { name: "Factures", exact: true })
      .click();
    await page.getByRole("cell", { name: /F-\d{4}-0001/ }).waitFor();
    await capture("11-factures-mobile-sombre");

    // Audit chaîné intact après le parcours.
    const audit = await page.request.get(url("/v1/audit/verification"));
    expect((await audit.json()).ok).toBe(true);
  },
  120_000,
);

test.skipIf(!executable)(
  "gestion : import CSV de clients, employé et absence validée, gabarit, exports",
  async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const nav = page.getByRole("navigation", { name: "Navigation principale" });

    // Import guidé : aperçu, correspondance proposée par l'API, bilan.
    await nav.getByRole("link", { name: "Imports" }).click();
    await page.getByLabel("Tableur").setInputFiles({
      name: "clients.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "Raison sociale;Adresse;Email\nCafé du Port;1 quai Ouest, 13002 Marseille;cafe@exemple.fr\n;sans nom;\n",
      ),
    });
    await page.getByRole("button", { name: "Lire l'aperçu" }).click();
    await page.getByRole("heading", { name: "2. Correspondance des colonnes" }).waitFor();
    await capture("14-import-apercu");
    await page.getByRole("button", { name: /^Importer/ }).click();
    await page.getByText("1 créé, 0 ignoré (déjà présents)").waitFor();
    await page.getByText(/Ligne 3 :/).waitFor();
    await nav.getByRole("link", { name: "Clients" }).click();
    await page.getByRole("cell", { name: "Café du Port", exact: true }).waitFor();
    await capture("15-clients");

    // Employé, demande d'absence, validation.
    await nav.getByRole("link", { name: "Employés" }).click();
    await page.getByRole("button", { name: "Ajouter un employé" }).click();
    const modale = page.getByRole("dialog", { name: "Ajouter un employé" });
    await modale.getByLabel(/^Prénom/).fill("Léa");
    await modale.getByLabel(/^Nom/).fill("Petit");
    await modale.getByLabel(/^Poste/).fill("Développeuse");
    await modale.getByLabel(/^Date d'entrée/).fill("2025-01-06");
    await modale.getByLabel(/^Salaire brut/).fill("3 000");
    await modale.getByRole("button", { name: "Enregistrer" }).click();
    await page.getByRole("link", { name: "Léa Petit" }).click();
    await page.getByRole("heading", { name: /Congés payés/ }).waitFor();
    await page.getByLabel(/^Du/).fill("2026-12-21");
    await page.getByLabel(/^Au/).fill("2026-12-24");
    await page.getByRole("button", { name: "Envoyer la demande" }).click();
    await page.getByRole("cell", { name: "Demandée", exact: true }).waitFor();
    await capture("16-fiche-employe");
    await nav.getByRole("link", { name: "Absences" }).click();
    await page.getByRole("button", { name: "Valider", exact: true }).click();
    await page.getByRole("heading", { name: "Aucune demande en attente" }).waitFor();

    // Gabarit : couleur et pied de page relus par l'API.
    await nav.getByRole("link", { name: "Paramètres" }).click();
    await page.getByLabel("Code couleur").fill("#7A3E9D");
    await page.getByLabel("Pied de page des documents").fill("SARL au capital de 5 000 €");
    await page.getByRole("button", { name: "Enregistrer le gabarit" }).click();
    await page.getByText("Gabarit enregistré").waitFor();
    const g = await (await page.request.get(url("/v1/parametres/gabarit"))).json();
    expect(g).toMatchObject({ couleur: "#7A3E9D", piedDePage: "SARL au capital de 5 000 €" });
    await page.getByText("Chaîne d'audit intègre").waitFor();
    await capture("17-parametres");

    // Exports : liens téléchargeables avec la session.
    await nav.getByRole("link", { name: "Exports" }).click();
    const xlsx = await page.getByRole("link", { name: "Journal des ventes (xlsx)" }).getAttribute("href");
    const r = await page.request.get(url(xlsx!));
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("spreadsheetml");
    await capture("18-exports");
  },
  120_000,
);

test.skipIf(!executable)(
  "pages publiques : accueil et tarifs",
  async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url("/"));
    const contact = page.getByRole("link", { name: "Contact", exact: true });
    await contact.waitFor();
    expect(await contact.getAttribute("href")).toBe("mailto:contact@aphrody.com");
    await capture("12-accueil");
    await page.getByRole("link", { name: "Tarifs", exact: true }).first().click();
    await page.getByRole("heading", { name: "Tarifs", level: 1 }).waitFor();
    expect(await page.getByText("30 jours d'essai").isVisible()).toBe(true);
    await capture("13-tarifs");
  },
  60_000,
);

/** Pages vérifiées à 375 et 1440 px, en clair et en sombre (session du parcours précédent). */
const PAGES = [
  ["tableau", "/app", "Tableau de bord"],
  ["factures", "/app/factures", "Factures"],
  ["editeur", "/app/documents/nouveau?type=facture", "Nouveau document : facture"],
  ["parametres", "/app/parametres", "Paramètres"],
  ["accueil", "/", "Du chantier au bureau, tout se retrouve."],
  ["tarifs", "/tarifs", "Tarifs"],
] as const;

test.skipIf(!executable)(
  "375 et 1440 px, clair et sombre : aucun défilement horizontal, cibles et noms accessibles",
  async () => {
    for (const theme of ["clair", "sombre"] as const) {
      await page.evaluate((t) => localStorage.setItem("auto-theme", t), theme);
      for (const largeur of [375, 1440]) {
        await page.setViewportSize({ width: largeur, height: 900 });
        for (const [nom, chemin, titre] of PAGES) {
          await page.goto(url(chemin));
          await page.getByRole("heading", { level: 1, name: titre }).waitFor();
          await page.locator(".squelette").first().waitFor({ state: "detached" });
          expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
          const audit = await page.evaluate(() => {
            const d = document.documentElement;
            const visibles = [
              ...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea"),
            ].filter((e) => e.offsetParent !== null && !e.closest(".visuellement-cache"));
            return {
              debord: d.scrollWidth - d.clientWidth,
              // Cible minimale WCAG 2.5.8 (24 px) ; les liens dans le texte courant sont exemptés.
              petites: visibles
                .filter((e) => !(e.tagName === "A" && e.closest("p, li, dd, td")))
                .filter((e) => (e as HTMLInputElement).type !== "checkbox")
                .filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width < 24 || r.height < 24;
                })
                .map((e) => e.outerHTML.slice(0, 80)),
              sansNom: [...document.querySelectorAll<HTMLElement>("button, a[href]")]
                .filter((e) => e.offsetParent !== null && !(e.textContent?.trim() || e.getAttribute("aria-label")))
                .map((e) => e.outerHTML.slice(0, 80)),
              sansLibelle: [...document.querySelectorAll<HTMLInputElement>("input, select, textarea")]
                .filter((e) => e.type !== "hidden" && !e.labels?.length && !e.getAttribute("aria-label"))
                .map((e) => e.outerHTML.slice(0, 80)),
            };
          });
          expect({ page: `${nom} ${largeur} ${theme}`, ...audit }).toEqual({
            page: `${nom} ${largeur} ${theme}`,
            debord: 0,
            petites: [],
            sansNom: [],
            sansLibelle: [],
          });
          await capture(`r-${nom}-${largeur}-${theme}`);
        }
      }
    }
    await page.evaluate(() => localStorage.removeItem("auto-theme"));
  },
  180_000,
);

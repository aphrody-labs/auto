// Audit d'accessibilité dans Chrome headless, sur les écrans connectés : contraste du texte mesuré contre le
// fond réellement peint (WCAG 1.4.3), contrôles sans nom, champs sans libellé, images sans texte de
// remplacement et défilement horizontal. Thèmes clair et sombre, 375 et 1440 px de large.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { testDb, type Sql } from "@auto/store";
import { chromium, type Browser } from "playwright-core";
import { creerApp } from "@auto/api/app";
import { cookieSession } from "@auto/tenancy";
import { demarrerWeb } from "../src/serveur";
import { auditer } from "./audit";

function chrome(): string | null {
  if (Bun.env.AUTO_CHROME) return Bun.env.AUTO_CHROME;
  const racine =
    Bun.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(Bun.env.LOCALAPPDATA ?? join(Bun.env.HOME ?? "", ".cache"), "ms-playwright");
  for (const m of [
    "chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium-*/chrome-win64/chrome.exe",
    "chromium-*/chrome-linux64/chrome",
  ])
    for (const f of existsSync(racine) ? new Bun.Glob(m).scanSync({ cwd: racine, onlyFiles: true }) : [])
      return join(racine, f);
  return null;
}

const executable = chrome();
let sql: Sql;
let drop: () => Promise<void>;
let api: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof demarrerWeb>;
let navigateur: Browser;
let session = "";
const ids: Record<string, string> = {};

async function appel(chemin: string, corps?: unknown) {
  const r = await fetch(new URL(chemin, api.url), {
    method: corps === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  return (await r.json()) as any;
}

beforeAll(async () => {
  if (!executable) return;
  ({ sql, drop } = await testDb());
  api = Bun.serve({
    port: 0,
    routes: creerApp(sql),
    fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
  });
  web = demarrerWeb({ api: api.url });
  navigateur = await chromium.launch({ executablePath: executable });
  // Données représentatives : un client, un devis, une facture émise et payée en partie, un employé.
  const i = await appel("/v1/auth/inscription", {
    email: "audit@exemple.fr",
    motDePasse: "un mot de passe long",
    entreprise: { nom: "Atelier Martin", siret: "73282932000074", adresse: "12 rue des Lilas, 75011 Paris" },
  });
  session = i.session;
  const client = { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon", email: "compta@client.fr" };
  await appel("/v1/clients", client);
  const lignes = [{ designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tva: 200 }];
  const base = { client, lignes, datePrestation: "2026-10-15", echeance: "2026-11-21" };
  const devis = await appel("/v1/documents", { ...base, type: "devis" });
  await appel(`/v1/documents/${devis.id}/emettre`, {});
  const f = await appel("/v1/documents", { ...base, type: "facture" });
  await appel(`/v1/documents/${f.id}/emettre`, {});
  await appel(`/v1/documents/${f.id}/paiements`, { date: "2026-10-22", montantCents: 50000, mode: "virement" });
  ids.facture = f.id;
  await appel("/v1/employes", {
    nom: "Durand",
    prenom: "Inès",
    poste: "Comptable",
    contrat: "cdi",
    dateEntree: "2024-03-01",
    tempsTravail: 100,
    salaireBrutMensuelCents: 250000,
  });
}, 60_000);

afterAll(async () => {
  await navigateur?.close();
  await web?.stop(true);
  await api?.stop(true);
  await drop?.();
}, 30_000);

const ECRANS = () => [
  "/app",
  "/app/devis",
  "/app/factures",
  `/app/documents/${ids.facture}`,
  "/app/documents/nouveau",
  "/app/clients",
  "/app/produits",
  "/app/employes",
  "/app/absences",
  "/app/imports",
  "/app/exports",
  "/app/parametres",
];

for (const [largeur, hauteur] of [
  [1440, 900],
  [375, 812],
] as const)
  for (const theme of ["clair", "sombre"] as const)
    test.skipIf(!executable)(
      `écrans connectés accessibles, ${theme}, ${largeur} px`,
      async () => {
        const ctx = await navigateur.newContext({ viewport: { width: largeur, height: hauteur }, locale: "fr-FR" });
        await ctx.addCookies([{ ...(await cookieSession(sql, session)), url: web.url.toString() }]);
        await ctx.addInitScript((t) => localStorage.setItem("auto-theme", t), theme);
        const page = await ctx.newPage();
        const defauts: string[] = [];
        for (const chemin of ECRANS()) {
          await page.goto(new URL(chemin, web.url).toString(), { waitUntil: "networkidle" });
          await page.waitForSelector("h1", { timeout: 10_000 });
          for (const d of await page.evaluate(auditer)) defauts.push(`${chemin} : ${d}`);
        }
        await ctx.close();
        expect([...new Set(defauts)]).toEqual([]);
      },
      120_000,
    );

test.skipIf(!executable)("témoin : l'audit détecte des défauts plantés", async () => {
  const page = await navigateur.newPage({ viewport: { width: 375, height: 600 } });
  await page.setContent(`<main>
    <p style="color:#999;background:#fff">texte trop pâle</p>
    <button><svg width="16" height="16"></svg></button>
    <input placeholder="Email">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <div style="width:600px">large</div>
  </main>`);
  const d = await page.evaluate(auditer);
  await page.close();
  expect(d.some((x) => x.startsWith("contraste 2.85"))).toBe(true);
  expect(d.some((x) => x.startsWith("contrôle sans nom"))).toBe(true);
  expect(d.some((x) => x.startsWith("champ sans libellé"))).toBe(true);
  expect(d.some((x) => x.startsWith("image sans alt"))).toBe(true);
  expect(d.some((x) => x.startsWith("défilement horizontal"))).toBe(true);
  expect(d).toContain("aucun titre h1");
});

test.skipIf(!executable)(
  "thème : appliqué avant le JavaScript, bascule à deux états, contrôles natifs alignés",
  async () => {
    // Système sombre, aucun réglage : la page suit le système.
    const ctx = await navigateur.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await ctx.addCookies([{ ...(await cookieSession(sql, session)), url: web.url.toString() }]);
    const page = await ctx.newPage();
    await page.goto(new URL("/app", web.url).toString(), { waitUntil: "networkidle" });
    const etat = () =>
      page.evaluate(() => ({
        theme: document.documentElement.dataset.theme ?? null,
        stocke: localStorage.getItem("auto-theme"),
        schema: getComputedStyle(document.documentElement).colorScheme,
      }));
    expect(await etat()).toEqual({ theme: null, stocke: null, schema: "light dark" });

    // Bascule : passe au thème opposé de celui affiché (clair), mémorisé car différent du système.
    await page.getByRole("button", { name: "Passer au thème clair" }).click();
    expect(await etat()).toEqual({ theme: "clair", stocke: "clair", schema: "light" });
    // Retour au thème du système : rien n'est mémorisé.
    await page.getByRole("button", { name: "Passer au thème sombre" }).click();
    expect(await etat()).toEqual({ theme: null, stocke: null, schema: "light dark" });

    // Thème mémorisé appliqué par le script en ligne, même si les scripts de l'application ne chargent pas.
    await page.evaluate(() => localStorage.setItem("auto-theme", "clair"));
    await page.route("**/*.js", (r) => r.abort());
    await page.goto(new URL("/app", web.url).toString(), { waitUntil: "domcontentloaded" });
    expect(await etat()).toMatchObject({ theme: "clair", schema: "light" });
    await ctx.close();
  },
);

test.skipIf(!executable)(
  "tableaux : cartes sous 600 px de conteneur, en-têtes retirés de l'arbre d'accessibilité",
  async () => {
    const ctx = await navigateur.newContext({ viewport: { width: 375, height: 812 } });
    await ctx.addCookies([{ ...(await cookieSession(sql, session)), url: web.url.toString() }]);
    const page = await ctx.newPage();
    await page.goto(new URL("/app/factures", web.url).toString(), { waitUntil: "networkidle" });
    const thead = page.locator(".tableau thead").first();
    expect(await thead.evaluate((e) => getComputedStyle(e).display)).toBe("none");
    const libelle = await page
      .locator(".tableau td[data-libelle]")
      .first()
      .evaluate((e) => getComputedStyle(e, "::before").content);
    expect(libelle).not.toBe("none");
    await ctx.close();
  },
);

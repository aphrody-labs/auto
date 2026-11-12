// Factures reçues dans Chrome headless : deux fournisseurs déposent leur facture (l'une Factur-X conforme, l'autre
// avec des totaux incohérents), l'acheteur les retrouve dans « Factures reçues » et valide celle à vérifier.
// Capture 1280×800 écrite dans AUTO_CAPTURES (reprise par la fiche Chrome Web Store de l'extension).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, type Sql } from "@auto/store";
import { chromium, type Browser, type Page } from "playwright-core";
import { creerApp } from "@auto/api/app";
import { demarrerWeb } from "../src/serveur";

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
const CAPTURES = Bun.env.AUTO_CAPTURES ?? join(tmpdir(), "auto-captures");
const MDP = "un mot de passe très long";

let sql: Sql;
let drop: () => Promise<void>;
let api: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof demarrerWeb>;
let navigateur: Browser;
let page: Page;

async function appel(chemin: string, session: string, corps?: unknown, type = "application/json") {
  const r = await fetch(new URL(chemin, api.url), {
    method: corps === undefined ? "GET" : "POST",
    headers: { "content-type": type, authorization: `Bearer ${session}` },
    ...(corps === undefined ? {} : { body: type === "application/json" ? JSON.stringify(corps) : (corps as string) }),
  });
  if (!r.ok) throw new Error(`${chemin} : ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}

async function inscrire(email: string, nom: string, siret: string) {
  const r = await fetch(new URL("/v1/auth/inscription", api.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, motDePasse: MDP, entreprise: { nom, siret, adresse: "1 rue A, Lyon" } }),
  });
  return ((await r.json()) as { session: string }).session;
}

/** XML CII d'une facture émise par un fournisseur auto. */
async function facture(session: string, designation: string, prixUnitaireHtCents: number) {
  const d = (await appel("/v1/documents", session, {
    type: "facture",
    date: "2026-10-12",
    client: { nom: "Atelier Martin SARL", siret: "73282932000074", adresse: "12 rue des Lilas, 75011 Paris" },
    lignes: [{ designation, quantite: 1, prixUnitaireHtCents, tva: 200 }],
    datePrestation: "2026-10-10",
    echeance: "2026-11-11",
  })) as { id: string };
  await appel(`/v1/documents/${d.id}/emettre`, session, {});
  return (await appel(`/v1/documents/${d.id}/xml`, session)) as string;
}

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

  const imprimerie = await inscrire("compta@imprimerie.fr", "Imprimerie Lumière", "73282932000074");
  const hebergeur = await inscrire("factures@hebergeur.fr", "Nuage Hébergement SAS", "73282932000074");
  const acheteur = await inscrire("martin@exemple.fr", "Atelier Martin SARL", "73282932000074");
  const jeton = ((await appel("/v1/jetons", acheteur, { nom: "extension" })) as { jeton: string }).jeton;

  await appel("/v1/factures-recues", jeton, await facture(imprimerie, "Cartes de visite", 18000), "application/xml");
  // Total TTC falsifié : la facture arrive « à vérifier » (HT + TVA ≠ TTC).
  const xml = (await facture(hebergeur, "Hébergement annuel", 54000)).replace(
    /(<ram:GrandTotalAmount[^>]*>)[^<]+/,
    "$1699.00",
  );
  await appel("/v1/factures-recues", jeton, xml, "application/xml");

  navigateur = await chromium.launch({ executablePath: executable });
  page = await navigateur.newPage({ viewport: { width: 1280, height: 800 }, locale: "fr-FR" });
  page.on("pageerror", (e) => console.error(`[navigateur] ${e.message}`));
}, 60_000);

afterAll(async () => {
  await navigateur?.close();
  await web?.stop(true);
  await api?.stop(true);
  await drop?.();
}, 30_000);

test.skipIf(!executable)(
  "factures reçues : liste filtrée, anomalies visibles, validation",
  async () => {
    await page.goto(new URL("/app/connexion", web.url).toString());
    await page.getByLabel("E-mail").fill("martin@exemple.fr");
    await page.getByLabel("Mot de passe").fill(MDP);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("link", { name: "Factures reçues" }).click();
    await page.getByRole("heading", { name: "Factures reçues" }).waitFor();

    // Filtre par défaut « À vérifier » : seule la facture aux totaux incohérents.
    await page.getByText("Nuage Hébergement SAS").waitFor();
    expect(await page.getByText("Imprimerie Lumière").count()).toBe(0);
    expect(await page.getByText("HT + TVA ≠ TTC").count()).toBe(1);

    await page.getByRole("button", { name: "Toutes" }).click();
    await page.getByText("Imprimerie Lumière").waitFor();
    await page.screenshot({ path: join(CAPTURES, "factures-recues.png") });

    await page.getByRole("button", { name: "À vérifier" }).click();
    await page.getByRole("button", { name: "Valider" }).click();
    await page.getByText("Aucune facture à vérifier").waitFor();
    await page.getByRole("button", { name: "Validées" }).click();
    await page.getByText("Nuage Hébergement SAS").waitFor();
    expect(await page.getByText("Imprimerie Lumière").count()).toBe(1);
  },
  60_000,
);

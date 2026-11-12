/// <reference types="chrome" />
// Extension chargée dans Chrome headless : un fournisseur publie le Factur-X émis par un tenant auto ; l'extension
// d'un autre tenant le télécharge et le dépose dans ses factures reçues, puis met le badge à jour.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, type Sql } from "@auto/store";
import { chromium, type BrowserContext, type Worker } from "playwright-core";
import { creerApp } from "@auto/api/app";
import { construire } from "../scripts/construire";

function cheminChrome(): string | null {
  if (Bun.env.AUTO_CHROME) return Bun.env.AUTO_CHROME;
  const racine =
    Bun.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(Bun.env.LOCALAPPDATA ?? join(Bun.env.HOME ?? "", ".cache"), "ms-playwright");
  // Les extensions exigent le Chromium complet (le « headless shell » ne les charge pas).
  for (const m of ["chromium-*/chrome-win64/chrome.exe", "chromium-*/chrome-linux64/chrome"])
    for (const f of existsSync(racine) ? new Bun.Glob(m).scanSync({ cwd: racine, onlyFiles: true }) : [])
      return join(racine, f);
  return null;
}

const executable = cheminChrome();
let sql: Sql;
let drop: () => Promise<void>;
let api: ReturnType<typeof Bun.serve>;
let fournisseur: ReturnType<typeof Bun.serve>;

let contexte: BrowserContext;
let sw: Worker;
let idExtension = "";
const dossiers: string[] = [];
const acheteur = { session: "", jeton: "" };

async function appel(chemin: string, session: string, corps?: unknown) {
  const r = await fetch(new URL(chemin, api.url), {
    method: corps === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  return r.headers.get("content-type")?.includes("json") ? r.json() : new Uint8Array(await r.arrayBuffer());
}

const inscrire = async (email: string, nom: string) =>
  (
    await (
      await fetch(new URL("/v1/auth/inscription", api.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          motDePasse: "un mot de passe long",
          entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Paris" },
        }),
      })
    ).json()
  ).session as string;

beforeAll(async () => {
  if (!executable) return;
  ({ sql, drop } = await testDb());
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: creerApp(sql),
    fetch: () => new Response("404", { status: 404 }),
  });

  // Le vendeur émet une facture : son exemplaire Factur-X est ce que le fournisseur met en ligne.
  const vendeur = await inscrire("vendeur-ext@exemple.fr", "Vendeur SAS");
  const d = (await appel("/v1/documents", vendeur, {
    type: "facture",
    date: "2026-10-01",
    client: { nom: "Acheteur SARL", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Maintenance", quantite: 1, prixUnitaireHtCents: 45000, tva: 200 }],
    datePrestation: "2026-09-30",
    echeance: "2026-10-31",
  })) as { id: string };
  await appel(`/v1/documents/${d.id}/emettre`, vendeur, {});
  const pdf = new Uint8Array((await appel(`/v1/documents/${d.id}/pdf`, vendeur)) as Uint8Array);
  fournisseur = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/": new Response('<!doctype html><html lang="fr"><a href="/telecharger?id=7">Votre facture</a></html>', {
        headers: { "content-type": "text/html" },
      }),
      "/telecharger": new Response(pdf, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="F-2026-0001.pdf"',
        },
      }),
    },
  });

  acheteur.session = await inscrire("acheteur-ext@exemple.fr", "Acheteur SARL");
  acheteur.jeton = ((await appel("/v1/jetons", acheteur.session, { nom: "extension" })) as { jeton: string }).jeton;

  const ext = mkdtempSync(join(tmpdir(), "auto-ext-"));
  const profil = mkdtempSync(join(tmpdir(), "auto-ext-profil-"));
  dossiers.push(ext, profil);
  await construire({ dist: Bun.pathToFileURL(`${ext}/`), hotes: ["http://127.0.0.1/*"] });
  contexte = await chromium.launchPersistentContext(profil, {
    executablePath: executable,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  sw = contexte.serviceWorkers()[0] ?? (await contexte.waitForEvent("serviceworker"));
  idExtension = new URL(sw.url()).host;
}, 90_000);

afterAll(async () => {
  await contexte?.close();
  await fournisseur?.stop(true);
  await api?.stop(true);
  await drop?.();
  for (const d of dossiers) rmSync(d, { recursive: true, force: true });
}, 30_000);

test.skipIf(!executable)("dépôt d'une facture fournisseur depuis Chrome, badge à jour", async () => {
  expect(idExtension).toMatch(/^[a-p]{32}$/);
  await sw.evaluate((r) => chrome.storage.local.set(r), {
    instance: new URL(api.url).origin.replace("localhost", "127.0.0.1"),
    jeton: acheteur.jeton,
  });

  const popup = await contexte.newPage();
  await popup.goto(`chrome-extension://${idExtension}/popup.html`);
  await expect(popup.locator("h1").textContent()).resolves.toBe("auto");
  expect(await popup.getByLabel("Jeton API").count()).toBe(1);
  expect(await popup.getByLabel("Adresse de votre instance").count()).toBe(1);

  const lien = new URL("/telecharger?id=7", fournisseur.url).toString().replace("localhost", "127.0.0.1");
  await popup.evaluate((url) => chrome.runtime.sendMessage({ type: "envoyer", url }), lien);

  const recues = (await appel("/v1/factures-recues", acheteur.session)) as {
    canal: string;
    statut: string;
    numero: string;
    fournisseur: string;
  }[];
  expect(recues).toHaveLength(1);
  expect(recues[0]).toMatchObject({
    canal: "api",
    statut: "validee",
    numero: "F-2026-0001",
    fournisseur: "Vendeur SAS",
  });

  // Le badge reflète la file « à vérifier » de l'instance (vide : le Factur-X a été lu directement).
  expect(await sw.evaluate(() => chrome.action.getBadgeText({}))).toBe("");
  expect(await sw.evaluate(async () => (await chrome.storage.local.get("aVerifier")).aVerifier)).toBe(0);

  // Renvoyée une seconde fois : reconnue comme doublon, toujours une seule facture.
  await popup.evaluate((url) => chrome.runtime.sendMessage({ type: "envoyer", url }), lien);
  expect(await appel("/v1/factures-recues", acheteur.session)).toHaveLength(1);
});

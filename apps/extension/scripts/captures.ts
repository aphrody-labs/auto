// Visuels du Chrome Web Store : deux captures 1280×800 et la vignette 440×280, écrits dans apps/extension/store.
// L'extension réelle est construite dans un dossier temporaire, où sont ajoutées des pages de composition qui
// encadrent la vraie popup (même origine, donc iframe possible). Ces pages ne sont jamais dans dist ni dans le zip.
// Aucun appel réseau : la popup n'est pas soumise. Usage : bun apps/extension/scripts/captures.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { construire } from "./construire";

function cheminChrome(): string | null {
  if (Bun.env.AUTO_CHROME) return Bun.env.AUTO_CHROME;
  const racine =
    Bun.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(Bun.env.LOCALAPPDATA ?? join(Bun.env.HOME ?? "", ".cache"), "ms-playwright");
  for (const m of ["chromium-*/chrome-win64/chrome.exe", "chromium-*/chrome-linux64/chrome"])
    for (const f of existsSync(racine) ? new Bun.Glob(m).scanSync({ cwd: racine, onlyFiles: true }) : [])
      return join(racine, f);
  return null;
}

const STYLE = `
  html, body { margin: 0; }
  body { background: var(--auto-fond); color: var(--auto-texte); font-family: var(--auto-police-corps); }
  h1, .nom { font-family: var(--auto-police-titre); font-weight: 600; margin: 0; }
  .scene { box-sizing: border-box; width: 1280px; height: 800px; display: grid; grid-template-columns: 1fr 560px;
    align-items: center; padding: 0 var(--auto-espace-16) 0 112px; gap: var(--auto-espace-8); }
  h1 { font-size: 44px; line-height: 1.15; max-width: 13em; color: var(--auto-primaire); }
  ul { list-style: none; margin: var(--auto-espace-8) 0 0; padding: 0; display: grid; gap: var(--auto-espace-4); }
  li { font-size: 20px; line-height: 1.4; max-width: 24em; }
  .popup { justify-self: center; width: 374px; height: 704px; position: relative; }
  iframe { position: absolute; top: 0; left: 0; width: 340px; height: 650px; border: 0; transform: scale(1.1);
    transform-origin: top left; background: var(--auto-fond); border-radius: var(--auto-rayon-lg);
    box-shadow: var(--auto-ombre-lg); }
`;

const scene = (titre: string, points: string[]) => `<!doctype html><html lang="fr"><meta charset="utf-8">
<link rel="stylesheet" href="tokens.css"><style>${STYLE}</style>
<main class="scene"><div><h1>${titre}</h1><ul>${points.map((p) => `<li>${p}</li>`).join("")}</ul></div>
<div class="popup"><iframe src="popup.html" title="Popup de l'extension"></iframe></div></main></html>`;

const VIGNETTE = `<!doctype html><html lang="fr"><meta charset="utf-8"><link rel="stylesheet" href="tokens.css">
<style>html,body{margin:0}body{width:440px;height:280px;box-sizing:border-box;background:var(--auto-fond);
color:var(--auto-texte);font-family:var(--auto-police-corps);display:flex;flex-direction:column;justify-content:center;
padding:0 var(--auto-espace-10);gap:var(--auto-espace-3)}
img{width:64px;height:64px;border-radius:var(--auto-rayon-lg)}
.nom{font-size:64px;line-height:1;color:var(--auto-primaire);margin:0;font-family:var(--auto-police-titre);font-weight:600}
p{margin:0;font-size:20px}</style>
<img src="icons/icon-128.png" alt=""><div class="nom">auto</div><p>Vos factures fournisseurs, sans saisie</p></html>`;

const executable = cheminChrome();
if (!executable) throw new Error("Chromium complet introuvable (AUTO_CHROME ou playwright install chromium).");

const sortie = Bun.fileURLToPath(new URL("../store/", import.meta.url));
mkdirSync(sortie, { recursive: true });
const ext = mkdtempSync(join(tmpdir(), "auto-cap-"));
const profil = mkdtempSync(join(tmpdir(), "auto-cap-profil-"));
try {
  await construire({ dist: Bun.pathToFileURL(`${ext}/`) });
  await Bun.write(
    join(ext, "capture-1.html"),
    scene("Envoyez vos factures fournisseurs à auto", [
      "Clic droit sur un lien de facture PDF ou Factur-X : elle arrive dans auto.",
      "Le nombre de factures à vérifier reste sous vos yeux.",
      "Autorisations minimales, accordées site par site.",
    ]),
  );
  await Bun.write(
    join(ext, "capture-2.html"),
    scene("Réglez l'extension en quelques secondes", [
      "Indiquez votre instance : auto.aphrody.com ou votre serveur.",
      "Collez un jeton API créé dans auto.",
      "Le jeton reste sur votre appareil.",
    ]),
  );
  await Bun.write(join(ext, "vignette.html"), VIGNETTE);

  const contexte = await chromium.launchPersistentContext(profil, {
    executablePath: executable,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const sw = contexte.serviceWorkers()[0] ?? (await contexte.waitForEvent("serviceworker"));
    const base = `chrome-extension://${new URL(sw.url()).host}`;
    const page = await contexte.newPage();

    // Capture 1 : compte connecté, trois factures à vérifier.
    await sw.evaluate((r) => chrome.storage.local.set(r), {
      instance: "https://auto.aphrody.com",
      jeton: "auto_exemple",
      aVerifier: 3,
      entreprise: "Acheteur SARL",
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/capture-1.html`);
    await page.frameLocator("iframe").getByText("3 facture(s) à vérifier.").waitFor();
    await page.screenshot({ path: join(sortie, "capture-1.png") });

    // Capture 2 : extension non configurée, jeton saisi (jamais soumis : aucun appel réseau).
    await sw.evaluate(() => chrome.storage.local.clear());
    await page.goto(`${base}/capture-2.html`);
    const popup = page.frameLocator("iframe");
    await popup.getByLabel("Jeton API").fill("auto_0123456789abcdef");
    await page.screenshot({ path: join(sortie, "capture-2.png") });

    await page.setViewportSize({ width: 440, height: 280 });
    await page.goto(`${base}/vignette.html`);
    await page.screenshot({ path: join(sortie, "promo-440x280.png") });
  } finally {
    await contexte.close();
  }
} finally {
  rmSync(ext, { recursive: true, force: true });
  rmSync(profil, { recursive: true, force: true });
}
for (const f of ["capture-1.png", "capture-2.png", "promo-440x280.png"]) {
  const o = new DataView((await Bun.file(join(sortie, f)).slice(16, 24).arrayBuffer()) as ArrayBuffer);
  console.log(`${f} : ${o.getUint32(0)}×${o.getUint32(4)}`);
}

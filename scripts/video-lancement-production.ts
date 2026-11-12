// Recette du site publié : aucune connexion ni écriture métier.
import { chromium, devices } from "../apps/web/node_modules/playwright-core";
const origin = Bun.env.AUTO_VIDEO_SITE_URL ?? "https://auto.aphrody.com";
const root = process.cwd().replaceAll("\\", "/");
const browserRoot = `${Bun.env.LOCALAPPDATA}/ms-playwright`;
const executablePath =
  Bun.env.AUTO_CHROME ??
  [...new Bun.Glob("chromium-*/chrome-win64/chrome.exe").scanSync({ cwd: browserRoot, absolute: true })][0];
if (!executablePath) throw new Error("Chromium requis");
const head = await fetch(`${origin}/media/lancement-btp.mp4`, { method: "HEAD" });
if (!head.ok || !head.headers.get("content-type")?.startsWith("video/mp4"))
  throw new Error("La vraie vidéo n'est pas publiée");
const range = await fetch(`${origin}/media/lancement-btp.mp4`, { headers: { Range: "bytes=0-127" } });
const rangeBytes = new Uint8Array(await range.arrayBuffer());
if (
  range.status !== 206 ||
  rangeBytes.length !== 128 ||
  !range.headers.get("content-range")?.startsWith("bytes 0-127/")
)
  throw new Error("Lecture partielle MP4 non qualifiée");
const navigateur = await chromium.launch({ executablePath });
const results: unknown[] = [];
try {
  for (const width of [1440, 375]) {
    const ctx = await navigateur.newContext({
      ...(width === 375 ? devices["Pixel 7"] : {}),
      viewport: { width, height: width === 375 ? 812 : 1000 },
      colorScheme: "light",
      locale: "fr-FR",
    });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    try {
      await p.goto(origin, { waitUntil: "domcontentloaded" });
      await p.getByRole("heading", { level: 1 }).waitFor();
      if (!(await p.title()).includes("BTP")) throw new Error("L'ancienne vitrine est encore servie");
      if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
        throw new Error(`Débordement ${width}px`);
      await p.screenshot({
        path: `${root}/dist/lancement-btp/production/accueil-${width}.png`,
        animations: "disabled",
      });
      const video = p.locator("video");
      await video.waitFor({ state: "visible" });
      await video.scrollIntoViewIfNeeded();
      const lancer = p.getByRole("button", { name: "Voir la présentation", exact: true });
      if (await lancer.isVisible()) await lancer.click();
      await p.waitForFunction(() => document.querySelector("video")!.readyState >= 1, null, { timeout: 30000 });
      const duration = await video.evaluate((v) => (v as HTMLVideoElement).duration);
      if (!Number.isFinite(duration) || Math.abs(duration - 259.833333) > 0.1)
        throw new Error("Le lecteur ne sert pas le film final");
      await video.evaluate((v) => (v as HTMLVideoElement).play());
      await p.waitForFunction(() => document.querySelector("video")!.currentTime > 1, null, { timeout: 30000 });
      const target = Math.min(35, duration / 2);
      await video.evaluate((v, t) => {
        (v as HTMLVideoElement).currentTime = t;
      }, target);
      await p.waitForFunction(
        (t) => {
          const v = document.querySelector("video")!;
          return v.readyState >= 3 && Math.abs(v.currentTime - t) < 2;
        },
        target,
        { timeout: 30000 },
      );
      await video.evaluate((v) => (v as HTMLVideoElement).pause());
      await video.screenshot({
        path: `${root}/dist/lancement-btp/production/lecteur-${width}.png`,
        animations: "disabled",
      });
      await p.getByRole("tab", { name: "Devis et factures", exact: true }).click();
      const src = await p
        .getByRole("tabpanel", { name: "Devis et factures", exact: true })
        .locator("img")
        .getAttribute("src");
      if (src !== "/img/btp-devis-editeur.webp") throw new Error("Démonstration non fonctionnelle");
      const enlarge = await p.locator(".btp-demonstration figcaption a").boundingBox();
      if (!enlarge || enlarge.width < 44 || enlarge.height < 44)
        throw new Error("La cible Agrandir doit mesurer au moins 44 × 44 px");
      for (const path of ["/app/connexion", "/app/inscription", "/telechargements"]) {
        await p.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
        await p.getByRole("heading", { level: 1 }).first().waitFor();
        await p.screenshot({
          path: `${root}/dist/lancement-btp/production/${path.split("/").at(-1)}-${width}.png`,
          animations: "disabled",
        });
      }
      if (errors.length) throw new Error(`Erreurs JS : ${errors.join(" ; ")}`);
      results.push({
        width,
        mobile: width === 375,
        duration,
        playback: "passed",
        seek: "passed",
        tabs: "passed",
        touchTarget: "passed",
        authPages: "passed",
        downloads: "passed",
        errors,
      });
    } finally {
      await ctx.close();
    }
  }
  await Bun.write(
    `${root}/dist/lancement-btp/production/verification.json`,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        origin,
        media: {
          status: head.status,
          bytes: head.headers.get("content-length"),
          etag: head.headers.get("etag"),
          rangeStatus: range.status,
        },
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await navigateur.close();
}

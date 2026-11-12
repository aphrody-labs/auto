// Vitrine BTP réelle : ressources, onglets clavier, FAQ, liens d'accès et affichage adaptatif.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { demarrerWeb } from "../src/serveur";
import { chrome } from "./support";
import { auditer } from "./audit";
setDefaultTimeout(45_000);
const executable = chrome();
let navigateur: Browser;
let web: ReturnType<typeof demarrerWeb>;
beforeAll(async () => {
  if (!executable) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      web = demarrerWeb({
        api: "http://127.0.0.1:9",
        hostname: "127.0.0.1",
        port: 30000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 30000),
      });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  if (!web) throw new Error("Aucun port disponible");
  navigateur = await chromium.launch({ executablePath: executable });
}, 60_000);
afterAll(async () => {
  await navigateur?.close();
  await web?.stop(true);
});
for (const width of [375, 768, 1440]) {
  test.skipIf(!executable)(
    `parcours BTP à ${width}px : captures, navigation, clavier, FAQ et mouvement réduit`,
    async () => {
      const ctx = await navigateur.newContext({
        viewport: { width, height: 900 },
        locale: "fr-FR",
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const p = await ctx.newPage();
      const erreurs: string[] = [];
      p.on("pageerror", (e) => erreurs.push(e.message));
      try {
        await p.goto(web.url.toString(), { waitUntil: "networkidle" });
        await p.getByRole("heading", { level: 1 }).waitFor();
        expect(await p.getByRole("heading", { level: 1 }).count()).toBe(1);
        expect(await p.title()).toContain("BTP");
        expect(
          await p.getByRole("link", { name: "Créer mon compte gratuit", exact: true }).first().getAttribute("href"),
        ).toBe("/app/inscription");
        expect(await p.getByRole("link", { name: "Se connecter", exact: true }).first().getAttribute("href")).toBe(
          "/app/connexion",
        );
        for (const anchor of await p
          .locator('a[href^="#"]')
          .evaluateAll((links) => links.map((link) => link.getAttribute("href")!)))
          expect(await p.locator(anchor).count()).toBe(1);
        expect(await p.getByRole("tab").count()).toBe(4);
        await p.getByRole("tab", { name: "Devis et factures", exact: true }).click();
        expect(
          await p.getByRole("tabpanel", { name: "Devis et factures", exact: true }).locator("img").getAttribute("src"),
        ).toBe("/img/btp-devis-editeur.webp");
        await p.getByRole("tab", { name: "Devis et factures", exact: true }).focus();
        await p.keyboard.press("ArrowRight");
        expect(await p.evaluate(() => document.activeElement?.textContent)).toContain("Achats");
        await p.keyboard.press("Enter");
        expect(await p.getByRole("tab", { selected: true }).count()).toBe(1);
        const question = p.locator("summary").filter({ hasText: "Faut-il installer un logiciel ?" });
        await question.click();
        expect(await p.locator("details").filter({ has: question }).getAttribute("open")).not.toBeNull();
        expect(await p.locator(".btp-heros-texte").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
        expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        for (const image of await p.locator("img:visible").all()) {
          await image.scrollIntoViewIfNeeded();
          await image.evaluate((image) => (image as HTMLImageElement).decode());
          expect(await image.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        expect(
          (await p.locator(".btp-demonstration figcaption a:visible").first().boundingBox())!.height,
        ).toBeGreaterThanOrEqual(44);
        expect(await p.evaluate(auditer)).toEqual([]);
        expect(erreurs).toEqual([]);
      } finally {
        await ctx.close();
      }
    },
  );
}
test.skipIf(!executable)("le thème sombre et le thème enregistré restent lisibles", async () => {
  const ctx = await navigateur.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  try {
    await p.goto(web.url.toString(), { waitUntil: "networkidle" });
    expect(await p.locator("html").evaluate((el) => getComputedStyle(el).colorScheme)).toBe("dark");
    await p.evaluate(() => localStorage.setItem("auto-theme", "clair"));
    await p.reload({ waitUntil: "networkidle" });
    expect(await p.locator("html").getAttribute("data-theme")).toBe("clair");
    expect(await p.locator("html").evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");
  } finally {
    await ctx.close();
  }
});

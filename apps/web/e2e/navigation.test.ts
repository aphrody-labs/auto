import { expect, test } from "bun:test";
import { chrome, demarrerBanc } from "./support";

const executable = chrome();
(executable ? test : test.skip)(
  "menu mobile : focus, Échap, navigation et passage au bureau",
  async () => {
    const banc = await demarrerBanc(executable!);
    try {
      const session = await banc.inscrire(`navigation-${crypto.randomUUID()}@exemple.fr`, "Navigation mobile");
      const contexte = await banc.connecte(session, 390);
      const page = await contexte.newPage();
      const erreurs: string[] = [];
      page.on("pageerror", (erreur) => erreurs.push(erreur.message));
      page.on("console", (message) => {
        if (message.type() === "error") erreurs.push(message.text());
      });
      page.on("requestfailed", (requete) => erreurs.push(`${requete.url()} : ${requete.failure()?.errorText}`));
      await page.goto(banc.url("/app"));
      const ouvrir = page.getByRole("button", { name: "Ouvrir le menu" });
      await ouvrir.waitFor({ timeout: 10_000 }).catch(async (erreur: Error) => {
        throw new Error(`${erreur.message}\n${erreurs.join("\n")}\n${await page.locator("body").innerText()}`);
      });
      await ouvrir.click();
      await page.locator("#navigation .nav-lien").first().waitFor({ state: "visible" });
      expect(await page.locator("#contenu").getAttribute("inert")).not.toBeNull();
      expect(await page.evaluate(() => document.getElementById("navigation")?.contains(document.activeElement))).toBe(
        true,
      );
      await page.keyboard.press("Shift+Tab");
      expect(
        await page.getByRole("button", { name: "Se déconnecter" }).evaluate((e) => e === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await ouvrir.waitFor();
      expect(await ouvrir.evaluate((e) => e === document.activeElement)).toBe(true);
      expect(await page.locator("#contenu").getAttribute("inert")).toBeNull();
      await ouvrir.click();
      await page.getByRole("link", { name: "Clients", exact: true }).click();
      await page.getByRole("heading", { name: "Clients", exact: true }).waitFor();
      await page.getByText("Aucun client enregistré", { exact: true }).waitFor();
      expect(await page.locator("#navigation").isVisible()).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (Bun.env.AUTO_QA_CAPTURE_DIR)
        await page.screenshot({ path: `${Bun.env.AUTO_QA_CAPTURE_DIR}/auto-mobile.png` });
      await ouvrir.click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => document.body.style.overflow !== "hidden");
      expect(await page.locator("#navigation").isVisible()).toBe(true);
      expect(await page.locator("#contenu").getAttribute("inert")).toBeNull();
      if (Bun.env.AUTO_QA_CAPTURE_DIR)
        await page.screenshot({ path: `${Bun.env.AUTO_QA_CAPTURE_DIR}/auto-desktop.png` });
      expect(erreurs).toEqual([]);
      await contexte.close();
    } finally {
      await banc.arreter();
    }
  },
  60_000,
);

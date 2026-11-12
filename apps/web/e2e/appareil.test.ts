import { expect, test } from "bun:test";
import { chrome, demarrerBanc } from "./support";
const executable = chrome();
(executable ? test : test.skip)(
  "Connexion appareil : deux contextes isolés, code approuvé, cookie HttpOnly dans le client sans jeton URL/storage",
  async () => {
    const avant = Bun.env.AUTO_CONNEXION_APPAREIL;
    Bun.env.AUTO_CONNEXION_APPAREIL = "1";
    const b = await demarrerBanc(executable!);
    try {
      const email = `appareil-${crypto.randomUUID()}@example.test`,
        session = await b.inscrire(email, "Recette appareil");
      const navigateur = await b.connecte(session),
        app = await b.navigateur.newContext({ viewport: { width: 1280, height: 860 } });
      await app.addInitScript(() => Object.defineProperty(window, "__AUTO_NATIVE__", { value: true }));
      const p = await app.newPage();
      await p.goto(b.url("/app/connexion"));
      await p.getByRole("button", { name: "Se connecter avec le navigateur", exact: true }).click();
      const code = (
        await p.locator('section[aria-label="Connexion avec le navigateur"] strong').innerText()
      ).replaceAll("-", "");
      expect(code.length).toBe(8);
      const verification = await navigateur.newPage();
      await verification.goto(b.url(`/app/verification-appareil?user_code=${encodeURIComponent(code)}`));
      await verification.getByRole("heading", { name: "Auto natif · Windows / Android" }).waitFor();
      expect(await verification.getByText(email, { exact: true }).isVisible()).toBe(true);
      await verification.getByRole("button", { name: "Autoriser cet appareil" }).click();
      await verification.getByText("Appareil autorisé.", { exact: false }).waitFor();
      await p.getByRole("link", { name: "Tableau de bord", exact: true }).waitFor({ timeout: 15000 });
      expect((await app.request.get(b.url("/v1/moi"))).status()).toBe(200);
      expect((await app.cookies()).some((c) => c.name.includes("session_token") && c.httpOnly)).toBe(true);
      expect(await p.evaluate(() => document.cookie.includes("session_token"))).toBe(false);
      expect(p.url()).not.toContain("token");
      expect(p.url()).not.toContain("device_code");
      expect(await p.evaluate(() => Object.keys(localStorage).some((k) => /session|token|device_code/i.test(k)))).toBe(
        false,
      );
      await app.close();
      await navigateur.close();
    } finally {
      await b.arreter();
      if (avant === undefined) delete Bun.env.AUTO_CONNEXION_APPAREIL;
      else Bun.env.AUTO_CONNEXION_APPAREIL = avant;
    }
  },
  60000,
);

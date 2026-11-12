// Connexion (cas négatifs, redirection sûre, session expirée), focus clavier et pages publiques
// (375 et 1440 px, clair et sombre : contraste, noms, libellés, cibles de 24 px, défilement horizontal).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { auditer } from "./audit";
import { chrome, demarrerBanc, MDP, type Banc } from "./support";

const executable = chrome();
let b: Banc;

beforeAll(async () => {
  if (executable) b = await demarrerBanc(executable);
}, 60_000);
afterAll(async () => {
  await b?.arreter();
}, 30_000);

test.skipIf(!executable)(
  "connexion : champs vides, mauvais mot de passe, retour sûr, session expirée",
  async () => {
    await b.inscrire("conn@exemple.fr", "Atelier Conn");
    const ctx = await b.navigateur.newContext({ viewport: { width: 375, height: 800 }, locale: "fr-FR" });
    const page = await ctx.newPage();
    await page.goto(b.url("/app/connexion?retour=//evil.example"));
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByText("Saisissez une adresse e-mail valide, par exemple nom@exemple.fr.").waitFor();
    await page.getByText("Saisissez votre mot de passe.").waitFor();
    await page.getByLabel("E-mail").fill("conn@exemple.fr");
    await page.getByLabel("Mot de passe").fill("mauvais mot de passe");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByText("E-mail ou mot de passe incorrect.").waitFor();
    await page.getByLabel("Mot de passe").fill(MDP);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL((u) => u.pathname === "/app");
    expect(new URL(page.url()).host).toBe(b.web.url.host);

    await ctx.clearCookies();
    await ctx.addCookies([{ name: "auto.session_token", value: "expiree", url: b.web.url.toString() }]);
    await page.goto(b.url("/app/factures"));
    await page.getByRole("heading", { name: "Se connecter" }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/app/connexion");
    await ctx.close();
  },
  60_000,
);

test.skipIf(!executable)("focus visible au clavier sur la connexion", async () => {
  const ctx = await b.navigateur.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(b.url("/app/connexion"));
  const vus = new Set<string>();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body) return null;
      const s = getComputedStyle(e);
      const contour = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      return {
        nom: `${e.tagName}:${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 20)}`,
        ok: contour || s.boxShadow !== "none",
      };
    });
    if (!r) continue;
    expect({ ...r, ok: r.ok }).toEqual({ nom: r.nom, ok: true });
    vus.add(r.nom);
  }
  expect(vus.size).toBeGreaterThanOrEqual(3);
  await ctx.close();
});

for (const [largeur, hauteur] of [
  [1440, 900],
  [375, 812],
] as const)
  for (const theme of ["clair", "sombre"] as const)
    test.skipIf(!executable)(
      `pages publiques accessibles, ${theme}, ${largeur} px`,
      async () => {
        const ctx = await b.navigateur.newContext({ viewport: { width: largeur, height: hauteur }, locale: "fr-FR" });
        await ctx.addInitScript((t) => localStorage.setItem("auto-theme", t), theme);
        const page = await ctx.newPage();
        const defauts: string[] = [];
        for (const chemin of [
          "/",
          "/tarifs",
          "/mentions-legales",
          "/confidentialite",
          "/app/connexion",
          "/app/inscription",
        ]) {
          await page.goto(b.url(chemin), { waitUntil: "networkidle" });
          await page.waitForSelector("h1", { timeout: 10_000 });
          for (const d of await page.evaluate(auditer)) defauts.push(`${chemin} : ${d}`);
          const petites = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")]
              .filter((e) => e.offsetParent !== null && !e.closest(".visuellement-cache"))
              .filter((e) => !(e.tagName === "A" && e.closest("p, li, dd, td")))
              .filter((e) => (e as HTMLInputElement).type !== "checkbox")
              .filter((e) => {
                const r = e.getBoundingClientRect();
                return r.width < 24 || r.height < 24;
              })
              .map((e) => e.outerHTML.slice(0, 80)),
          );
          for (const p of petites) defauts.push(`${chemin} : cible < 24 px : ${p}`);
        }
        await ctx.close();
        expect([...new Set(defauts)]).toEqual([]);
      },
      120_000,
    );

test.skipIf(!executable)(
  "écrans introuvables : titre h1, état vide explicite, sans réessai inutile",
  async () => {
    const s = await b.inscrire("introuvable@exemple.fr", "Atelier Introuvable");
    const ctx = await b.connecte(s, 375);
    const page = await ctx.newPage();
    await page.goto(b.url("/app/inconnu"));
    await page.getByRole("heading", { level: 1, name: "Page introuvable" }).waitFor();
    await page.getByRole("link", { name: "Retour au tableau de bord" }).click();
    await page.getByRole("heading", { level: 1, name: "Tableau de bord" }).waitFor();
    await page.goto(b.url("/app/documents/00000000-0000-0000-0000-000000000000"));
    await page.getByRole("heading", { name: "Document introuvable" }).waitFor();
    expect(await page.getByRole("button", { name: "Réessayer" }).count()).toBe(0);
    expect(await page.evaluate(auditer)).toEqual([]);
    await ctx.close();
  },
  60_000,
);

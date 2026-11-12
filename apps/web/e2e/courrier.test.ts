import { expect, test } from "bun:test";
import { chrome, demarrerBanc } from "./support";
import { avecCourrier, stockerCourrier, type CompteCourrier } from "@auto/store";
const executable = chrome();
(executable ? test : test.skip)(
  "Boîte personnelle sans entreprise : lecture, pièce jointe, recherche, mobile et administration protégée",
  async () => {
    const b = await demarrerBanc(executable!);
    try {
      const r = await fetch(b.url("/api/auth/sign-up/email"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `courrier-${crypto.randomUUID()}@example.test`,
          password: "mot-de-passe-recette-long",
          name: "Courrier privé",
        }),
      });
      const utilisateur = await r.json();
      expect(r.status).toBe(200);
      const contexte = await b.navigateur.newContext({ viewport: { width: 1440, height: 900 } });
      const cookies = r.headers.getSetCookie().map((c) => {
        const kv = c.split(";")[0]!,
          i = kv.indexOf("=");
        return { name: kv.slice(0, i), value: kv.slice(i + 1), url: b.url("/") };
      });
      await contexte.addCookies(cookies);
      const uid = utilisateur.user.id as string;
      const compte = await avecCourrier(
        b.sql,
        uid,
        uid,
        async (tx) =>
          (
            await tx<
              CompteCourrier[]
            >`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret) VALUES(${uid},'google','moi@example.test',${new Uint8Array([1])}) RETURNING *`
          )[0]!,
      );
      await avecCourrier(b.sql, uid, uid, (tx) =>
        stockerCourrier(tx, compte, {
          distantId: "recette-1",
          expediteur: "contact@example.test",
          destinataires: ["moi@example.test"],
          sujet: "Sujet de recette",
          texte: "Message privé <script>window.courrierIntrusion=true</script>",
          date: new Date().toISOString(),
          lu: false,
          pieces: [{ nom: "preuve.txt", type: "text/plain", octets: new TextEncoder().encode("preuve privée") }],
        }),
      );
      const session = await contexte.request.get(b.url("/api/auth/get-session"));
      expect((await session.json())?.user?.id).toBe(uid);
      const p = await contexte.newPage();
      const erreurs: string[] = [];
      p.on("pageerror", (e) => erreurs.push(e.message));
      p.on("console", (m) => {
        if (
          m.type() === "error" &&
          !(/\/v1\/(moi|admin\/)/.test(m.location().url) && /status of (401|403)/.test(m.text()))
        )
          erreurs.push(m.text());
      });
      await p.goto(b.url("/app/courrier"));
      await p
        .getByRole("heading", { name: "Ma boîte unifiée" })
        .waitFor({ timeout: 10000 })
        .catch(async (e: Error) => {
          throw Error(`${e.message}\n${erreurs.join("\n")}\n${await p.locator("body").innerText()}`);
        });
      await p.getByText("Sujet de recette", { exact: true }).click();
      await p.getByRole("heading", { name: "Sujet de recette" }).waitFor();
      expect(
        await p
          .getByRole("region", { name: "Lecture du message" })
          .getByText("Message privé <script>window.courrierIntrusion=true</script>", { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(await p.evaluate(() => Object.hasOwn(window, "courrierIntrusion"))).toBe(false);
      const piece = await p.getByRole("link", { name: "preuve.txt" }).getAttribute("href");
      const telechargement = await contexte.request.get(b.url(piece!));
      expect(telechargement.status()).toBe(200);
      expect(telechargement.headers()["content-type"]).toBe("application/octet-stream");
      expect((await telechargement.body()).toString()).toBe("preuve privée");
      await p.getByRole("searchbox").fill("introuvable-recette");
      await p.getByText("Aucun message dans cette vue.", { exact: false }).waitFor();
      await p.getByRole("searchbox").fill("");
      await p.getByRole("button", { name: /contact@example.test.*Sujet de recette/ }).waitFor();
      if (Bun.env.AUTO_QA_CAPTURE_DIR)
        await p.screenshot({ path: `${Bun.env.AUTO_QA_CAPTURE_DIR}/courrier-desktop.png` });
      await p.setViewportSize({ width: 390, height: 844 });
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (Bun.env.AUTO_QA_CAPTURE_DIR)
        await p.screenshot({ path: `${Bun.env.AUTO_QA_CAPTURE_DIR}/courrier-mobile.png` });
      await p.getByRole("link", { name: "Administration", exact: true }).click();
      await p.getByText("Super-administrateur humain requis", { exact: true }).waitFor();
      expect(erreurs).toEqual([]);
      await contexte.close();
    } finally {
      await b.arreter();
    }
  },
  60000,
);

import { strict as assert } from "node:assert";
import { demarrerBanc, chrome } from "./support";

const b = await demarrerBanc(chrome()!);
try {
  const token = await b.inscrire("craft-browser@exemple.fr", "Craft navigateur");
  const ctx = await b.connecte(token, 1440);
  const page = await ctx.newPage();
  const erreurs: string[] = [];
  page.on("pageerror", (e) => {
    erreurs.push(e.message);
    console.log("PAGEERROR", e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") {
      erreurs.push(m.text());
      console.log("CONSOLE", m.text());
    }
  });
  for (const format of ["excel", "word", "pdf"]) {
    let d: any;
    if (format === "pdf") {
      const w = await b.appel("/v1/atelier", token, { format: "word", nom: "Source.docx", segment: "chantiers" });
      const r = await fetch(new URL("/v1/atelier/" + w.id + "/export.pdf", b.api.url), {
        headers: { authorization: "Bearer " + token },
      });
      d = await b.appel("/v1/atelier/importer", token, {
        nom: "Controle.pdf",
        segment: "chantiers",
        fichier: (await r.bytes()).toBase64(),
      });
    } else
      d = await b.appel("/v1/atelier", token, {
        format,
        nom: format === "word" ? "Courrier.docx" : "Chantier.xlsx",
        segment: "chantiers",
      });
    console.log("DOCUMENT", format, d.id);
    await page.goto(b.url("/app/atelier/" + d.id));
    await page
      .getByText("Prêt à travailler", { exact: false })
      .waitFor({ timeout: 45000 })
      .catch(async (e) => {
        await page.screenshot({ path: ".cache/craft-erreur.png" });
        console.log("DOM", await page.locator("body").innerText());
        throw e;
      });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: ".cache/craft-" + format + ".png" });
    const frame = page.frames().find((f) => f.url().includes("/craft/"))!;
    console.log("CHARGE", format, frame.url(), await frame.locator("canvas").count());
    if (format === "excel" || format === "word") {
      await frame.locator("canvas").click({ position: { x: 330, y: 300 } });
      if (format === "excel") {
        await page.keyboard.press("Control+Home");
        await page.keyboard.type("42");
        await page.keyboard.press("Enter");
      } else {
        await page.keyboard.press("Control+End");
        await page.keyboard.type("Verification Craft Auto");
      }
      await page.keyboard.press("Control+s");
      await page.waitForTimeout(2000);
      const resultat = await b.appel("/v1/atelier/" + d.id, token);
      assert.equal(resultat.document.revision, 2);
      if (format === "excel") assert.equal(resultat.inspection.feuilles[0].apercu[1][0], 42);
      else assert.equal(resultat.inspection.extrait, "Verification Craft Auto");
      console.log("APRES", format, JSON.stringify(resultat));
    }
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
      console.log(
        "LARGEUR",
        format,
        width,
        await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth })),
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  assert.deepEqual(erreurs, []);
  console.log("ERREURS", JSON.stringify(erreurs));
  await ctx.close();
} finally {
  await b.arreter();
}

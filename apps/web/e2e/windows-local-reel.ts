// Qualification Windows locale explicite ; compte et fichiers de contrôle isolés.
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chrome } from "./support";
import { ecrireXlsx } from "../../../packages/native/src/index";
const service = "Auto.Windows.Local",
  name = "qa-controle",
  base = "http://127.0.0.1:3007";
let q: any;
const avant = await Bun.secrets.get({ service, name });
if (avant) q = JSON.parse(avant);
else {
  const password = crypto.randomUUID() + crypto.randomUUID();
  const r = await fetch(base + "/v1/auth/inscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "qa-windows-local@example.test",
      motDePasse: password,
      entreprise: {
        nom: "QA Windows local — contrôle",
        siret: "73282932000074",
        adresse: "1 rue du Controle, 69001 Lyon",
      },
    }),
  });
  assert.equal(r.status, 201);
  const data = await r.json();
  const kv = r.headers
      .getSetCookie()
      .find((s) => s.includes("session_token="))!
      .split(";")[0]!,
    i = kv.indexOf("=");
  q = { ...data, password, cookie: { name: kv.slice(0, i), value: kv.slice(i + 1) } };
  await Bun.secrets.set({ service, name, value: JSON.stringify(q) });
}
async function api(path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + q.session, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  assert.ok(r.ok, JSON.stringify(j));
  return j;
}
const p = Bun.spawn([process.execPath, "scripts/windows-local.ts", "preparer"], {
  cwd: join(import.meta.dir, "../../.."),
  stdout: "ignore",
  stderr: "inherit",
  windowsHide: true,
});
assert.equal(await p.exited, 0);
const conf = JSON.parse((await Bun.secrets.get({ service, name: "instance" }))!);
const original = ecrireXlsx({
  feuilles: [{ nom: "Feuille 1", colonnes: [{ titre: "Valeur" }, { titre: "Montant" }], lignes: [[2, 3]] }],
});
const fichier = join(conf.dossiers, q.tenantId, "fournisseurs/documents", "controle-excel.xlsx");
await Bun.write(fichier, original);
const sources = await api("/v1/sources-fichiers"),
  source = sources.find((s: any) => s.sousDossier === "fournisseurs/documents");
assert.ok(source);
assert.deepEqual((await api("/v1/sources-fichiers/" + source.id + "/synchroniser", {})).erreurs, []);
const b = await chromium.launch({ executablePath: chrome()! });
try {
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  await c.addCookies([{ ...q.cookie, url: base }]);
  const page = await c.newPage();
  const erreurs: string[] = [];
  page.on("pageerror", (e) => erreurs.push(e.message));
  await page.goto(base + "/app/fichiers", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page
    .getByRole("row")
    .filter({ hasText: "controle-excel.xlsx" })
    .getByRole("button", { name: "Travailler sur une copie" })
    .click();
  await page.waitForURL(/\/app\/atelier\//);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  await page.getByText("Prêt à travailler", { exact: false }).waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f) => f.url().includes("/craft/grid/"))!;
  await frame.locator("canvas").click({ position: { x: 330, y: 300 } });
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("42", { delay: 40 });
  await page.keyboard.press("Enter");
  await page.getByText("Modifications non sauvegardées", { exact: false }).waitFor({ timeout: 10000 });
  await page.keyboard.press("Control+s");
  let d: any;
  for (let n = 0; n < 30; n++) {
    d = await api("/v1/atelier/" + id);
    if (d.document.revision >= 2) break;
    await page.waitForTimeout(500);
  }
  assert.equal(d.document.revision, 2);
  assert.ok(d.inspection.feuilles[0].apercu.flat().includes(42));
  assert.deepEqual(await Bun.file(fichier).bytes(), original);
  assert.deepEqual(erreurs, []);
  await page.screenshot({ path: ".cache/windows-excel-local.png" });
  console.log(
    "WINDOWS_EXCEL_REEL_OK",
    JSON.stringify({ tenant: q.tenantId, atelier: id, revision: 2, cellule: 42, originalIntact: true }),
  );
} finally {
  await b.close();
}

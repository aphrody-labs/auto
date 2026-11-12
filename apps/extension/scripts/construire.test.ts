// Conformité du paquet construit : Manifest V3, fichiers référencés présents, icônes aux bonnes dimensions,
// aucune page avec script en ligne ni gestionnaire d'événement en ligne (CSP des extensions).
import { beforeAll, expect, test } from "bun:test";
import { construire, TAILLES } from "./construire";

const dist = new URL("../dist/", import.meta.url);
let fichiers: string[] = [];
let manifeste: Record<string, any>;

beforeAll(async () => {
  fichiers = (await construire()).map((f) => f.replaceAll("\\", "/"));
  manifeste = await Bun.file(new URL("manifest.json", dist)).json();
});

test("Manifest V3, aucune API V2", () => {
  expect(manifeste.manifest_version).toBe(3);
  expect(manifeste.background).toEqual({ service_worker: "service-worker.js", type: "module" });
  expect(manifeste.browser_action).toBeUndefined();
  expect(manifeste.action).toBeDefined(); // requis par chrome.action (badge, titre)
  expect(manifeste.name.length).toBeLessThanOrEqual(75);
  expect(manifeste.description.length).toBeLessThanOrEqual(132);
});

test("permissions minimales et hôtes restreints", () => {
  expect(manifeste.permissions.sort()).toEqual(["activeTab", "alarms", "contextMenus", "notifications", "storage"]);
  expect(manifeste.host_permissions).toEqual(["https://auto.aphrody.com/*"]);
  expect(manifeste.permissions).not.toContain("tabs");
  expect(JSON.stringify(manifeste)).not.toContain("<all_urls>");
});

test("chaque fichier référencé existe ; icônes PNG aux dimensions annoncées", async () => {
  const references = [
    manifeste.background.service_worker,
    manifeste.action.default_popup,
    manifeste.options_ui.page,
    ...Object.values(manifeste.icons),
    ...Object.values(manifeste.action.default_icon),
  ] as string[];
  for (const r of references) expect(fichiers).toContain(r);
  for (const t of TAILLES) {
    const png = await Bun.file(new URL(`icons/icon-${t}.png`, dist)).bytes();
    const v = new DataView(png.buffer);
    expect([v.getUint32(16), v.getUint32(20)]).toEqual([t, t]);
  }
  expect(fichiers).toContain("tokens.css");
});

test("pages sans script ni gestionnaire en ligne ; sources sans eval ni .then", async () => {
  const html = await Bun.file(new URL("popup.html", dist)).text();
  expect([...html.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc=/.test(m[0]))).toBe(true);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  for (const f of ["service-worker.js", "popup.js"]) {
    const js = await Bun.file(new URL(f, dist)).text();
    expect(js).not.toMatch(/\beval\(|new Function\(/);
  }
  for (const f of new Bun.Glob("*.ts").scanSync(Bun.fileURLToPath(new URL("../src/", import.meta.url))))
    expect(await Bun.file(new URL(`../src/${f}`, import.meta.url)).text()).not.toContain(".then(");
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { MANQUANTS } from "./manquants";
import { demarrerAdmin } from "./serveur";

let api: ReturnType<typeof Bun.serve>;
let admin: ReturnType<typeof demarrerAdmin>;

beforeAll(() => {
  api = Bun.serve({ port: 0, fetch: (req) => Response.json({ chemin: new URL(req.url).pathname }) });
  admin = demarrerAdmin({ api: api.url });
});

afterAll(async () => {
  await admin.stop(true);
  await api.stop(true);
});

test("console servie en HTML, proxy /v1 et /health vers l'API", async () => {
  const page = await fetch(new URL("/", admin.url));
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("Console opérateur");
  expect(await (await fetch(new URL("/v1/abonnement/plans", admin.url))).json()).toEqual({
    chemin: "/v1/abonnement/plans",
  });
  expect(await (await fetch(new URL("/health", admin.url))).json()).toEqual({ chemin: "/health" });
  expect((await fetch(new URL("/app", admin.url))).status).toBe(404);
});

test("points d'entrée manquants documentés dans docs/UI.md", async () => {
  const doc = await Bun.file(new URL("../../../docs/UI.md", import.meta.url)).text();
  for (const m of MANQUANTS) expect(doc).toContain(m.route);
});

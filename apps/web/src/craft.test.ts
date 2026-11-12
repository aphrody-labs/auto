import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ressourcesCraft } from "./craft";
let dossier: string, server: ReturnType<typeof Bun.serve>;
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  version = "123456789abcdef0";
beforeAll(async () => {
  dossier = await mkdtemp(join(tmpdir(), "auto-craft-web-"));
  await Bun.write(join(dossier, "craft/grid/module.wasm.gz"), Bun.gzipSync(bytes));
  await Bun.write(join(dossier, "craft/grid/index.html"), "<!doctype html><canvas></canvas>");
  await Bun.write(
    join(dossier, "craft/manifest.json"),
    JSON.stringify({
      schema: 1,
      version,
      editeurs: {
        grid: {
          fichiers: {
            "module.wasm": {
              sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
              taille: bytes.length,
              gzip: "module.wasm.gz",
            },
            "index.html": { sha256: "a".repeat(64), taille: 33 },
            "fuite.wasm": { sha256: "b".repeat(64), taille: 1, gzip: "../../secret" },
          },
        },
      },
    }),
  );
  server = Bun.serve({ port: 0, routes: ressourcesCraft(dossier), fetch: () => new Response("", { status: 404 }) });
});
afterAll(async () => {
  await server?.stop(true);
  const r = dossier && relative(resolve(tmpdir()), resolve(dossier));
  if (r && r.startsWith("auto-craft-web-") && !r.includes("..")) await rm(dossier, { recursive: true, force: true });
});
test("ressources Craft : version immuable, WASM compressé et repli non compressé", async () => {
  const r = await fetch(new URL(`/craft/grid/${version}/module.wasm`, server.url), {
    headers: { "accept-encoding": "gzip" },
  });
  expect(r.headers.get("content-type")).toBe("application/wasm");
  expect(r.headers.get("content-encoding")).toBe("gzip");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  const identite = await fetch(new URL(`/craft/grid/${version}/module.wasm`, server.url), {
    headers: { "accept-encoding": "identity" },
  });
  expect(identite.headers.get("content-encoding")).toBeNull();
  expect(new Uint8Array(await identite.arrayBuffer())).toEqual(bytes);
  const page = await fetch(new URL(`/craft/grid/${version}/index.html`, server.url));
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  expect(page.headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
  for (const chemin of [
    `/craft/grid/incorrect/module.wasm`,
    `/craft/grid/${version}/%2e%2e/secret`,
    `/craft/grid/${version}/fuite.wasm`,
    `/craft/grid/${version}/__proto__`,
    `/craft/grid/${version}/a%2fmodule.wasm`,
  ])
    expect((await fetch(new URL(chemin, server.url))).status).toBe(404);
});

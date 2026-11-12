import { afterAll, beforeAll, expect, test } from "bun:test";
import { ApiAuto, ServeurMcp } from "@auto/agent";
import { apiDeTest } from "@auto/agent/test-api";

let t: Awaited<ReturnType<typeof apiDeTest>>;
let A: { jeton: string };
let B: { jeton: string };
let docA: string;

beforeAll(async () => {
  t = await apiDeTest();
  A = await t.tenant("mcp-a@exemple.fr", "Alpha");
  B = await t.tenant("mcp-b@exemple.fr", "Beta");
  const d = await t.appel("/v1/documents", A.jeton, {
    type: "devis",
    date: "2026-10-22",
    client: { nom: "Client MCP", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Audit", quantite: 1, prixUnitaireHtCents: 50000, tva: 200 }],
  });
  docA = d.id;
});
afterAll(() => t.fermer());

/** Lance `auto mcp` dans un sous-processus avec le jeton donné et échange des lignes JSON-RPC. */
async function session(jeton: string, messages: unknown[]) {
  const p = Bun.spawn([process.execPath, Bun.fileURLToPath(new URL("./cli.ts", import.meta.url)), "mcp"], {
    env: { ...Bun.env, AUTO_API_URL: t.url, AUTO_TOKEN: jeton },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const m of messages) p.stdin.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  await p.stdin.end();
  const [sortie, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  const reponses = sortie
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return (id: unknown) => reponses.find((r) => r.id === id);
}

const rq = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

test("MCP stdio : initialize, tools/list, tools/call, erreurs JSON-RPC", async () => {
  const r = await session(A.jeton, [
    rq(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    rq(2, "tools/list"),
    rq(3, "tools/call", { name: "lister_documents", arguments: { type: "devis" } }),
    rq(4, "tools/call", { name: "lire_document", arguments: { id: docA } }),
    rq(5, "tools/call", { name: "nexiste_pas", arguments: {} }),
    rq(6, "inconnue"),
    "{pas du json",
    rq(7, "ping"),
  ]);
  expect(r(1).result).toMatchObject({
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "auto" },
  });
  const outils = r(2).result.tools as { name: string; inputSchema: { type: string } }[];
  expect(outils.map((o) => o.name)).toEqual(
    expect.arrayContaining([
      "lister_documents",
      "creer_devis",
      "creer_facture",
      "emettre_document",
      "enregistrer_paiement",
      "relancer",
      "chercher_client",
      "chercher_document",
      "lister_absences",
      "exporter",
    ]),
  );
  expect(outils.every((o) => o.inputSchema.type === "object")).toBe(true);
  expect(r(3).result.isError).toBe(false);
  expect(JSON.parse(r(3).result.content[0].text)).toEqual([
    expect.objectContaining({ id: docA, client: "Client MCP" }),
  ]);
  expect(r(4).result.structuredContent.id).toBe(docA);
  expect(r(5).error.code).toBe(-32602);
  expect(r(6).error.code).toBe(-32601);
  expect(r(null).error.code).toBe(-32700);
  expect(r(7).result).toEqual({});
});

test("MCP : le jeton du tenant B ne voit jamais les données du tenant A", async () => {
  const r = await session(B.jeton, [
    rq(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
    rq(2, "tools/call", { name: "lister_documents", arguments: {} }),
    rq(3, "tools/call", { name: "lire_document", arguments: { id: docA } }),
    rq(4, "tools/call", { name: "emettre_document", arguments: { id: docA } }),
    rq(5, "tools/call", { name: "chercher_document", arguments: { q: "MCP" } }),
  ]);
  expect(r(1).result.protocolVersion).toBe("2024-11-05");
  expect(JSON.parse(r(2).result.content[0].text)).toEqual([]);
  expect(r(3).result.isError).toBe(true);
  expect(JSON.parse(r(3).result.content[0].text).status).toBe(404);
  expect(r(4).result.isError).toBe(true);
  expect(JSON.parse(r(5).result.content[0].text)).toEqual([]);
  // Toujours brouillon chez A.
  expect((await t.appel(`/v1/documents/${docA}`, A.jeton)).statut).toBe("brouillon");
});

test("MCP en mémoire : version inconnue, notifications, lots, requête invalide", async () => {
  const s = new ServeurMcp(new ApiAuto(t.url, A.jeton));
  expect(
    (
      (await s.traiter(rq(1, "initialize", { protocolVersion: "1999-01-01" }))) as {
        result: { protocolVersion: string };
      }
    ).result.protocolVersion,
  ).toBe("2025-06-18");
  expect(await s.traiter({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();
  expect(await s.traiter([rq(1, "ping"), rq(2, "ping")])).toHaveLength(2);
  expect(await s.traiter({ id: 3, method: "ping" })).toMatchObject({ id: 3, error: { code: -32600 } });
  expect(await s.traiter(rq(4, "tools/call", { name: "lister_documents", arguments: [1] }))).toMatchObject({
    error: { code: -32602 },
  });
});

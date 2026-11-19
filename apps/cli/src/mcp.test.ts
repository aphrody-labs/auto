import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSelfHostedServer } from "@aphrody/auto-server";
import { runCli } from "./cli";

let rt: Awaited<ReturnType<typeof createSelfHostedServer>>;
let token: string;

beforeAll(async () => {
  rt = await createSelfHostedServer({ host: "127.0.0.1", port: 0, dbPath: ":memory:" });
  const signup = await fetch(`${rt.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cli@aphrody.com", password: "Password123456!", name: "CLI" }),
  });
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const compRes = await fetch(`${rt.url}/v1/companies`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "CLI Corp", taxId: "73282932000074", address: "Paris" }),
  });
  const comp = (await compRes.json()) as { id: string };
  const keyRes = await fetch(`${rt.url}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "cli-test" }),
  });
  if (keyRes.ok) {
    const k = (await keyRes.json()) as { key: string };
    token = k.key;
  } else {
    token = "";
  }
  process.env.AUTO_API_URL = rt.url;
  process.env.AUTO_COMPANY_ID = comp.id;
  process.env.AUTO_TOKEN = token;
});

afterAll(async () => {
  await rt.stop();
});

test("CLI local auth commands and help run cleanly", async () => {
  expect(await runCli(["--help"])).toBe(0);
  expect(await runCli(["health"])).toBe(0);
  expect(await runCli(["auth", "hash", "SecretPass123!"])).toBe(0);
});

test("MCP stdio bridge handles initialize, tools/list, and tools/call", async () => {
  if (!token) return;
  const proc = Bun.spawn([process.execPath, Bun.fileURLToPath(new URL("./cli.ts", import.meta.url)), "mcp"], {
    env: { ...Bun.env, AUTO_API_URL: rt.url, AUTO_TOKEN: token, AUTO_COMPANY_ID: process.env.AUTO_COMPANY_ID },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
  await proc.stdin.end();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  const replies = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
  expect(replies.find((r) => r.id === 1)?.result.protocolVersion).toBe("2025-06-18");
  expect(Array.isArray(replies.find((r) => r.id === 2)?.result.tools)).toBe(true);
  expect(replies.find((r) => r.id === 3)?.result).toEqual({});
});

// Declarative reproducible Cloudflare deploy script (zero literal IDs/secrets in tracked git files).
// Resolves or creates D1 `auto`, removes conflicting legacy tunnel CNAME for `auto.aphrody.com`,
// migrates D1 remotely, builds `apps/ui/dist/web`, uploads initial release manifest to R2,
// ensures Worker secrets, deploys Worker `auto`, and verifies live payloads (with auto rollback).
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const resolvedDir = join(repoRoot, ".wrangler");
const resolvedConfig = join(repoRoot, "wrangler.deploy.jsonc");

function run(cmd: string[], capture = false): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd: repoRoot,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: capture ? new TextDecoder().decode(proc.stdout) : "",
    stderr: capture ? new TextDecoder().decode(proc.stderr) : "",
  };
}

async function resolveOrCreateD1(name: string): Promise<string> {
  if (Bun.env.CLOUDFLARE_D1_AUTO_ID?.trim()) return Bun.env.CLOUDFLARE_D1_AUTO_ID.trim();

  const list = run(["bun", "x", "wrangler", "d1", "list", "--json"], true);
  if (list.code !== 0) {
    throw new Error(`wrangler d1 list failed: ${list.stderr || list.stdout}`);
  }
  const rows = JSON.parse(list.stdout.trim() || "[]") as { uuid?: string; name?: string }[];
  const existing = rows.find((r) => r.name === name && r.uuid);
  if (existing?.uuid) return existing.uuid;

  const created = run(["bun", "x", "wrangler", "d1", "create", name, "--location", "weur"], true);
  if (created.code !== 0) {
    throw new Error(`wrangler d1 create ${name} failed: ${created.stderr || created.stdout}`);
  }
  const again = run(["bun", "x", "wrangler", "d1", "list", "--json"], true);
  const rows2 = JSON.parse(again.stdout.trim() || "[]") as { uuid?: string; name?: string }[];
  const found = rows2.find((r) => r.name === name && r.uuid);
  if (!found?.uuid) throw new Error(`Could not resolve UUID for newly created D1 database '${name}'`);
  return found.uuid;
}

async function clearLegacyTunnelCname(originUrl: string): Promise<void> {
  const token = Bun.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) return;
  const hostname = new URL(originUrl).hostname;
  const parts = hostname.split(".");
  if (parts.length < 2) return;
  const zoneName = parts.slice(-2).join(".");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const zRes = (await fetch(`https://api.cloudflare.com/client/v4/zones?name=${zoneName}`, { headers }).then((r) =>
    r.json(),
  )) as { result?: { id: string }[] };
  const zoneId = zRes.result?.[0]?.id;
  if (!zoneId) return;

  const dns = (await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${hostname}`, {
    headers,
  }).then((r) => r.json())) as { result?: { id: string; type: string; content: string }[] };

  for (const rec of dns.result ?? []) {
    if (rec.type === "CNAME" && rec.content.endsWith(".cfargotunnel.com")) {
      console.log(`Removing legacy tunnel CNAME ${rec.id} for ${hostname} -> ${rec.content}`);
      await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${rec.id}`, {
        method: "DELETE",
        headers,
      });
    }
  }
}

async function ensureWorkerSecret(name: string, fallbackValue: () => string): Promise<void> {
  const explicit = Bun.env[name]?.trim();
  const list = run(["bun", "x", "wrangler", "secret", "list", "--config", resolvedConfig, "--format", "json"], true);
  let exists = false;
  if (list.code === 0) {
    try {
      const items = JSON.parse(list.stdout.trim() || "[]") as { name: string }[];
      exists = items.some((s) => s.name === name);
    } catch {}
  }
  if (!explicit && exists) return;
  const value = explicit || fallbackValue();
  const proc = Bun.spawn(["bun", "x", "wrangler", "secret", "put", name, "--config", resolvedConfig], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  proc.stdin.write(value);
  await proc.stdin.end();
  if ((await proc.exited) !== 0) throw new Error(`Failed setting secret ${name}`);
}

const origin = (Bun.env.AUTO_PUBLIC_URL ?? "https://auto.aphrody.com").replace(/\/+$/, "");
const d1Id = await resolveOrCreateD1("auto");
console.log("Resolved D1 'auto' database cleanly.");

const uiBuild = run(["bun", "run", "--cwd", "apps/ui", "build"]);
if (uiBuild.code !== 0) process.exit(uiBuild.code);

const rawWrangler = await Bun.file(join(repoRoot, "wrangler.jsonc")).text();
const resolvedObj = JSON.parse(rawWrangler.replace("${CLOUDFLARE_D1_AUTO_ID}", d1Id)) as Record<string, unknown>;
mkdirSync(resolvedDir, { recursive: true });
await Bun.write(resolvedConfig, JSON.stringify(resolvedObj, null, 2));

const migrate = run([
  "bun",
  "x",
  "wrangler",
  "d1",
  "execute",
  "auto",
  "--config",
  resolvedConfig,
  "--remote",
  "--file",
  "packages/store/migrations/001_global.sql",
]);
if (migrate.code !== 0) process.exit(migrate.code);

// Publish signed-ready release manifest index under R2 auto/releases/manifest.json
const manifestPath = join(resolvedDir, "release-manifest.json");
const manifest = {
  version: "2026.11.5",
  publishedAt: new Date().toISOString(),
  channels: ["stable", "canary"],
  artifacts: [
    {
      target: "windows-x86_64",
      bin: "auto.exe",
      server: "auto-server.exe",
      url: `${origin}/releases/auto-windows-x86_64.exe`,
    },
    { target: "linux-x86_64", bin: "auto", server: "auto-server", url: `${origin}/releases/auto-linux-x86_64` },
  ],
};
await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
run([
  "bun",
  "x",
  "wrangler",
  "r2",
  "object",
  "put",
  "aphrody-releases/auto/releases/manifest.json",
  "--file",
  manifestPath,
  "--content-type",
  "application/json",
  "--remote",
]);

await clearLegacyTunnelCname(origin);

const deploy = run(["bun", "x", "wrangler", "deploy", "--config", resolvedConfig]);
if (deploy.code !== 0) process.exit(deploy.code);

const randomB64Key = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
await ensureWorkerSecret("AUTO_MASTER_KEY", randomB64Key);
await ensureWorkerSecret("BETTER_AUTH_SECRET", randomB64Key);

if (process.platform === "win32") run(["ipconfig", "/flushdns"], true);

let verified = false;
let lastDiag = "";
for (let i = 0; i < 25; i++) {
  try {
    const [hRes, pRes, mRes] = await Promise.all([
      fetch(`${origin}/health`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${origin}/`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${origin}/releases/manifest.json`, { signal: AbortSignal.timeout(8000) }),
    ]);
    const health = (await hRes.json()) as { ok?: boolean; mode?: string };
    const html = await pRes.text();
    const man = (await mRes.json()) as { version?: string };
    lastDiag = `health=${hRes.status}:${JSON.stringify(health)} html=${pRes.status} manifest=${mRes.status}:${man.version}`;
    if (
      hRes.ok &&
      health.ok === true &&
      health.mode === "serverless" &&
      pRes.ok &&
      html.includes("Factur-X") &&
      mRes.ok &&
      man.version === "2026.11.5"
    ) {
      verified = true;
      break;
    }
  } catch (e) {
    lastDiag = e instanceof Error ? e.message : String(e);
  }
  await Bun.sleep(2000);
}

if (!verified) {
  console.error(`Live check failed at ${origin} (${lastDiag}); rolling back`);
  run([
    "bun",
    "x",
    "wrangler",
    "rollback",
    "--config",
    resolvedConfig,
    "--message",
    "Auto post-deploy healthcheck failed",
  ]);
  rmSync(resolvedConfig, { force: true });
  process.exit(1);
}

rmSync(resolvedConfig, { force: true });
console.log(`Cloudflare Worker 'auto' deployed & verified live at ${origin}`);

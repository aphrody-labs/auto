// Reproducible self-hosted fleet deployer for VPS nodes (`fr2`, `prd`) + Linux binary build + live L7 LB.
// Zero hardcoded IPs or secrets in tracked source: resolves SSH aliases via CLI/env and probes WireGuard mesh at runtime.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const hosts = (Bun.argv.slice(2).find((a) => !a.startsWith("-")) ?? Bun.env.AUTO_FLEET_HOSTS ?? "fr2,prd")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const buildHost = Bun.env.AUTO_BUILD_HOST ?? hosts[0] ?? "fr2";
const remoteDir = Bun.env.AUTO_REMOTE_DIR ?? "/srv/auto";
const port = Number(Bun.env.AUTO_PORT ?? 3410);
const lbPort = Number(Bun.env.AUTO_LB_PORT ?? 3420);
const cloudUpstream = (Bun.env.AUTO_PUBLIC_URL ?? "https://auto.aphrody.com").replace(/\/+$/, "");

async function sshBash(host: string, script: string, capture = false): Promise<{ code: number; stdout: string }> {
  const clean = script.replaceAll("\r\n", "\n");
  const proc = Bun.spawn(["ssh", host, "bash"], {
    cwd: repoRoot,
    stdin: new TextEncoder().encode(clean),
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const out = capture ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  return { code, stdout: out };
}

async function uploadFile(host: string, localPath: string, remotePath: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "ssh",
      host,
      `cat > '${remotePath}.tmp' && chmod +x '${remotePath}.tmp' && mv -f '${remotePath}.tmp' '${remotePath}'`,
    ],
    {
      cwd: repoRoot,
      stdin: Bun.file(localPath),
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await proc.exited) !== 0) throw new Error(`uploadFile failed to ${host}:${remotePath}`);
}

async function downloadFile(host: string, remotePath: string, localPath: string): Promise<void> {
  const proc = Bun.spawn(["ssh", host, `cat '${remotePath}'`], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  const bytes = await new Response(proc.stdout).bytes();
  if ((await proc.exited) !== 0) throw new Error(`downloadFile failed from ${host}:${remotePath}`);
  await Bun.write(localPath, bytes);
}

async function uploadDir(host: string, localDir: string, remoteDirPath: string): Promise<void> {
  const tarProc = Bun.spawn(["tar", "-cf", "-", "-C", localDir, "."], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  const sshProc = Bun.spawn(["ssh", host, `mkdir -p '${remoteDirPath}' && tar -xf - -C '${remoteDirPath}'`], {
    cwd: repoRoot,
    stdin: tarProc.stdout,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await tarProc.exited) !== 0 || (await sshProc.exited) !== 0) {
    throw new Error(`uploadDir failed to ${host}:${remoteDirPath}`);
  }
}

const masterKey = (() => {
  if (Bun.env.AUTO_MASTER_KEY?.trim()) return Bun.env.AUTO_MASTER_KEY.trim();
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
})();

console.log(`Packing server sources and compiling Linux executable on '${buildHost}'...`);
const prepRes = await sshBash(
  buildHost,
  `set -euo pipefail
sudo mkdir -p /srv/auto-src ${remoteDir}/data ${remoteDir}/web
sudo chown -R "$(id -un)":"$(id -gn)" /srv/auto-src ${remoteDir}
`,
);
if (prepRes.code !== 0) process.exit(prepRes.code);

const tarProc = Bun.spawn(
  [
    "tar",
    "-cf",
    "-",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "auto.toml",
    "locales",
    "packages",
    "apps/server",
    "apps/cli",
    "apps/ui/dist/web",
    "apps/extension/package.json",
  ],
  { cwd: repoRoot, stdout: "pipe", stderr: "inherit" },
);
const sshTar = Bun.spawn(["ssh", buildHost, "tar", "-xf", "-", "-C", "/srv/auto-src"], {
  cwd: repoRoot,
  stdin: tarProc.stdout,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tarProc.exited) !== 0 || (await sshTar.exited) !== 0) process.exit(1);

const compileRes = await sshBash(
  buildHost,
  `set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
cd /srv/auto-src
bun install --ignore-scripts
bun build --compile --bytecode --minify \\
  --asset packages/native/wasm/auto_ffi_bg.wasm \\
  --asset packages/store/migrations/001_global.sql \\
  --asset packages/store/migrations/002_company.sql \\
  apps/server/src/bin.ts --outfile ${remoteDir}/auto-server.tmp
chmod +x ${remoteDir}/auto-server.tmp
mv -f ${remoteDir}/auto-server.tmp ${remoteDir}/auto-server
`,
);
if (compileRes.code !== 0) process.exit(compileRes.code);

mkdirSync(resolve(repoRoot, "dist/aot"), { recursive: true });
const localLinuxBin = resolve(repoRoot, "dist/aot/auto-server-linux-x64");
await downloadFile(buildHost, `${remoteDir}/auto-server`, localLinuxBin);

const peerMeshes: string[] = [];

for (const host of hosts) {
  console.log(`Installing & starting auto-server replica on '${host}'...`);
  const hostPrep = await sshBash(
    host,
    `set -euo pipefail
sudo mkdir -p ${remoteDir}/data ${remoteDir}/apps/ui/dist
rm -rf ${remoteDir}/apps/ui/dist/web
sudo chown -R "$(id -un)":"$(id -gn)" ${remoteDir}
`,
  );
  if (hostPrep.code !== 0) process.exit(hostPrep.code);

  if (host !== buildHost) {
    await uploadFile(host, localLinuxBin, `${remoteDir}/auto-server`);
  }
  await uploadDir(host, resolve(repoRoot, "apps/ui/dist/web"), `${remoteDir}/apps/ui/dist/web`);

  const unitRes = await sshBash(
    host,
    `set -euo pipefail
chmod +x ${remoteDir}/auto-server
cat <<'EOF' | sudo tee /etc/systemd/system/auto-server.service >/dev/null
[Unit]
Description=Aphrody Auto Self-Hosted Replica
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${remoteDir}
Environment=NODE_ENV=production
Environment=AUTO_MODE=self-hosted
Environment=AUTO_MASTER_KEY=${masterKey}
ExecStart=${remoteDir}/auto-server --host 0.0.0.0 --port ${port} --db ${remoteDir}/data/auto.sqlite
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now auto-server.service
sudo systemctl restart auto-server.service
sleep 1
systemctl is-active auto-server.service
curl -fsS http://127.0.0.1:${port}/health
wg_ip=$(ip -4 -o addr show | awk '/10\\.200\\.77\\./{print $4}' | cut -d/ -f1 | head -n1 || true)
echo "MESH_IP=\${wg_ip}"
`,
    true,
  );
  if (unitRes.code !== 0) {
    console.error(`Replica failed on ${host}`);
    process.exit(1);
  }
  console.log(unitRes.stdout.trim());
  const match = unitRes.stdout.match(/MESH_IP=([\d.]+)/);
  if (match?.[1]) peerMeshes.push(`http://${match[1]}:${port}`);
}

const upstreamList = [...new Set([...peerMeshes, cloudUpstream])].join(",");
console.log(`Configuring real-time L7 cluster proxy on '${buildHost}' -> upstreams: ${upstreamList}`);

const proxyRes = await sshBash(
  buildHost,
  `set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
BUN_BIN="$(command -v bun)"
cat <<'SCRIPT' > ${remoteDir}/lb.ts
const upstreams = (process.env.AUTO_UPSTREAMS ?? "").split(",").filter(Boolean);
let cursor = 0;
const healthy = new Set(upstreams);
async function probeAll() {
  await Promise.all(upstreams.map(async (u) => {
    try {
      const r = await fetch(u + "/health", { signal: AbortSignal.timeout(2000) });
      if (r.ok) healthy.add(u); else healthy.delete(u);
    } catch { healthy.delete(u); }
  }));
}
setInterval(() => { void probeAll(); }, 5000);
await probeAll();
Bun.serve({
  hostname: "127.0.0.1",
  port: ${lbPort},
  async fetch(req) {
    const u = new URL(req.url);
    const pool = healthy.size ? [...healthy] : upstreams;
    const start = cursor++ % pool.length;
    for (let k = 0; k < pool.length; k++) {
      const target = pool[(start + k) % pool.length]!;
      try {
        const fwdHeaders = new Headers(req.headers);
        fwdHeaders.delete("host");
        const res = await fetch(target + u.pathname + u.search, {
          method: req.method,
          headers: fwdHeaders,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.status < 502) {
          const outHeaders = new Headers(res.headers);
          outHeaders.set("x-auto-upstream", target);
          return new Response(res.body, { status: res.status, headers: outHeaders });
        }
      } catch { healthy.delete(target); }
    }
    return Response.json({ ok: false, error: "All cluster upstreams unavailable" }, { status: 503 });
  },
});
SCRIPT
cat <<EOF | sudo tee /etc/systemd/system/auto-lb.service >/dev/null
[Unit]
Description=Aphrody Auto Real-Time Cluster Load Balancer
After=network-online.target auto-server.service

[Service]
Type=simple
WorkingDirectory=${remoteDir}
Environment=AUTO_UPSTREAMS=${upstreamList}
ExecStart=\${BUN_BIN} run ${remoteDir}/lb.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now auto-lb.service
sudo systemctl restart auto-lb.service
sleep 1
systemctl is-active auto-lb.service
for n in 1 2 3; do curl -fsSi http://127.0.0.1:${lbPort}/health | grep -i -E "x-auto-upstream|auth"; done
`,
);
if (proxyRes.code !== 0) process.exit(proxyRes.code);

console.log(`Fleet deployment & live load balancer verified across [${hosts.join(", ")}].`);

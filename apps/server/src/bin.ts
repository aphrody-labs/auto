#!/usr/bin/env bun
import { createSelfHostedServer } from "./self-hosted";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`auto-server — Unified Self-Hosted Auto API + Rust Auth + MCP + WS HLC Sync Server

Usage:
  auto-server [--host 0.0.0.0] [--port 3000] [--db data/auto.sqlite] [--data data]`);
  process.exit(0);
}

const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

async function main() {
  const runtime = await createSelfHostedServer({
    host: arg("--host"),
    port: arg("--port") ? Number(arg("--port")) : undefined,
    dbPath: arg("--db") ?? (process.env.AUTO_DB_PATH || "data/auto.sqlite"),
    dataDir: arg("--data"),
  });

  console.log(`Auto self-hosted server listening on ${runtime.url}`);

  const shutdown = async () => {
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

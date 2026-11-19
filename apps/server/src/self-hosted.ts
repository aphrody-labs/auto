// Self-hosted Bun HTTP + WebSocket HLC peer sync + filesystem blobs + optional remote sync worker.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { initNative } from "@aphrody/auto-native";
import { dirBlobs } from "@aphrody/auto-platform/bun";
import { openAiClient, llmConfigFromEnv } from "@aphrody/auto-platform/llm";
import { dispatchOutboxBatch, webhookFromEnv } from "@aphrody/auto-services";
import {
  applyRemoteChanges,
  connect,
  migrate,
  pullChanges,
  withCompany,
  type Sql,
  type SyncChange,
} from "@aphrody/auto-store";
import { createAutoApp } from "./router";

export interface SelfHostedOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  dataDir?: string;
  webDistDir?: string;
  env?: Record<string, string | undefined>;
  syncUpstreamUrl?: string;
  syncToken?: string;
}

export async function createSelfHostedServer(opts: SelfHostedOptions = {}) {
  const env = opts.env ?? process.env;
  const embWasm =
    typeof Bun !== "undefined" && Array.isArray(Bun.embeddedFiles)
      ? Bun.embeddedFiles.find((f) => f.name.endsWith("auto_ffi_bg.wasm"))
      : undefined;
  if (embWasm) {
    initNative(new Uint8Array(await embWasm.arrayBuffer()));
  } else {
    const wasmFile = new URL("../../../packages/native/wasm/auto_ffi_bg.wasm", import.meta.url);
    if (await Bun.file(wasmFile).exists()) {
      initNative(await Bun.file(wasmFile).bytes());
    }
  }

  const dataDir = opts.dataDir ?? env.AUTO_DATA_DIR ?? "data";
  const dbPath = opts.dbPath ?? env.AUTO_DB_PATH ?? ":memory:";
  if (dbPath !== ":memory:") mkdirSync(resolve(dataDir, "blobs"), { recursive: true });

  const blobs = dirBlobs(resolve(dataDir, "blobs"));
  const sql: Sql = connect(dbPath);
  await migrate(sql);

  const peersByCompany = new Map<string, Set<{ send: (msg: string) => void }>>();
  const llmCfg = llmConfigFromEnv(env);
  const llm = llmCfg ? openAiClient(llmCfg) : null;
  const host = opts.host ?? env.AUTO_HOST ?? "0.0.0.0";
  const port = opts.port ?? Number(env.AUTO_PORT ?? 3000);
  const webDist = opts.webDistDir ? resolve(opts.webDistDir) : resolve("apps/ui/dist/web");

  const app = createAutoApp({
    sql,
    blobs,
    mode: "self-hosted",
    llm,
    env,
    async onSyncPush(companyId, ops) {
      const res = await withCompany(sql, companyId, (tx) => applyRemoteChanges(tx, "edge", ops));
      const peers = peersByCompany.get(companyId);
      if (peers?.size && ops.length) {
        const msg = JSON.stringify({ type: "ops", ops });
        for (const ws of peers) {
          try {
            ws.send(msg);
          } catch {}
        }
      }
      return res;
    },
  });

  const server = Bun.serve<{ companyId: string }>({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/sync" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const companyId = url.searchParams.get("companyId") ?? req.headers.get("x-company-id") ?? "default";
        if (srv.upgrade(req, { data: { companyId } })) return;
      }
      if (
        !url.pathname.startsWith("/v1/") &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/.well-known/") &&
        !url.pathname.startsWith("/releases/") &&
        url.pathname !== "/health" &&
        url.pathname !== "/mcp"
      ) {
        const clean = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const candidate = Bun.file(resolve(webDist, clean));
        if (await candidate.exists()) return new Response(candidate);
        const indexFallback = Bun.file(resolve(webDist, "index.html"));
        if (await indexFallback.exists())
          return new Response(indexFallback, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const set = peersByCompany.get(ws.data.companyId) ?? new Set();
        set.add(ws);
        peersByCompany.set(ws.data.companyId, set);
      },
      async message(ws, raw) {
        try {
          const msg = JSON.parse(String(raw)) as { type: string; sinceSeq?: number; ops?: SyncChange[] };
          const cid = ws.data.companyId;
          if (msg.type === "hello") {
            const pulled = await withCompany(sql, cid, (tx) => pullChanges(tx, msg.sinceSeq ?? 0, 500));
            ws.send(JSON.stringify({ type: "ops", nextSeq: pulled.nextSeq, ops: pulled.changes }));
          } else if (msg.type === "ops" && msg.ops?.length) {
            const res = await withCompany(sql, cid, (tx) => applyRemoteChanges(tx, "edge", msg.ops!));
            ws.send(JSON.stringify({ type: "ack", applied: res.applied, latestHlc: msg.ops.at(-1)?.hlc ?? "" }));
            const peers = peersByCompany.get(cid);
            if (peers) {
              const broadcast = JSON.stringify({ type: "ops", ops: msg.ops });
              for (const p of peers) if (p !== ws) p.send(broadcast);
            }
          }
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid WS sync frame" }));
        }
      },
      close(ws) {
        peersByCompany.get(ws.data.companyId)?.delete(ws);
      },
    },
  });

  const envHook = webhookFromEnv(env);
  const timer = setInterval(async () => {
    try {
      const companies = await sql<{ id: string }[]>`SELECT id FROM company WHERE deleted_at IS NULL LIMIT 50`;
      for (const c of companies) {
        await withCompany(sql, c.id, (tx) => dispatchOutboxBatch(tx, envHook ? [envHook] : []));
      }
    } catch {}
  }, 15_000);

  return {
    server,
    url: server.url.origin,
    sql,
    app,
    async stop() {
      clearInterval(timer);
      await server.stop(true);
      await sql.close();
    },
  };
}

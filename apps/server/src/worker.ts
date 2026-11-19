// Cloudflare Worker entrypoint (`auto`): D1 global auth/tenants, `CompanyDO` per-company SQLite Durable Object
// with hibernatable WebSockets + `alarm()`, `AutomationWorkflow`, R2 `auto/` prefix storage, and static Assets.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { initNative } from "@aphrody/auto-native";
import nativeWasm from "../../../packages/native/wasm/auto_ffi_bg.wasm";
import {
  d1Sql,
  doSql,
  r2Blobs,
  type CfD1Database,
  type CfDurableObjectStorage,
  type CfR2Bucket,
} from "@aphrody/auto-platform/cloudflare";
import { compileSql, prefixBlobs, splitSqlStatements, type Row, type Sql, type Tx } from "@aphrody/auto-platform";
import { executeWorkflow, validateWorkflow } from "@aphrody/auto-services";
import {
  applyRemoteChanges,
  migrateCompany,
  migrateGlobal,
  pullChanges,
  registerBlobs,
  registerCompanyResolver,
  registerMigration,
  recordAutomationRun,
  withCompany,
  type SyncChange,
} from "@aphrody/auto-store";
import globalSql from "../../../packages/store/migrations/001_global.sql";
import companySql from "../../../packages/store/migrations/002_company.sql";
import { createAutoApp } from "./router";

registerMigration("001_global.sql", globalSql);
registerMigration("002_company.sql", companySql);

export interface CfDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

export interface CfDurableObjectState {
  id: { toString(): string };
  storage: CfDurableObjectStorage & { setAlarm(time: number | Date): Promise<void> };
  blockConcurrencyWhile(fn: () => Promise<void>): void;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

export interface CfWorkerEnv {
  DB: CfD1Database;
  COMPANY_DO: CfDurableObjectNamespace;
  FILES: CfR2Bucket;
  RELEASES?: CfR2Bucket;
  ASSETS?: { fetch(req: Request): Promise<Response> };
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  AUTOMATION_WORKFLOW?: { create(opts: { id?: string; params: unknown }): Promise<{ id: string }> };
  AUTO_MASTER_KEY?: string;
  BETTER_AUTH_SECRET?: string;
  AUTO_URL_APP?: string;
  AUTO_MODE?: string;
}

let initializedWasm = false;
function ensureWasmOnce() {
  if (!initializedWasm) {
    initNative(nativeWasm as unknown as WebAssembly.Module);
    initializedWasm = true;
  }
}

export class CompanyDO {
  private readonly sql;
  private ready = false;

  constructor(
    private readonly state: CfDurableObjectState,
    private readonly env: CfWorkerEnv,
  ) {
    ensureWasmOnce();
    this.sql = doSql(state.storage);
    state.blockConcurrencyWhile(async () => {
      await migrateCompany(this.sql);
      this.ready = true;
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (!this.ready) await migrateCompany(this.sql);
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId") ?? req.headers.get("x-company-id") ?? this.state.id.toString();

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new (
        globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }
      ).WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server, [companyId]);
      await this.state.storage.setAlarm(Date.now() + 60_000);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    }

    if (url.pathname === "/_do/pull" && req.method === "POST") {
      const b = (await req.json()) as { sinceSeq?: number; limit?: number };
      const res = await withCompany(this.sql, companyId, (tx) => pullChanges(tx, b.sinceSeq ?? 0, b.limit ?? 500));
      return Response.json(res);
    }

    if (url.pathname === "/_do/push" && req.method === "POST") {
      const b = (await req.json()) as { ops?: SyncChange[] };
      const ops = b.ops ?? [];
      const res = await withCompany(this.sql, companyId, (tx) => applyRemoteChanges(tx, "cloud", ops));
      const msg = JSON.stringify({ type: "ops", ops });
      for (const peer of this.state.getWebSockets(companyId)) {
        try {
          peer.send(msg);
        } catch {}
      }
      return Response.json(res);
    }

    if (url.pathname === "/_do/sql" && req.method === "POST") {
      const b = (await req.json()) as { query?: string; params?: unknown[]; script?: string };
      if (b.script) {
        await this.sql.execScript?.(b.script);
        return Response.json({ rows: [] });
      }
      const rows = await this.sql.exec(b.query ?? "SELECT 1", b.params ?? []);
      return Response.json({ rows });
    }

    return Response.json({ ok: true, durableObject: "CompanyDO", companyId });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const msg = JSON.parse(text) as { type: string; sinceSeq?: number; ops?: SyncChange[]; companyId?: string };
      const companyId = msg.companyId ?? "default";
      if (msg.type === "hello") {
        const pulled = await withCompany(this.sql, companyId, (tx) => pullChanges(tx, msg.sinceSeq ?? 0, 500));
        ws.send(JSON.stringify({ type: "ops", nextSeq: pulled.nextSeq, ops: pulled.changes }));
      } else if (msg.type === "ops" && msg.ops?.length) {
        const res = await withCompany(this.sql, companyId, (tx) => applyRemoteChanges(tx, "cloud", msg.ops!));
        const latestHlc = msg.ops.at(-1)?.hlc ?? "";
        ws.send(JSON.stringify({ type: "ack", applied: res.applied, latestHlc }));
        const broadcast = JSON.stringify({ type: "ops", ops: msg.ops });
        for (const peer of this.state.getWebSockets(companyId)) {
          if (peer !== ws) {
            try {
              peer.send(broadcast);
            } catch {}
          }
        }
      }
    } catch {
      try {
        ws.send(JSON.stringify({ type: "error", message: "Invalid sync message" }));
      } catch {}
    }
  }

  async alarm(): Promise<void> {
    // Periodic maintenance hook inside per-company Durable Object
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0) {
      await this.state.storage.setAlarm(Date.now() + 300_000);
    }
  }
}

export class AutomationWorkflow extends WorkflowEntrypoint<
  CfWorkerEnv,
  { definition: unknown; input?: unknown; automationId?: string; companyId?: string }
> {
  async run(
    event: { payload: { definition: unknown; input?: unknown; automationId?: string; companyId?: string } },
    step: { do: <T>(name: string, fn: () => Promise<T>) => Promise<T> },
  ) {
    ensureWasmOnce();
    const def = validateWorkflow(event.payload.definition);
    return step.do("execute-dag", async () => {
      const res = await executeWorkflow(def, event.payload.input ?? {});
      return res;
    });
  }
}

function remoteCompanySql(ns: CfDurableObjectNamespace, companyId: string): Sql {
  const stub = ns.get(ns.idFromName(companyId));
  const exec = async <T = Row[]>(query: string, params: readonly unknown[] = []): Promise<T> => {
    const res = await stub.fetch(`https://do.internal/_do/sql?companyId=${encodeURIComponent(companyId)}`, {
      method: "POST",
      body: JSON.stringify({ query, params }),
    });
    if (!res.ok) throw new Error(`CompanyDO query failed: HTTP ${res.status}`);
    const data = (await res.json()) as { rows: T };
    return data.rows;
  };
  const execScript = async (script: string): Promise<void> => {
    for (const stmt of splitSqlStatements(script)) {
      await exec(stmt, []);
    }
  };
  const tx = Object.assign(
    <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const { sql, params } = compileSql(strings, ...values);
      return exec<T>(sql, params);
    },
    { exec, execScript },
  ) as Tx;

  return Object.assign(
    <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => tx<T>(strings, ...values),
    {
      dialect: "sqlite" as const,
      exec,
      execScript,
      async begin<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
        return fn(tx);
      },
      async close() {},
    },
  );
}

export default {
  async fetch(req: Request, env: CfWorkerEnv): Promise<Response> {
    ensureWasmOnce();
    const url = new URL(req.url);
    const sql = d1Sql(env.DB);
    await migrateGlobal(sql).catch(() => undefined);

    if (url.pathname === "/v1/sync" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const companyId = url.searchParams.get("companyId") ?? req.headers.get("x-company-id") ?? "default";
      const id = env.COMPANY_DO.idFromName(companyId);
      return env.COMPANY_DO.get(id).fetch(req);
    }

    const blobs = prefixBlobs(r2Blobs(env.FILES), "auto/assets/");
    registerBlobs(sql, blobs);
    registerCompanyResolver(sql, async (companyId) => remoteCompanySql(env.COMPANY_DO, companyId));
    const releasesBucket = env.RELEASES ?? env.FILES;
    const app = createAutoApp({
      sql,
      blobs,
      mode: "serverless",
      env: { ...env, NODE_ENV: "production" } as unknown as Record<string, string | undefined>,
      async onSyncPull(companyId, sinceSeq, limit) {
        const stub = env.COMPANY_DO.get(env.COMPANY_DO.idFromName(companyId));
        const res = await stub.fetch(`https://do.internal/_do/pull?companyId=${encodeURIComponent(companyId)}`, {
          method: "POST",
          body: JSON.stringify({ sinceSeq, limit }),
        });
        return (await res.json()) as { changes: SyncChange[]; nextSeq: number };
      },
      async onSyncPush(companyId, ops) {
        const stub = env.COMPANY_DO.get(env.COMPANY_DO.idFromName(companyId));
        const res = await stub.fetch(`https://do.internal/_do/push?companyId=${encodeURIComponent(companyId)}`, {
          method: "POST",
          body: JSON.stringify({ ops }),
        });
        return (await res.json()) as { applied: number; skipped: number };
      },
      async onReleaseAsset(name) {
        const obj = await releasesBucket.get(`auto/releases/${name}`);
        if (!obj) return null;
        const body = await obj.arrayBuffer();
        const isJson = name.endsWith(".json");
        return new Response(body, {
          headers: {
            "content-type": isJson ? "application/json; charset=utf-8" : "application/octet-stream",
            "cache-control": isJson ? "public, max-age=60" : "public, max-age=31536000, immutable",
          },
        });
      },
    });

    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/.well-known/") ||
      url.pathname.startsWith("/releases/") ||
      url.pathname === "/health" ||
      url.pathname === "/mcp"
    ) {
      return app.fetch(req);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }
    return app.fetch(req);
  },

  async scheduled(_controller: { cron: string }, env: CfWorkerEnv): Promise<void> {
    ensureWasmOnce();
    void recordAutomationRun;
    const sql = d1Sql(env.DB);
    await migrateGlobal(sql);
  },
};

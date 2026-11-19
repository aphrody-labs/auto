// Cloudflare Workers adapters (D1, Durable Object SQLite, R2, Workers AI, Browser Rendering, cloudflare:sockets).
import type { LlmClient, LlmRequest, LlmResponse } from "./llm";
import {
  compileSql,
  prefixBlobs,
  splitSqlStatements,
  type AI,
  type Blobs,
  type Browser,
  type Native,
  type Platform,
  type Row,
  type Scheduler,
  type Sql,
  type TcpConnection,
  type TcpConnectOptions,
  type TcpTransport,
  type Tx,
} from "./index";

export interface CfD1PreparedStatement {
  bind(...values: unknown[]): CfD1PreparedStatement;
  all<T = Row>(): Promise<{ success: boolean; error?: string; results?: T[] }>;
}

export interface CfD1Database {
  prepare(query: string): CfD1PreparedStatement;
  batch<T = unknown>(statements: CfD1PreparedStatement[]): Promise<T[]>;
}

export interface CfSqlCursor<T = Row> {
  toArray(): T[];
}

export interface CfDurableObjectStorage {
  sql: { exec<T = Row>(query: string, ...bindings: unknown[]): CfSqlCursor<T> };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
  transactionSync<T>(closure: () => T): T;
}

export interface CfR2Object {
  key: string;
  size: number;
  etag?: string;
  httpEtag?: string;
  uploaded?: Date;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface CfR2Bucket {
  get(key: string): Promise<CfR2Object | null>;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    opts?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ size?: number; httpEtag?: string } | null>;
  head(key: string): Promise<CfR2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: CfR2Object[]; truncated: boolean; cursor?: string }>;
}

export interface CfAi {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface CfFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** D1 adapter (`env.DB`) for the global database (Better Auth, companies, memberships, super-admin). */
export function d1Sql(db: CfD1Database): Sql {
  const makeTx = (): Tx => {
    const fn = (async <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const { sql, params } = compileSql(strings, ...values);
      return fn.exec<T>(sql, params);
    }) as Tx;
    fn.exec = async <T = Row[]>(query: string, params: readonly unknown[] = []): Promise<T> => {
      const res = await db
        .prepare(query)
        .bind(...params)
        .all<Row>();
      if (!res.success) throw new Error(res.error ?? "D1 query failed");
      return (res.results ?? []) as unknown as T;
    };
    fn.execScript = async (script: string): Promise<void> => {
      const stmts = splitSqlStatements(script);
      if (!stmts.length) return;
      await db.batch(stmts.map((s) => db.prepare(s)));
    };
    return fn;
  };
  const tx = makeTx();
  return Object.assign(
    (<T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]) => tx<T>(strings, ...values)) as Sql,
    {
      dialect: "sqlite" as const,
      exec: tx.exec,
      execScript: tx.execScript,
      async begin<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
        return fn(tx);
      },
      async close() {},
    },
  );
}

/**
 * Durable Object SQLite adapter (`ctx.storage`).
 * Serialized per DO instance with atomic execution via `transaction` / `transactionSync`.
 */
export function doSql(storage: CfDurableObjectStorage): Sql & { beginSync<T>(fn: (tx: Tx) => T): T } {
  let queue = Promise.resolve();
  const execSql = <T = Row[]>(query: string, params: readonly unknown[] = []): T => {
    return storage.sql.exec<Row>(query, ...params).toArray() as unknown as T;
  };

  const makeTx = (): Tx => {
    const fn = (<T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const { sql, params } = compileSql(strings, ...values);
      try {
        return Promise.resolve(execSql<T>(sql, params));
      } catch (err) {
        return Promise.reject(err);
      }
    }) as Tx;
    fn.exec = <T = Row[]>(query: string, params: readonly unknown[] = []) => {
      try {
        return Promise.resolve(execSql<T>(query, params));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    fn.execScript = (script: string) => {
      try {
        storage.transactionSync(() => {
          for (const stmt of splitSqlStatements(script)) storage.sql.exec(stmt);
        });
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return fn;
  };

  const tx = makeTx();
  return Object.assign(
    (<T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]) => tx<T>(strings, ...values)) as Sql,
    {
      dialect: "sqlite" as const,
      exec: tx.exec,
      execScript: tx.execScript,
      begin<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
        const task = queue.then(() => storage.transaction(async () => fn(tx)));
        queue = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      },
      beginSync<T>(fn: (t: Tx) => T): T {
        return storage.transactionSync(() => fn(tx));
      },
      async close() {},
    },
  );
}

/** R2 adapter prefixed under `auto/` by default on shared Cloudflare buckets. */
export function r2Blobs(bucket: CfR2Bucket, prefix = "auto/"): Blobs {
  const raw: Blobs = {
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        key: obj.key,
        size: obj.size,
        etag: obj.httpEtag ?? obj.etag,
        contentType: obj.httpMetadata?.contentType,
        customMetadata: obj.customMetadata,
        bytes: async () => new Uint8Array(await obj.arrayBuffer()),
        text: () => obj.text(),
      };
    },
    async put(key, body, opts) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const obj = await bucket.put(key, bytes, {
        httpMetadata: {
          contentType: opts?.contentType,
          cacheControl: opts?.cacheControl,
        },
        customMetadata: opts?.customMetadata,
      });
      return { size: obj?.size ?? bytes.byteLength, etag: obj?.httpEtag };
    },
    async head(key) {
      const obj = await bucket.head(key);
      if (!obj) return null;
      return {
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded?.toISOString(),
        customMetadata: obj.customMetadata,
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(opts) {
      const res = await bucket.list({ prefix: opts?.prefix, limit: opts?.limit, cursor: opts?.cursor });
      return {
        objects: res.objects.map((o) => ({
          key: o.key,
          size: o.size,
          etag: o.httpEtag ?? o.etag,
          uploaded: o.uploaded?.toISOString(),
        })),
        truncated: res.truncated,
        cursor: res.truncated ? res.cursor : undefined,
      };
    },
  };
  return prefix ? prefixBlobs(raw, prefix) : raw;
}

/** Workers AI adapter for structured LLM calls, tool calling, and BGE-M3 embeddings. */
export function workersAi(ai: CfAi, model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"): AI {
  const llm: LlmClient = {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const input: Record<string, unknown> = {
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.schema ? { response_format: { type: "json_schema", json_schema: request.schema.schema } } : {}),
      };
      const out = (await ai.run(model, input)) as {
        response?: string;
        tool_calls?: {
          id?: string;
          name?: string;
          arguments?: unknown;
          function?: { name: string; arguments: string };
        }[];
      };
      const calls = out.tool_calls?.map((tc, idx) => ({
        id: tc.id ?? `cf_${idx}`,
        type: "function" as const,
        function: tc.function ?? {
          name: tc.name ?? "",
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      }));
      return {
        content: out.response ?? null,
        ...(calls?.length ? { tool_calls: calls } : {}),
      };
    },
  };

  return {
    llm,
    async embedding(text: string): Promise<number[]> {
      const out = (await ai.run("@cf/baai/bge-m3", { text: [text] })) as { data?: number[][] };
      return out.data?.[0] ?? [];
    },
  };
}

/** TCP/TLS transport via `cloudflare:sockets` (`connect` + `startTls()`). */
export function cloudflareTcpTransport(
  connectFn: (addr: { hostname: string; port: number }, opts?: unknown) => unknown,
): TcpTransport {
  const wrap = (raw: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    closed: Promise<void>;
    startTls(): unknown;
    close(): Promise<void>;
  }): TcpConnection => ({
    readable: raw.readable,
    writable: raw.writable,
    closed: raw.closed,
    startTls: () => wrap(raw.startTls() as typeof raw),
    close: () => raw.close(),
  });
  return {
    async connect(opts: TcpConnectOptions): Promise<TcpConnection> {
      const sock = connectFn(
        { hostname: opts.host, port: opts.port },
        { secureTransport: opts.security === "tls" ? "on" : opts.security === "starttls" ? "starttls" : "off" },
      ) as Parameters<typeof wrap>[0];
      return wrap(sock);
    },
  };
}

/** Cloudflare Browser Rendering adapter via service binding Fetcher (`/snapshot`). */
export function cloudflareBrowser(browser: CfFetcher): Browser {
  return {
    async snapshot(url, opts) {
      const res = await browser.fetch("https://browser.internal/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          viewport: { width: opts.width, height: opts.height },
          screenshotOptions: { type: "png" },
        }),
      });
      if (!res.ok) throw new Error(`Browser Rendering HTTP ${res.status}`);
      const json = (await res.json()) as { screenshot?: string; title?: string; content?: string };
      const bytes = json.screenshot ? Uint8Array.from(atob(json.screenshot), (c) => c.charCodeAt(0)) : new Uint8Array();
      return { image: bytes, title: json.title, text: json.content };
    },
  };
}

export function cloudflarePlatform(opts: {
  db: CfD1Database;
  files: CfR2Bucket;
  archives: CfR2Bucket;
  releases?: CfR2Bucket;
  ai?: CfAi;
  browser?: CfFetcher;
  tcpConnect?: (addr: { hostname: string; port: number }, opts?: unknown) => unknown;
  native?: Native;
  scheduler?: Scheduler;
  env: Record<string, string | undefined>;
}): Platform {
  return {
    engine: "cloudflare",
    mode: "serverless",
    globalDb: d1Sql(opts.db),
    blobs: r2Blobs(opts.files, "auto/files"),
    archives: r2Blobs(opts.archives, "auto/archives"),
    releases: opts.releases ? r2Blobs(opts.releases, "auto/releases") : undefined,
    ai: opts.ai ? workersAi(opts.ai) : undefined,
    browser: opts.browser ? cloudflareBrowser(opts.browser) : undefined,
    tcp: opts.tcpConnect ? cloudflareTcpTransport(opts.tcpConnect) : undefined,
    native: opts.native,
    scheduler: opts.scheduler,
    env: opts.env,
  };
}

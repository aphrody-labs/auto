// Infrastructure ports shared by Bun (self-hosted/local) and Cloudflare Workers:
// SQLite, R2/filesystem Blobs, AI, Browser rendering, TCP sockets, Wasm, and Scheduler.
import type { LlmClient } from "./llm";

export type Row = Record<string, unknown>;

export type SqlFn = <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

export type Tx = SqlFn & {
  /** Execute a parameterized query (`?1`, `?2`, ...) and return rows. */
  exec<T = Row[]>(query: string, params?: readonly unknown[]): Promise<T>;
  /** Execute a multi-statement SQLite DDL script (migrations). */
  execScript?(script: string): Promise<void>;
  /** Nested savepoint inside an open transaction. */
  savepoint?<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

export type Sql = Tx & {
  readonly dialect: "sqlite";
  begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** Compile a JS tagged template into `(sql, params)` with positional `?` bindings. */
export function compileSql(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): { sql: string; params: unknown[] } {
  let sql = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) {
      sql += "?";
      params.push(normalizeParam(values[i]));
    }
  }
  return { sql, params };
}

export function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/** Split a SQLite DDL/DML script outside string literals, comments, and `CREATE TRIGGER ... BEGIN ... END` blocks. */
export function splitSqlStatements(script: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inTrigger = false;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    const next = script[i + 1] ?? "";
    if (inLineComment) {
      buf += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (ch === "*" && next === "/") {
        buf += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "-" && next === "-") {
        buf += ch + next;
        i++;
        inLineComment = true;
        continue;
      }
      if (ch === "/" && next === "*") {
        buf += ch + next;
        i++;
        inBlockComment = true;
        continue;
      }
    }
    if (ch === "'" && !inDouble) {
      buf += ch;
      if (inSingle && next === "'") {
        buf += next;
        i++;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === ";") {
      const stripped = buf
        .replace(/--[^\n]*\n?/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .trimEnd();
      if (!inTrigger && /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(stripped)) {
        inTrigger = true;
        buf += ch;
        continue;
      }
      if (inTrigger) {
        if (/\bEND\s*$/i.test(stripped) && !/\bEND\s+(?:AS|FROM|INTO|WHERE|WHEN)\s*$/i.test(stripped)) {
          const tokens = stripped.toUpperCase().match(/\b(?:BEGIN|CASE|END)\b/g) ?? [];
          let depth = 0;
          for (const tk of tokens) {
            if (tk === "BEGIN" || tk === "CASE") depth++;
            else depth--;
          }
          if (depth <= 0) {
            inTrigger = false;
            const stmt = buf.trim();
            if (stmt) out.push(stmt);
            buf = "";
            continue;
          }
        }
        buf += ch;
        continue;
      }
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const rest = buf.trim();
  if (rest) out.push(rest);
  return out;
}

export interface BlobObject {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

export interface BlobListEntry {
  key: string;
  size: number;
  etag?: string;
  uploaded?: string;
}

export interface Blobs {
  get(key: string): Promise<BlobObject | null>;
  put(
    key: string,
    body: Uint8Array | ArrayBuffer | string,
    opts?: { contentType?: string; customMetadata?: Record<string, string>; cacheControl?: string },
  ): Promise<{ size: number; etag?: string }>;
  head(
    key: string,
  ): Promise<{ key: string; size: number; uploaded?: string; customMetadata?: Record<string, string> } | null>;
  delete(key: string | string[]): Promise<void>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: BlobListEntry[]; truncated: boolean; cursor?: string }>;
}

/** Scope every blob operation under a shared prefix (e.g. `auto/` on shared Cloudflare R2 buckets). */
export function prefixBlobs(blobs: Blobs, prefix: string): Blobs {
  const p = prefix.replace(/^\/+/, "").replace(/\/?$/, "/");
  const withPrefix = (key: string) => `${p}${key.replace(/^\/+/, "")}`;
  const stripPrefix = (key: string) => (key.startsWith(p) ? key.slice(p.length) : key);
  return {
    async get(key) {
      const r = await blobs.get(withPrefix(key));
      return r ? { ...r, key: stripPrefix(r.key), bytes: () => r.bytes(), text: () => r.text() } : null;
    },
    put(key, body, opts) {
      return blobs.put(withPrefix(key), body, opts);
    },
    async head(key) {
      const r = await blobs.head(withPrefix(key));
      return r ? { ...r, key: stripPrefix(r.key) } : null;
    },
    delete(key) {
      return blobs.delete(Array.isArray(key) ? key.map(withPrefix) : withPrefix(key));
    },
    async list(opts) {
      const r = await blobs.list({
        prefix: opts?.prefix ? withPrefix(opts.prefix) : p,
        limit: opts?.limit,
        cursor: opts?.cursor,
      });
      return {
        objects: r.objects.map((o) => ({ ...o, key: stripPrefix(o.key) })),
        truncated: r.truncated,
        cursor: r.cursor,
      };
    },
  };
}

export interface AI {
  llm?: LlmClient;
  ocrImage?(bytes: Uint8Array, mime?: string): Promise<string>;
  embedding?(text: string): Promise<number[]>;
}

export interface BrowserOptions {
  width: number;
  height: number;
  waitMs?: number;
}

export interface Browser {
  snapshot(url: string, opts: BrowserOptions): Promise<{ image: Uint8Array; title?: string; text?: string }>;
}

export interface TcpConnectOptions {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  allowInsecureCert?: boolean;
  timeoutMs?: number;
}

export interface TcpConnection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  startTls(): TcpConnection;
  close(): Promise<void>;
}

export interface TcpTransport {
  connect(opts: TcpConnectOptions): Promise<TcpConnection>;
}

export interface Native {
  call(op: string, input: Uint8Array): Promise<Uint8Array>;
}

export interface Scheduler {
  startWorkflow?(name: string, payload: unknown): Promise<{ instanceId: string }>;
  scheduleAlarm?(atMs: number): Promise<void>;
}

export type AutoMode = "serverless" | "self-hosted";

export function resolveAutoMode(env: Record<string, string | undefined> = process.env): AutoMode {
  return env.AUTO_MODE?.trim().toLowerCase() === "serverless" ? "serverless" : "self-hosted";
}

export interface Platform {
  readonly engine: "bun" | "cloudflare";
  readonly mode: AutoMode;
  readonly globalDb: Sql;
  readonly blobs: Blobs;
  readonly archives: Blobs;
  readonly releases?: Blobs;
  readonly ai?: AI;
  readonly browser?: Browser;
  readonly tcp?: TcpTransport;
  readonly native?: Native;
  readonly scheduler?: Scheduler;
  readonly env: Record<string, string | undefined>;
}

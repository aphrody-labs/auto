// Bun runtime adapters (self-hosted server, CLI, local dev, and tests) for @aphrody/auto-platform.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Socket, SocketHandler } from "bun";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { llmConfigFromEnv, openAiClient } from "./llm";
import {
  compileSql,
  prefixBlobs,
  type AI,
  type BlobObject,
  type Blobs,
  type Browser,
  type Platform,
  type Row,
  type Scheduler,
  type Sql,
  type TcpConnection,
  type TcpConnectOptions,
  type TcpTransport,
  type Tx,
} from "./index";

type Binding = SQLQueryBindings;

function runSqliteQuery(db: Database, sql: string, params: readonly unknown[] = []): Row[] {
  const trim = sql.trimStart().toUpperCase();
  const returnsRows =
    trim.startsWith("SELECT") || trim.startsWith("PRAGMA") || trim.startsWith("WITH") || /\bRETURNING\b/i.test(sql);
  // Finalize explicit prepared statements to avoid lingering handles on Windows `db.close()`.
  const stmt = db.prepare<Row, Binding[]>(sql);
  try {
    if (returnsRows) return stmt.all(...(params as Binding[]));
    stmt.run(...(params as Binding[]));
    return [];
  } finally {
    stmt.finalize();
  }
}

function getSqliteDatabase(): typeof Database {
  const mod = process.getBuiltinModule?.("bun:sqlite") as { Database?: typeof Database } | undefined;
  if (!mod?.Database) throw new Error("bun:sqlite is only available under the Bun runtime");
  return mod.Database;
}

/** Open a `bun:sqlite` database with WAL mode, foreign keys, and serialized `begin()` queue. */
export function bunSqlite(target: string | Database = ":memory:", opts?: { readonly?: boolean }): Sql {
  const SqliteDb = getSqliteDatabase();
  const db =
    typeof target === "string" ? new SqliteDb(target, { create: !opts?.readonly, readonly: opts?.readonly }) : target;
  if (!opts?.readonly) {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (target !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  }

  let queue = Promise.resolve();
  let depth = 0;

  const makeTx = (): Tx => {
    const fn = (<T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const { sql, params } = compileSql(strings, ...values);
      try {
        return Promise.resolve(runSqliteQuery(db, sql, params) as unknown as T);
      } catch (e) {
        return Promise.reject(e);
      }
    }) as Tx;
    fn.exec = <T = Row[]>(query: string, params: readonly unknown[] = []) => {
      try {
        return Promise.resolve(runSqliteQuery(db, query, params) as unknown as T);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    fn.execScript = (script: string) => {
      try {
        db.exec(script);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    };
    fn.savepoint = <T>(cb: (sp: Tx) => Promise<T>): Promise<T> => {
      const sp = `sp_${++depth}`;
      db.exec(`SAVEPOINT ${sp}`);
      return cb(baseTx).then(
        (val) => {
          db.exec(`RELEASE SAVEPOINT ${sp}`);
          depth--;
          return val;
        },
        (err) => {
          try {
            db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
          } catch {}
          depth--;
          throw err;
        },
      );
    };
    return fn;
  };

  const baseTx = makeTx();
  return Object.assign(
    (<T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
      baseTx<T>(strings, ...values)) as Sql,
    {
      dialect: "sqlite" as const,
      exec: baseTx.exec,
      execScript: baseTx.execScript,
      begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        if (depth > 0) {
          const sp = `sp_${++depth}`;
          db.exec(`SAVEPOINT ${sp}`);
          return fn(baseTx).then(
            (val) => {
              db.exec(`RELEASE SAVEPOINT ${sp}`);
              depth--;
              return val;
            },
            (err) => {
              try {
                db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
              } catch {}
              depth--;
              throw err;
            },
          );
        }
        const task = queue.then(async () => {
          depth = 1;
          db.exec("BEGIN IMMEDIATE");
          try {
            const res = await fn(baseTx);
            db.exec("COMMIT");
            return res;
          } catch (err) {
            try {
              db.exec("ROLLBACK");
            } catch {}
            throw err;
          } finally {
            depth = 0;
          }
        });
        queue = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      },
      close(): Promise<void> {
        try {
          db.close();
          return Promise.resolve();
        } catch (err) {
          return Promise.reject(err);
        }
      },
    },
  );
}

interface BlobMeta {
  contentType?: string;
  customMetadata?: Record<string, string>;
  etag: string;
}

function sanitizeKey(key: string): string {
  const n = normalize(key).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!n || n === ".." || n.startsWith("../") || n.includes("/../")) {
    throw new Error(`Invalid blob key: ${key}`);
  }
  return n;
}

/** Local filesystem object store (self-hosted and tests) using sidecar `.__meta.json` metadata. */
export function dirBlobs(root: string, prefix?: string): Blobs {
  const base = normalize(root);
  const filePath = (key: string) => join(base, sanitizeKey(key));
  const metaPath = (key: string) => `${filePath(key)}.__meta.json`;

  const raw: Blobs = {
    async get(key): Promise<BlobObject | null> {
      const f = Bun.file(filePath(key));
      if (!(await f.exists())) return null;
      let meta: BlobMeta | undefined;
      const mf = Bun.file(metaPath(key));
      if (await mf.exists()) {
        try {
          meta = (await mf.json()) as BlobMeta;
        } catch {}
      }
      return {
        key: sanitizeKey(key),
        size: f.size,
        etag: meta?.etag,
        contentType: meta?.contentType ?? f.type,
        customMetadata: meta?.customMetadata,
        bytes: async () => new Uint8Array(await f.arrayBuffer()),
        text: () => f.text(),
      };
    },
    async put(key, body, opts) {
      const target = filePath(key);
      await mkdir(dirname(target), { recursive: true });
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      await Bun.write(target, bytes);
      const etag = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32);
      const meta: BlobMeta = {
        contentType: opts?.contentType,
        customMetadata: opts?.customMetadata,
        etag,
      };
      await Bun.write(metaPath(key), JSON.stringify(meta));
      return { size: bytes.byteLength, etag };
    },
    async head(key) {
      const f = Bun.file(filePath(key));
      if (!(await f.exists())) return null;
      let meta: BlobMeta | undefined;
      const mf = Bun.file(metaPath(key));
      if (await mf.exists()) {
        try {
          meta = (await mf.json()) as BlobMeta;
        } catch {}
      }
      return {
        key: sanitizeKey(key),
        size: f.size,
        uploaded: new Date(f.lastModified).toISOString(),
        customMetadata: meta?.customMetadata,
      };
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        await rm(filePath(k), { force: true });
        await rm(metaPath(k), { force: true });
      }
    },
    async list(opts) {
      const pfx = opts?.prefix ? sanitizeKey(opts.prefix) : "";
      const out: { key: string; size: number; uploaded?: string }[] = [];
      async function walk(dir: string, rel: string) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full, r);
          } else if (e.isFile() && !e.name.endsWith(".__meta.json") && (!pfx || r.startsWith(pfx))) {
            const f = Bun.file(full);
            out.push({ key: r, size: f.size, uploaded: new Date(f.lastModified).toISOString() });
          }
        }
      }
      await walk(base, "");
      out.sort((a, b) => a.key.localeCompare(b.key));
      const limit = opts?.limit ?? out.length;
      return { objects: out.slice(0, limit), truncated: out.length > limit };
    },
  };
  return prefix ? prefixBlobs(raw, prefix) : raw;
}

/** Wrap `Bun.connect` behind the unified Web Streams `TcpConnection` interface (including `startTls`). */
export function bunTcpTransport(): TcpTransport {
  return {
    async connect(opts: TcpConnectOptions): Promise<TcpConnection> {
      let sock!: Socket<undefined>;
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      let gen = 0;
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });

      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
        },
        cancel() {
          try {
            sock?.end();
          } catch {}
        },
      });

      const makeHandler = (): SocketHandler<undefined> => {
        const g = ++gen;
        const active = () => g === gen;
        return {
          data: (_s, d) => {
            if (active()) ctrl.enqueue(new Uint8Array(d));
          },
          close: () => {
            if (active()) {
              try {
                ctrl.close();
              } catch {}
              resolveClosed();
            }
          },
          error: (_s, err) => {
            if (active()) {
              try {
                ctrl.error(err);
              } catch {}
              resolveClosed();
            }
          },
          connectError: (_s, err) => {
            try {
              ctrl.error(err);
            } catch {}
            resolveClosed();
          },
          handshake: (_s, ok, err) => {
            if (active() && !ok && !opts.allowInsecureCert) {
              try {
                ctrl.error(new Error(`Certificate rejected: ${err?.message ?? "unknown"}`));
              } catch {}
            }
          },
        };
      };

      const tls =
        opts.security === "tls" ? { serverName: opts.host, rejectUnauthorized: !opts.allowInsecureCert } : undefined;
      sock = await Bun.connect({ hostname: opts.host, port: opts.port, tls, socket: makeHandler() });
      sock.timeout(Math.ceil((opts.timeoutMs ?? 30_000) / 1000));

      const wrap = (s: Socket<undefined>): TcpConnection => ({
        readable,
        closed,
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            s.write(chunk);
          },
          close() {
            s.end();
          },
          abort() {
            s.end();
          },
        }),
        startTls() {
          const [, upgraded] = s.upgradeTLS<undefined>({
            tls: { serverName: opts.host, rejectUnauthorized: !opts.allowInsecureCert },
            socket: makeHandler(),
          });
          sock = upgraded;
          return wrap(upgraded);
        },
        async close() {
          try {
            s.end();
          } catch {}
        },
      });
      return wrap(sock);
    },
  };
}

/** OpenAI-compatible AI provider configured from `AUTO_LLM_URL`. */
export function bunAiFromEnv(env: Record<string, string | undefined> = Bun.env): AI | undefined {
  const cfg = llmConfigFromEnv(env);
  if (!cfg) return undefined;
  return { llm: openAiClient(cfg) };
}

/** Headless Chrome snapshot adapter via `Bun.WebView` when available. */
export function bunBrowser(env: Record<string, string | undefined> = Bun.env): Browser {
  let queue = Promise.resolve();
  return {
    snapshot(url, opts) {
      const task = queue.then(async () => {
        await using view = new Bun.WebView({
          width: opts.width,
          height: opts.height,
          backend: {
            type: "chrome",
            url: false,
            ...(env.AUTO_CHROME_ARGS ? { argv: env.AUTO_CHROME_ARGS.split(" ").filter(Boolean) } : {}),
          },
        });
        await view.navigate(url);
        if (opts.waitMs) await Bun.sleep(opts.waitMs);
        const title = await view.title;
        const shot = await view.screenshot({ format: "png" });
        return { image: new Uint8Array(await shot.arrayBuffer()), title };
      });
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
}

export function bunPlatform(opts: {
  globalDb: Sql;
  dataDir: string;
  env?: Record<string, string | undefined>;
  scheduler?: Scheduler;
}): Platform {
  const env = opts.env ?? Bun.env;
  return {
    engine: "bun",
    mode: env.AUTO_MODE === "serverless" ? "serverless" : "self-hosted",
    globalDb: opts.globalDb,
    blobs: prefixBlobs(dirBlobs(join(opts.dataDir, "blobs")), "auto/files"),
    archives: prefixBlobs(dirBlobs(join(opts.dataDir, "archives")), "auto/archives"),
    releases: prefixBlobs(dirBlobs(join(opts.dataDir, "releases")), "auto/releases"),
    ai: bunAiFromEnv(env),
    browser: bunBrowser(env),
    tcp: bunTcpTransport(),
    scheduler: opts.scheduler,
    env,
  };
}

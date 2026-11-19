// Unified SQLite connections (D1 global, CompanyDO SQLite, bun:sqlite WAL), schema migrations, and company routing.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Blobs, Sql, Tx } from "@aphrody/auto-platform";
import { bunSqlite, dirBlobs } from "@aphrody/auto-platform/bun";
import type { CompanyTx } from "./sqlite";
import { StoreError } from "./sqlite";

export type { Sql, Tx };

export const DEFAULT_DB_PATH = ":memory:";

const blobsBySql = new WeakMap<object, Blobs>();
const companyResolversBySql = new WeakMap<object, (companyId: string) => Promise<Sql>>();
const blobsByTx = new WeakMap<object, Blobs>();

export function registerBlobs(sql: Sql, blobs: Blobs): void {
  blobsBySql.set(sql, blobs);
}

export function registerCompanyResolver(sql: Sql, fn: (companyId: string) => Promise<Sql>): void {
  companyResolversBySql.set(sql, fn);
}

export function blobsOf(txOrSql: Tx): Blobs | undefined {
  return blobsByTx.get(txOrSql) ?? blobsBySql.get(txOrSql);
}

export function connect(path = process.env.AUTO_DB_PATH ?? DEFAULT_DB_PATH): Sql {
  if (path.startsWith("postgres://") || path.startsWith("postgresql://")) {
    return bunSqlite(":memory:");
  }
  return bunSqlite(path);
}

const preloadedMigrations = new Map<string, string>();

export function registerMigration(name: string, sqlText: string): void {
  preloadedMigrations.set(name, sqlText);
}

async function readMigrationSql(name: string): Promise<string> {
  const preloaded = preloadedMigrations.get(name);
  if (preloaded !== undefined) return preloaded;
  if (typeof Bun !== "undefined" && Array.isArray(Bun.embeddedFiles)) {
    const emb = Bun.embeddedFiles.find(
      (f) => f.name.endsWith(`/${name}`) || f.name.endsWith(`\\${name}`) || f.name === name,
    );
    if (emb) return await emb.text();
  }
  return readFileSync(join(import.meta.dir ?? ".", "../migrations", name), "utf8");
}

async function applyMigrations(sql: Sql, files: readonly string[]): Promise<string[]> {
  if (!sql.execScript) throw new Error("SQL adapter missing execScript()");
  await sql.execScript(
    "CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
  );
  const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migration`;
  const appliedSet = new Set(rows.map((r) => r.version));
  const appliedNow: string[] = [];
  for (const name of files) {
    if (appliedSet.has(name)) continue;
    const content = await readMigrationSql(name);
    await sql.execScript(content);
    await sql`INSERT OR IGNORE INTO schema_migration (version) VALUES (${name})`;
    appliedNow.push(name);
  }
  return appliedNow;
}

export const migrateGlobal = (sql: Sql) => applyMigrations(sql, ["001_global.sql"]);
export const migrateCompany = (sql: Sql) => applyMigrations(sql, ["002_company.sql"]);
export const migrate = (sql: Sql) => applyMigrations(sql, ["001_global.sql", "002_company.sql"]);

/**
 * Execute `fn` inside a company transaction.
 * In Serverless Cloudflare Workers, delegates to the `CompanyDO` SQLite instance registered for `sql`.
 * In Self-Hosted or test environments, binds `companyId` onto the local SQLite transaction.
 */
export async function withCompany<T>(sql: Sql, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const resolveCompanyDb = companyResolversBySql.get(sql);
  const target = resolveCompanyDb ? await resolveCompanyDb(companyId) : sql;
  const blobs = blobsBySql.get(target) ?? blobsBySql.get(sql);
  return target.begin(async (tx) => {
    if (blobs) blobsByTx.set(tx, blobs);
    const wrapped = Object.assign(tx, { companyId }) as CompanyTx;
    return fn(wrapped);
  });
}

export async function readSite(tx: Tx): Promise<string> {
  const [row] = await tx<{ value: string }[]>`SELECT value FROM _sync_state WHERE key = ${"site"}`;
  return row?.value || "cloud";
}

export async function setSite(tx: Tx, site: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(site)) {
    throw new StoreError(`Invalid site identifier: ${site}`, [], 400);
  }
  await tx`INSERT INTO _sync_state (key, value) VALUES (${"site"}, ${site})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
}

export async function testDb(): Promise<{ sql: Sql; blobs: Blobs; dir: string; drop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "auto-store-test-"));
  const sql = bunSqlite(join(dir, "auto.sqlite"));
  const blobs = dirBlobs(join(dir, "blobs"));
  registerBlobs(sql, blobs);
  await migrate(sql);
  return {
    sql,
    blobs,
    dir,
    drop: async () => {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

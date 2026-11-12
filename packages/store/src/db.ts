import { SQL, type TransactionSQL } from "bun";

export type Sql = SQL;
export type Tx = TransactionSQL;

export const DEFAULT_URL = "postgres://auto:auto@localhost:5433/auto";

export function connect(url = Bun.env.DATABASE_URL ?? DEFAULT_URL): Sql {
  return new SQL(url);
}

/**
 * Connexion des migrations : `DATABASE_URL_DIRECT` quand l'application passe par un pooler (Neon : PgBouncer
 * en mode transaction pour l'API et le worker, point d'accès direct pour le DDL et pg_dump), sinon `DATABASE_URL`.
 */
export function connectMigrations(): Sql {
  return new SQL(Bun.env.DATABASE_URL_DIRECT || Bun.env.DATABASE_URL || DEFAULT_URL, { max: 1 });
}

const MIGRATIONS = Bun.env.AUTO_MIGRATIONS_DIR
  ? Bun.pathToFileURL(`${Bun.env.AUTO_MIGRATIONS_DIR.replace(/[\\/]+$/, "")}/`)
  : new URL("../migrations/", import.meta.url);

/** Applique les migrations `migrations/NNN_*.sql` non encore appliquées, dans l'ordre. */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await Array.fromAsync(new Bun.Glob("*.sql").scan(Bun.fileURLToPath(MIGRATIONS)))).sort();
  // Le verrou couvre aussi la création de schema_migration et garantit l'ordre entre instances.
  // Il est libéré automatiquement à la fin de la transaction, y compris en cas d'erreur.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(1635087471, 1835624306)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Map(
      (await tx`SELECT name, checksum FROM schema_migration`).map((r: { name: string; checksum: string }) => [
        r.name,
        r.checksum,
      ]),
    );
    const applied: string[] = [];
    for (const name of files) {
      const text = await Bun.file(new URL(name, MIGRATIONS)).text();
      const checksum = new Bun.CryptoHasher("sha256").update(text).digest("hex");
      const prev = done.get(name);
      if (prev) {
        if (prev !== checksum) throw new Error(`migration ${name} modifiée après application`);
        continue;
      }
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migration (name, checksum) VALUES (${name}, ${checksum})`;
      applied.push(name);
    }
    return applied;
  });
}

/**
 * Exécute `fn` dans une transaction isolée sur un tenant : rôle `auto_app` (soumis à la RLS)
 * et `app.tenant` posé localement. Sans tenant, la RLS ne renvoie aucune ligne.
 */
export function withTenant<T>(sql: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE auto_app`;
    await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Base jetable pour les tests : créée, migrée, supprimée par `drop()`. */
export async function testDb(url = Bun.env.DATABASE_URL ?? DEFAULT_URL) {
  const admin = new SQL(url, { max: 1, idleTimeout: 2, connectionTimeout: 10 });
  const name = `auto_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  const sql = new SQL(u.toString(), { max: 4, idleTimeout: 5, connectionTimeout: 10 });
  try {
    await migrate(sql);
  } catch (erreur) {
    await sql.close();
    try {
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
    throw erreur;
  }
  return {
    sql,
    async drop() {
      await sql.close();
      try {
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.close();
      }
    },
  };
}

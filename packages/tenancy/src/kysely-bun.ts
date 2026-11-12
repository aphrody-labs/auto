// Dialecte Kysely sur `Bun.SQL` (Postgres) : Better Auth parle à la base de l'application par le même
// pool que le reste d'auto, sans pilote `pg`. Les requêtes isolées passent par le pool ; une transaction
// réserve une connexion (`sql.reserve()`) jusqu'au COMMIT ou ROLLBACK.
import type { SQL, ReservedSQL } from "bun";
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

const MODIFICATIONS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

async function executer<R>(cible: SQL | ReservedSQL, q: CompiledQuery): Promise<QueryResult<R>> {
  const r = (await cible.unsafe(q.sql, q.parameters as unknown[])) as R[] & { count?: number; command?: string };
  const rows = [...r];
  return MODIFICATIONS.has(r.command ?? "") ? { rows, numAffectedRows: BigInt(r.count ?? 0) } : { rows };
}

/** Connexion paresseuse : le pool tant qu'aucune transaction n'est ouverte, une connexion réservée ensuite. */
class ConnexionBun implements DatabaseConnection {
  reservee: ReservedSQL | null = null;

  constructor(private readonly sql: SQL) {}

  executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    return executer<R>(this.reservee ?? this.sql, q);
  }

  async *streamQuery<R>(q: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(q);
  }

  async debuter(settings: TransactionSettings) {
    this.reservee = await this.sql.reserve();
    const options = [
      settings.isolationLevel && `ISOLATION LEVEL ${settings.isolationLevel.toUpperCase()}`,
      settings.accessMode?.toUpperCase(),
    ].filter(Boolean);
    await this.reservee.unsafe(`BEGIN${options.length ? ` ${options.join(", ")}` : ""}`);
  }

  async finir(ordre: "COMMIT" | "ROLLBACK") {
    const r = this.reservee;
    this.reservee = null;
    if (!r) return;
    try {
      await r.unsafe(ordre);
    } finally {
      r.release();
    }
  }
}

class PiloteBun implements Driver {
  constructor(private readonly sql: SQL) {}
  async init() {}
  async acquireConnection() {
    return new ConnexionBun(this.sql);
  }
  async beginTransaction(c: DatabaseConnection, settings: TransactionSettings) {
    await (c as ConnexionBun).debuter(settings);
  }
  async commitTransaction(c: DatabaseConnection) {
    await (c as ConnexionBun).finir("COMMIT");
  }
  async rollbackTransaction(c: DatabaseConnection) {
    await (c as ConnexionBun).finir("ROLLBACK");
  }
  async savepoint(c: DatabaseConnection, nom: string, compiler: QueryCompiler["compileQuery"]) {
    await c.executeQuery(CompiledQuery.raw(`SAVEPOINT ${nom}`));
    void compiler;
  }
  async rollbackToSavepoint(c: DatabaseConnection, nom: string) {
    await c.executeQuery(CompiledQuery.raw(`ROLLBACK TO SAVEPOINT ${nom}`));
  }
  async releaseSavepoint(c: DatabaseConnection, nom: string) {
    await c.executeQuery(CompiledQuery.raw(`RELEASE SAVEPOINT ${nom}`));
  }
  async releaseConnection(c: DatabaseConnection) {
    // Transaction abandonnée sans COMMIT ni ROLLBACK : la connexion réservée revient au pool annulée.
    await (c as ConnexionBun).finir("ROLLBACK");
  }
  async destroy() {}
}

/** `new Kysely({ dialect: new DialecteBunSql(sql) })` : le pool reste celui de l'appelant (jamais fermé ici). */
export class DialecteBunSql implements Dialect {
  constructor(private readonly sql: SQL) {}
  createAdapter() {
    return new PostgresAdapter();
  }
  createDriver(): Driver {
    return new PiloteBun(this.sql);
  }
  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

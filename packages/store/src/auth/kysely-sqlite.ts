// Kysely SQLite dialect over @aphrody/auto-platform `Sql` (D1, Durable Object SQLite, bun:sqlite).
import type { Sql } from "@aphrody/auto-platform";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

class PlatformSqliteConnection implements DatabaseConnection {
  constructor(private readonly sql: Sql) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    if (!this.sql.exec) throw new Error("SQLite adapter missing exec()");
    const rows = await this.sql.exec<R[]>(query.sql, query.parameters);
    const upper = query.sql.trimStart().toUpperCase();
    if (upper.startsWith("INSERT") || upper.startsWith("UPDATE") || upper.startsWith("DELETE")) {
      return { rows, numAffectedRows: BigInt(rows.length || 1) };
    }
    return { rows };
  }

  async *streamQuery<R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(query);
  }
}

class PlatformSqliteDriver implements Driver {
  constructor(private readonly sql: Sql) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new PlatformSqliteConnection(this.sql);
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export class PlatformSqliteDialect implements Dialect {
  constructor(private readonly sql: Sql) {}

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new PlatformSqliteDriver(this.sql);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

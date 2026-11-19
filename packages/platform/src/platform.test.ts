import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSqlite, dirBlobs } from "./bun";
import { compileSql, prefixBlobs, splitSqlStatements } from "./index";
import { resolveLocale, t, tc, tid, tp } from "./i18n";

test("compileSql replaces each interpolation with a positional ?", () => {
  const { sql, params } =
    compileSql`SELECT * FROM customer WHERE name = ${"Dupont"} AND active = ${true} AND meta = ${{ a: 1 }}`;
  expect(sql).toBe("SELECT * FROM customer WHERE name = ? AND active = ? AND meta = ?");
  expect(params).toEqual(["Dupont", 1, '{"a":1}']);
});

test("splitSqlStatements preserves BEGIN..END trigger blocks and comments", () => {
  const script = `
    -- sample table
    CREATE TABLE doc (id TEXT PRIMARY KEY, status TEXT);
    CREATE TRIGGER trg_immutable BEFORE UPDATE ON doc WHEN OLD.status = 'issued' BEGIN
      SELECT RAISE(ABORT, 'immutable; forbidden');
    END;
    INSERT INTO doc VALUES ('1', 'draft');
  `;
  const stmts = splitSqlStatements(script);
  expect(stmts).toHaveLength(3);
  expect(stmts[1]).toContain("END");
});

test("bunSqlite runs DDL, triggers, transactions, and rollbacks in memory", async () => {
  const sql = bunSqlite(":memory:");
  await sql.execScript!(
    "CREATE TABLE c (id TEXT PRIMARY KEY, n INTEGER); CREATE TRIGGER fig BEFORE UPDATE ON c WHEN OLD.n=2 BEGIN SELECT RAISE(ABORT, 'locked'); END;",
  );
  await sql`INSERT INTO c VALUES (${"a"}, ${1})`;
  await expect(
    sql.begin(async (tx) => {
      await tx`UPDATE c SET n = ${9} WHERE id = ${"a"}`;
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  const rows = await sql<{ n: number }[]>`SELECT n FROM c WHERE id = ${"a"}`;
  expect(rows[0]!.n).toBe(1);
  await sql.close();
});

test("dirBlobs + prefixBlobs support put, get, head, list, and delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auto-blobs-"));
  try {
    const base = prefixBlobs(dirBlobs(dir), "auto/files");
    await base.put("c1/invoice.pdf", new Uint8Array([1, 2, 3]), {
      contentType: "application/pdf",
      customMetadata: { retention: "11y" },
    });
    const head = await base.head("c1/invoice.pdf");
    expect(head).toMatchObject({ key: "c1/invoice.pdf", size: 3, customMetadata: { retention: "11y" } });
    const obj = await base.get("c1/invoice.pdf");
    expect(await obj!.bytes()).toEqual(new Uint8Array([1, 2, 3]));
    const list = await base.list({ prefix: "c1/" });
    expect(list.objects.map((o) => o.key)).toEqual(["c1/invoice.pdf"]);
    await base.delete("c1/invoice.pdf");
    expect(await base.get("c1/invoice.pdf")).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("i18n helper formats strings, plurals, and resolves locale", () => {
  expect(resolveLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
  expect(resolveLocale("en-US")).toBe("en");
  expect(t("en", "Invoice {number} created", { number: "INV-2026-0001" })).toBe("Invoice INV-2026-0001 created");
  expect(tc("en", "status", "Draft")).toBe("Draft");
  expect(tp("en", "{n} item|{n} items", 1)).toBe("1 item");
  expect(tp("en", "{n} item|{n} items", 3)).toBe("3 items");
  expect(tid("en", "err.not_found", "Not found")).toBe("Not found");
});

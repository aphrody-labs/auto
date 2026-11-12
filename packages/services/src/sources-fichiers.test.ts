import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { testDb, withTenant, type Sql } from "@auto/store";
import { preparerArrivages, racinesFichiers } from "./sources-fichiers";
let sql: Sql, drop: () => Promise<void>, parent: string, A: string, B: string;
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  parent = await mkdtemp(join(tmpdir(), "auto-activer-"));
  const t = await sql<
    { id: string }[]
  >`INSERT INTO tenant(nom,siren,siret) VALUES ('A','732829320','73282932000074'),('B','732829320','73282932000074') RETURNING id`;
  [A, B] = [t[0]!.id, t[1]!.id];
});
afterAll(async () => {
  if (drop) await drop();
  const relatif = parent && relative(resolve(tmpdir()), resolve(parent));
  if (relatif && relatif.startsWith("auto-activer-") && !relatif.includes(".."))
    await rm(parent, { recursive: true, force: true });
});
test("préparation opt-in isolée par entreprise, sans réactiver les sources désactivées", async () => {
  const env = { AUTO_DOSSIERS_PARENT: parent };
  expect(await preparerArrivages(sql, {})).toEqual({ entreprises: 0, sources: 0 });
  expect(await preparerArrivages(sql, env)).toEqual({ entreprises: 2, sources: 14 });
  expect(racinesFichiers(A, env).arrivages).not.toBe(racinesFichiers(B, env).arrivages);
  expect((await stat(join(parent, A, "fournisseurs/devis"))).isDirectory()).toBe(true);
  await withTenant(sql, A, (tx) => tx`UPDATE source_fichiers SET actif=false WHERE sous_dossier='fournisseurs/devis'`);
  expect(await preparerArrivages(sql, env)).toEqual({ entreprises: 0, sources: 0 });
  expect(
    await withTenant(sql, A, (tx) => tx`SELECT actif FROM source_fichiers WHERE sous_dossier='fournisseurs/devis'`),
  ).toEqual([{ actif: false }]);
  expect(() => racinesFichiers("../autre", env)).toThrow();
});

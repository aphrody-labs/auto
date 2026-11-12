import { expect, test } from "bun:test";
import { SQL } from "bun";
import { DEFAULT_URL, migrate } from "./db";

test("les migrations concurrentes d'une base neuve sont sérialisées", async () => {
  const url = Bun.env.DATABASE_URL ?? DEFAULT_URL;
  const admin = new SQL(url, { max: 1 });
  const nom = `auto_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${nom}`);
  const adresse = new URL(url);
  adresse.pathname = `/${nom}`;
  const a = new SQL(adresse.toString(), { max: 1 });
  const b = new SQL(adresse.toString(), { max: 1 });
  try {
    const resultats = await Promise.all([migrate(a), migrate(b)]);
    const nombre = resultats[0]!.length + resultats[1]!.length;
    expect(nombre).toBeGreaterThan(0);
    expect(resultats.some((r) => r.length === 0)).toBe(true);
    const lignes = await a`SELECT name FROM schema_migration`;
    expect(lignes.length).toBe(nombre);
    expect(await migrate(a)).toEqual([]);
  } finally {
    await a.close();
    await b.close();
    try {
      await admin.unsafe(`DROP DATABASE ${nom} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }
});

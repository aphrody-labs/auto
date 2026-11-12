import { afterAll, beforeAll, expect, test } from "bun:test";
import { avecWorker, enfiler, lireJob, testDb, type Sql } from "@auto/store";
import { creerWorker } from "./worker";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
});

afterAll(() => drop());

const ajouter = (type: string, payload: object = {}, maxEssais?: number) =>
  avecWorker(sql, (tx) => enfiler(tx, type, payload, { tenantId: null, maxEssais }));

test("deux workers concurrents : chaque job exécuté une seule fois", async () => {
  const vus: number[] = [];
  const t = {
    "test.unique": {
      async executer(j: { payload: Record<string, unknown> }) {
        await Bun.sleep(5);
        vus.push(Number(j.payload.n));
      },
    },
  };
  for (let n = 0; n < 20; n++) await ajouter("test.unique", { n });
  const [a, b] = [creerWorker(sql, t, { lot: 3 }), creerWorker(sql, t, { lot: 3 })];
  const [na, nb] = await Promise.all([a.vider(), b.vider()]);
  expect(na + nb).toBe(20);
  expect(vus.sort((x, y) => x - y)).toEqual([...Array(20).keys()]);
});

test("délai dépassé : job abandonné puis réessayé, échec signalé au bout des essais", async () => {
  const echecs: string[] = [];
  let appels = 0;
  const w = creerWorker(
    sql,
    {
      "test.lent": {
        executer: () => {
          appels++;
          return new Promise(() => {}); // ne se termine jamais
        },
        echec: async (_j, e) => {
          echecs.push(e);
        },
      },
    },
    { bailMs: 50, delai: () => 0 },
  );
  const id = (await ajouter("test.lent", {}, 2))!;
  await w.vider();
  expect(appels).toBe(2);
  expect(echecs).toEqual(["délai dépassé (50 ms)"]);
  expect(await lireJob(sql, id)).toMatchObject({ statut: "echec", essais: 2 });
});

test("types inconnus ignorés : le job reste en attente", async () => {
  const id = (await ajouter("test.autre"))!;
  expect(await creerWorker(sql, { "test.rien": { executer: async () => {} } }).vider()).toBe(0);
  expect((await lireJob(sql, id))?.statut).toBe("en_attente");
});

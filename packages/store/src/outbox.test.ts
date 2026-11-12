import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  ajouterEvenement,
  avecWorker,
  delaiNouvelEssai,
  enfiler,
  JOB_LIVRAISON,
  lireEvenement,
  lireJob,
  listerEvenements,
  noterLivraison,
  prendreJobs,
  reporterJob,
  terminerJob,
  testDb,
  withTenant,
  type Sql,
} from "./index";

let sql: Sql;
let drop: () => Promise<void>;
let A: string;
let B: string;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('A', '732829320', '73282932000074'), ('B', '732829320', '73282932000074')
    RETURNING id`;
  [A, B] = rows.map((r) => r.id) as [string, string];
});

afterAll(() => drop());

test("événement ajouté avec la transaction métier, absent si elle est annulée", async () => {
  const { id, corps } = await withTenant(sql, A, (tx) => ajouterEvenement(tx, "document.emis", { numero: "F-1" }));
  expect(JSON.parse(corps)).toMatchObject({ id, type: "document.emis", tenantId: A, data: { numero: "F-1" } });
  const e = await lireEvenement(sql, id);
  expect(e).toMatchObject({ statut: "a_livrer", essais: 0, corps });

  let annule = "";
  await expect(
    withTenant(sql, A, async (tx) => {
      annule = (await ajouterEvenement(tx, "document.emis", {})).id;
      throw new Error("action métier en échec");
    }),
  ).rejects.toThrow("action métier");
  expect(await lireEvenement(sql, annule)).toBeNull();

  await expect(sql.begin((tx) => ajouterEvenement(tx, "document.emis", {}))).rejects.toThrow("withTenant");
});

test("outbox isolée par tenant (RLS)", async () => {
  await withTenant(sql, B, (tx) => ajouterEvenement(tx, "paiement.enregistre", {}));
  const a = await withTenant(sql, A, (tx) => listerEvenements(tx));
  const b = await withTenant(sql, B, (tx) => listerEvenements(tx));
  expect(a.every((e) => e.tenantId === A)).toBe(true);
  expect(b.map((e) => e.type)).toEqual(["paiement.enregistre"]);
  // Un tenant ne peut ni lire ni insérer de job pour un autre.
  await expect(withTenant(sql, A, (tx) => enfiler(tx, "x", {}, { tenantId: B }))).rejects.toThrow();
});

test("un job par événement ; prise exclusive entre workers (SKIP LOCKED)", async () => {
  await avecWorker(sql, (tx) => tx`UPDATE job SET statut = 'fait'`);
  for (let i = 0; i < 6; i++) await withTenant(sql, A, (tx) => ajouterEvenement(tx, "document.statut", { i }));
  const [x, y] = await Promise.all([prendreJobs(sql, [JOB_LIVRAISON], 4), prendreJobs(sql, [JOB_LIVRAISON], 4)]);
  const ids = [...x!, ...y!].map((j) => j.id);
  expect(ids.length).toBe(6);
  expect(new Set(ids).size).toBe(6);
  expect(x!.every((j) => j.statut === "en_cours" && j.essais === 1 && j.tenantId === A)).toBe(true);
  expect(await prendreJobs(sql, [JOB_LIVRAISON], 10)).toEqual([]);
  for (const id of ids) await terminerJob(sql, id);
  expect((await lireJob(sql, ids[0]!))?.statut).toBe("fait");
});

test("bail expiré : job repris, puis en échec une fois les essais épuisés", async () => {
  const id = (await avecWorker(sql, (tx) => enfiler(tx, "test.bail", {}, { maxEssais: 2 })))!;
  expect((await prendreJobs(sql, ["test.bail"], 1, 1)).map((j) => j.id)).toEqual([id]);
  await Bun.sleep(10);
  const [repris] = await prendreJobs(sql, ["test.bail"], 1, 1);
  expect(repris).toMatchObject({ id, essais: 2 });
  await Bun.sleep(10);
  expect(await prendreJobs(sql, ["test.bail"], 1, 1)).toEqual([]);
  expect(await lireJob(sql, id)).toMatchObject({ statut: "echec", derniereErreur: "bail expiré" });
});

test("nouvel essai différé, échec définitif après max_essais", async () => {
  const id = (await avecWorker(sql, (tx) => enfiler(tx, "test.essai", {}, { maxEssais: 2 })))!;
  const [j1] = await prendreJobs(sql, ["test.essai"]);
  expect(await reporterJob(sql, j1!, "HTTP 500", 60_000)).toBe("reporte");
  expect(await prendreJobs(sql, ["test.essai"])).toEqual([]); // pas avant le délai
  await avecWorker(sql, (tx) => tx`UPDATE job SET executer_apres = now() WHERE id = ${id}`);
  const [j2] = await prendreJobs(sql, ["test.essai"]);
  expect(j2).toMatchObject({ essais: 2, derniereErreur: "HTTP 500" });
  expect(await reporterJob(sql, j2!, "HTTP 502", 0)).toBe("echec");
  expect(await lireJob(sql, id)).toMatchObject({ statut: "echec", derniereErreur: "HTTP 502" });
});

test("clé de dédoublonnage et job système hors tenant", async () => {
  const a = await avecWorker(sql, (tx) => enfiler(tx, "relances.planifier", {}, { cle: "relances:2026-10-22" }));
  const b = await avecWorker(sql, (tx) => enfiler(tx, "relances.planifier", {}, { cle: "relances:2026-10-22" }));
  expect(a).not.toBeNull();
  expect(b).toBeNull();
  expect((await lireJob(sql, a!))?.tenantId).toBeNull();
});

test("marquage livré et échec de l'outbox", async () => {
  const { id } = await withTenant(sql, A, (tx) => ajouterEvenement(tx, "absence.decidee", {}));
  await noterLivraison(sql, id, "HTTP 503");
  expect(await lireEvenement(sql, id)).toMatchObject({ statut: "a_livrer", essais: 1, derniereErreur: "HTTP 503" });
  await noterLivraison(sql, id, null);
  const e = await lireEvenement(sql, id);
  expect(e).toMatchObject({ statut: "livre", essais: 2, derniereErreur: null });
  expect(e?.livreAt).not.toBeNull();
  // Un échec définitif tardif ne déclasse pas un événement livré.
  await noterLivraison(sql, id, "abandon", true);
  expect((await lireEvenement(sql, id))?.statut).toBe("livre");
});

test("délai exponentiel plafonné", () => {
  expect([1, 2, 3, 4].map((n) => delaiNouvelEssai(n, 100))).toEqual([100, 200, 400, 800]);
  expect(delaiNouvelEssai(40)).toBe(3_600_000);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Document } from "@auto/domain";
import type { Evenement } from "@auto/services";
import { creerBrouillon, emettre, listerEvenements, testDb, withTenant, type Sql } from "@auto/store";
import { declencher, jourLocal, moisPrecedent, planifier, TACHES, tachesPlanifiees } from "./planification";
import { creerWorker } from "./worker";

let sql: Sql;
let drop: () => Promise<void>;
let A: string;
let B: string;

const jour = (decalage: number) => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
const facture = (echeance: string): Document => ({
  type: "facture",
  date: jour(-40),
  emetteur: { nom: "ACME", siret: "73282932000074", adresse: "1 rue A", tvaIntracom: "FR44732829320" },
  client: { nom: "Client", siret: "73282932000074", adresse: "2 rue B", email: "compta@client.fr" },
  lignes: [{ designation: "A", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
  datePrestation: jour(-41),
  echeance,
  penalitesRetard: "3 fois le taux d'intérêt légal",
  escompte: "aucun",
});

const tache = (nom: string) => TACHES.find((t) => t.nom === nom)!;
const evenements = async (tenant: string, type: string) =>
  (await withTenant(sql, tenant, (tx) => listerEvenements(tx)))
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.corps) as Evenement & { data: Record<string, unknown> });

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('A', '732829320', '73282932000074'), ('B', '732829320', '73282932000074')
    RETURNING id`;
  [A, B] = rows.map((r) => r.id) as [string, string];
});

afterAll(() => drop());

test("dates locales et expressions cron valides", () => {
  expect(jourLocal(new Date("2026-10-21T23:30:00Z"), "Europe/Paris")).toBe("2026-10-22");
  expect(moisPrecedent("2026-01-01")).toBe("2025-12");
  expect(moisPrecedent("2026-10-01")).toBe("2026-09");
  for (const t of TACHES) expect(Bun.cron.parse(t.cron, Date.now(), { tz: "Europe/Paris" })).toBeInstanceOf(Date);
  const crons = planifier(sql);
  expect(crons.map((c) => c.cron)).toEqual(TACHES.map((t) => t.cron));
  for (const c of crons) c.stop();
});

test("relances : J+7 puis J+30, événement relance.a_envoyer par tenant, sans doublon", async () => {
  const f = await withTenant(sql, A, (tx) =>
    creerBrouillon(tx, null, facture(jour(-10))).then((d) => emettre(tx, null, d.id)),
  );
  const w = creerWorker(sql, tachesPlanifiees(sql), { delai: () => 0 });

  const t = tache("relances");
  expect(await declencher(sql, t)).not.toBeNull();
  expect(await declencher(sql, t)).toBeNull(); // même jour : un seul job
  await w.vider();
  const r1 = await evenements(A, "relance.a_envoyer");
  expect(r1.map((e) => e.data)).toEqual([
    expect.objectContaining({
      documentId: f.id,
      numero: f.numero,
      niveau: 1,
      resteCents: 12000,
      jour: jourLocal(new Date()),
    }),
  ]);
  expect((r1[0]!.data.client as { email: string }).email).toBe("compta@client.fr");
  expect(await evenements(B, "relance.a_envoyer")).toEqual([]);

  // Lendemain : le palier 1 déjà envoyé n'est pas renvoyé.
  await declencher(sql, t, new Date(Date.now() + 86_400_000));
  await w.vider();
  expect((await evenements(A, "relance.a_envoyer")).length).toBe(1);

  // 25 jours plus tard (J+35) : palier 2.
  await declencher(sql, t, new Date(Date.now() + 25 * 86_400_000));
  await w.vider();
  expect((await evenements(A, "relance.a_envoyer")).map((e) => e.data.niveau).sort()).toEqual([1, 2]);
});

test("export mensuel : récapitulatif du mois précédent, tenants sans activité ignorés", async () => {
  const mois = new Date().toISOString().slice(0, 7);
  const [a, m] = mois.split("-").map(Number) as [number, number];
  const premierDuMoisSuivant = new Date(Date.UTC(a, m, 1, 12));
  expect(await declencher(sql, tache("export-mensuel"), premierDuMoisSuivant)).not.toBeNull();
  await creerWorker(sql, tachesPlanifiees(sql)).vider();
  const [e] = await evenements(A, "export.mensuel");
  expect(e?.data).toEqual({
    mois,
    parType: [{ type: "facture", nombre: 1, htCents: 10000, tvaCents: 2000, ttcCents: 12000 }],
  });
  expect(await evenements(B, "export.mensuel")).toEqual([]);
});

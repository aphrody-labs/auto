import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Employe } from "@auto/domain";
import {
  creerEmploye,
  deciderAbsence,
  demanderAbsence,
  listerAbsences,
  listerEmployes,
  modifierEmploye,
  soldeConges,
  testDb,
  withTenant,
  type Sql,
} from "./index";

let sql: Sql;
let drop: () => Promise<void>;
let A: string;
let B: string;

const lea: Employe = {
  nom: "Martin",
  prenom: "Léa",
  email: "lea@exemple.fr",
  poste: "Assistante administrative",
  contrat: "cdi",
  dateEntree: "2025-01-06",
  tempsTravail: 100,
  salaireBrutMensuelCents: 220000,
};

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('A', '732829320', '73282932000074'), ('B', '732829320', '73282932000074')
    RETURNING id`;
  [A, B] = rows.map((r) => r.id) as [string, string];
});

afterAll(() => drop());

test("employé : création, modification, isolation entre tenants", async () => {
  const e = await withTenant(sql, A, (tx) => creerEmploye(tx, null, lea));
  expect(e.dateEntree).toBe("2025-01-06");
  const m = await withTenant(sql, A, (tx) => modifierEmploye(tx, null, e.id, { ...lea, poste: "Office manager" }));
  expect(m.poste).toBe("Office manager");
  expect(await withTenant(sql, B, (tx) => listerEmployes(tx, true))).toHaveLength(0);
  await expect(withTenant(sql, B, (tx) => modifierEmploye(tx, null, e.id, lea))).rejects.toThrow("employé introuvable");
  await expect(withTenant(sql, A, (tx) => creerEmploye(tx, null, { ...lea, contrat: "cdd" }))).rejects.toThrow(
    "employé invalide",
  );
});

test("congés payés : solde, chevauchement, validation, annulation", async () => {
  const e = await withTenant(sql, A, (tx) => creerEmploye(tx, null, { ...lea, prenom: "Paul" }));
  // période 2026-06-01 : 4 mois entiers au 2026-10-01 → 10 jours acquis
  expect(await withTenant(sql, A, (tx) => soldeConges(tx, e.id, "2026-10-01"))).toEqual({
    periode: "2026-06-01",
    acquis: 10,
    pris: 0,
    demandes: 0,
    disponible: 10,
  });
  const cp = await withTenant(sql, A, (tx) =>
    demanderAbsence(tx, null, e.id, { type: "conges_payes", debut: "2026-10-05", fin: "2026-10-10" }),
  );
  expect(cp.joursOuvrables).toBe(6);
  await expect(
    withTenant(sql, A, (tx) =>
      demanderAbsence(tx, null, e.id, { type: "rtt", debut: "2026-10-09", fin: "2026-10-09" }),
    ),
  ).rejects.toThrow("couvre déjà");
  await expect(
    withTenant(sql, A, (tx) =>
      demanderAbsence(tx, null, e.id, { type: "conges_payes", debut: "2026-10-12", fin: "2026-10-17" }),
    ),
  ).rejects.toThrow("solde de congés insuffisant");
  await withTenant(sql, A, (tx) => deciderAbsence(tx, null, cp.id, "validee"));
  expect((await withTenant(sql, A, (tx) => soldeConges(tx, e.id, "2026-10-12"))).pris).toBe(6);
  await expect(withTenant(sql, A, (tx) => deciderAbsence(tx, null, cp.id, "refusee"))).rejects.toThrow("interdite");
  await withTenant(sql, A, (tx) => deciderAbsence(tx, null, cp.id, "annulee"));
  expect((await withTenant(sql, A, (tx) => soldeConges(tx, e.id, "2026-10-12"))).disponible).toBe(10);
  expect(await withTenant(sql, A, (tx) => listerAbsences(tx, { employeId: e.id, statut: "annulee" }))).toHaveLength(1);
  expect(await withTenant(sql, B, (tx) => listerAbsences(tx))).toHaveLength(0);
});

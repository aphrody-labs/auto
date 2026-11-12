import { afterAll, beforeAll, expect, test } from "bun:test";
import { avoirPartiel, avoirTotal, type Document } from "@auto/domain";
import {
  aRelancer,
  creerBrouillon,
  creerClient,
  emettre,
  enregistrerPaiement,
  lire,
  listerClients,
  listerPaiements,
  marquerRelance,
  resteDu,
  testDb,
  withTenant,
  type Sql,
  type Tx,
} from "./index";

let sql: Sql;
let drop: () => Promise<void>;
let A: string;
let B: string;

const emetteur = { nom: "ACME", siret: "73282932000074", adresse: "1 rue A", tvaIntracom: "FR44732829320" };
const base: Document = {
  type: "facture",
  date: "2026-10-01",
  emetteur,
  client: { nom: "Client", siret: "73282932000074", adresse: "2 rue B" },
  lignes: [
    { designation: "A", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 },
    { designation: "B", quantite: 2, prixUnitaireHtCents: 5000, tva: 200 },
  ],
  datePrestation: "2026-09-30",
  echeance: "2026-10-31",
  penalitesRetard: "3 fois le taux d'intérêt légal",
  escompte: "aucun",
};

const emise = (tx: Tx, doc: Document = base) => creerBrouillon(tx, null, doc).then((d) => emettre(tx, null, d.id));

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('A', '732829320', '73282932000074'), ('B', '732829320', '73282932000074')
    RETURNING id`;
  [A, B] = rows.map((r) => r.id) as [string, string];
});

afterAll(() => drop());

test("paiements partiels puis solde : statut payé, trop-perçu refusé", async () => {
  const f = await withTenant(sql, A, (tx) => emise(tx));
  expect(f.ttcCents).toBe(24000);
  const p1 = await withTenant(sql, A, (tx) =>
    enregistrerPaiement(tx, null, f.id, { date: "2026-10-10", montantCents: 10000, mode: "virement" }),
  );
  expect(p1.resteCents).toBe(14000);
  await expect(
    withTenant(sql, A, (tx) =>
      enregistrerPaiement(tx, null, f.id, { date: "2026-10-11", montantCents: 14001, mode: "carte" }),
    ),
  ).rejects.toThrow("supérieur au reste");
  const p2 = await withTenant(sql, A, (tx) =>
    enregistrerPaiement(tx, null, f.id, {
      date: "2026-10-12",
      montantCents: 14000,
      mode: "cheque",
      reference: "CHQ 42",
    }),
  );
  expect(p2.resteCents).toBe(0);
  expect((await withTenant(sql, A, (tx) => lire(tx, f.id)))!.statut).toBe("paye");
  expect(await withTenant(sql, A, (tx) => listerPaiements(tx, f.id))).toHaveLength(2);
  expect(await withTenant(sql, B, (tx) => listerPaiements(tx, f.id))).toHaveLength(0);
  await expect(withTenant(sql, A, (tx) => tx`DELETE FROM paiement`)).rejects.toThrow();
});

test("avoirs partiels : reste dû réduit, dépassement refusé, avoir soldant annule la facture", async () => {
  const f = await withTenant(sql, A, (tx) => emise(tx));
  const partiel = avoirPartiel(base, f.numero!, "2026-10-05", [base.lignes[1]!]);
  const a1 = await withTenant(sql, A, (tx) => emise(tx, partiel));
  expect(a1.numero).toMatch(/^A-2026-/);
  expect((await withTenant(sql, A, (tx) => resteDu(tx, f.id))).resteCents).toBe(12000);
  await expect(withTenant(sql, A, (tx) => emise(tx, avoirTotal(base, f.numero!, "2026-10-06")))).rejects.toThrow(
    "supérieur au reste",
  );
  await withTenant(sql, A, (tx) => emise(tx, avoirPartiel(base, f.numero!, "2026-10-07", [base.lignes[0]!])));
  expect((await withTenant(sql, A, (tx) => lire(tx, f.id)))!.statut).toBe("annule");
  // Facture d'un autre tenant : introuvable.
  const fb = await withTenant(sql, B, (tx) => emise(tx, { ...base, date: "2027-01-05" }));
  await expect(withTenant(sql, A, (tx) => emise(tx, avoirTotal(base, fb.numero!, "2026-10-08")))).rejects.toThrow(
    "introuvable",
  );
});

test("relances aux paliers J+7, J+30, J+60, une seule fois par palier", async () => {
  const [{ id: C }] = (await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('C', '732829320', '73282932000074') RETURNING id`) as unknown as [
    { id: string },
  ];
  const f = await withTenant(sql, C, (tx) => emise(tx, { ...base, echeance: "2026-10-01" }));
  await withTenant(sql, C, (tx) => emise(tx, { ...base, echeance: "2026-12-31" }));
  expect(await withTenant(sql, C, (tx) => aRelancer(tx, "2026-10-05"))).toEqual([]);
  const r1 = await withTenant(sql, C, (tx) => aRelancer(tx, "2026-10-08"));
  expect(r1.map((r) => [r.numero, r.niveau, r.joursRetard, r.resteCents])).toEqual([[f.numero!, 1, 7, 24000]]);
  await withTenant(sql, C, (tx) => marquerRelance(tx, null, f.id, 1, "mail"));
  expect(await withTenant(sql, C, (tx) => aRelancer(tx, "2026-10-20"))).toEqual([]);
  expect((await withTenant(sql, C, (tx) => aRelancer(tx, "2026-11-15")))[0]!.niveau).toBe(2);
  await withTenant(sql, C, (tx) =>
    enregistrerPaiement(tx, null, f.id, { date: "2026-11-16", montantCents: 24000, mode: "virement" }),
  );
  expect(await withTenant(sql, C, (tx) => aRelancer(tx, "2026-12-15"))).toEqual([]);
  expect(await withTenant(sql, A, (tx) => aRelancer(tx, "2026-12-15"))).not.toContainEqual(
    expect.objectContaining({ documentId: f.id }),
  );
});

test("clients enregistrés isolés et liés au document", async () => {
  const c = await withTenant(sql, A, (tx) =>
    creerClient(tx, null, { nom: "Dupont SARL", siret: "73282932000074", adresse: "3 rue C", email: "a@b.fr" }),
  );
  expect(await withTenant(sql, A, (tx) => listerClients(tx, "dup"))).toHaveLength(1);
  expect(await withTenant(sql, B, (tx) => listerClients(tx))).toHaveLength(0);
  const d = await withTenant(sql, A, (tx) => creerBrouillon(tx, null, base, c.id));
  expect(d.clientId).toBe(c.id);
  await expect(withTenant(sql, B, (tx) => creerBrouillon(tx, null, base, c.id))).rejects.toThrow("document_client_fk");
  // Référence directe à un document d'un autre tenant : refusée par la base elle-même.
  const fa = await withTenant(sql, A, (tx) => emise(tx));
  await expect(
    withTenant(
      sql,
      B,
      (tx) =>
        tx`INSERT INTO paiement (document_id, date, montant_cents, mode) VALUES (${fa.id}, '2026-10-01', 1, 'autre')`,
    ),
  ).rejects.toThrow();
  await expect(
    withTenant(sql, B, (tx) => tx`INSERT INTO relance (document_id, niveau, canal) VALUES (${fa.id}, 1, 'mail')`),
  ).rejects.toThrow();
  await expect(
    withTenant(sql, A, (tx) => creerClient(tx, null, { nom: "", siret: "", adresse: "" })),
  ).rejects.toThrow();
});

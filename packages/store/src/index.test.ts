import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Document } from "@auto/domain";
import {
  changerStatut,
  creerBrouillon,
  emettre,
  enregistrerFichier,
  lireFichier,
  lister,
  modifierBrouillon,
  testDb,
  verifierAudit,
  withTenant,
  type Sql,
} from "./index";

let sql: Sql;
let drop: () => Promise<void>;
let A: string;
let B: string;

const emetteur = { nom: "ACME", siret: "73282932000074", adresse: "1 rue A", tvaIntracom: "FR44732829320" };
const facture: Document = {
  type: "facture",
  date: "2026-10-22",
  emetteur,
  client: { nom: "Client", siret: "73282932000074", adresse: "2 rue B" },
  lignes: [{ designation: "Prestation", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
  datePrestation: "2026-10-20",
  echeance: "2026-11-21",
  penalitesRetard: "3 fois le taux d'intérêt légal",
  escompte: "aucun",
};

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('A', '732829320', '73282932000074'), ('B', '732829320', '73282932000074') RETURNING id`;
  [A, B] = rows.map((r) => r.id) as [string, string];
});

afterAll(() => drop());

test("brouillon sans numéro, émission numérotée", async () => {
  const d = await withTenant(sql, A, (tx) => creerBrouillon(tx, null, facture));
  expect(d.numero).toBeNull();
  expect(d.ttcCents).toBe(12000);
  const e = await withTenant(sql, A, (tx) => emettre(tx, null, d.id));
  expect(e.numero).toBe("F-2026-0001");
  expect(e.statut).toBe("emis");
});

test("mentions manquantes : émission refusée", async () => {
  const d = await withTenant(sql, A, (tx) => creerBrouillon(tx, null, { ...facture, echeance: undefined }));
  await expect(withTenant(sql, A, (tx) => emettre(tx, null, d.id))).rejects.toThrow("mentions obligatoires manquantes");
});

test("document émis figé", async () => {
  const d = await withTenant(sql, A, async (tx) => emettre(tx, null, (await creerBrouillon(tx, null, facture)).id));
  await expect(withTenant(sql, A, (tx) => modifierBrouillon(tx, null, d.id, facture))).rejects.toThrow(
    "brouillon introuvable",
  );
  await expect(withTenant(sql, A, (tx) => tx`UPDATE document SET data = '{}' WHERE id = ${d.id}`)).rejects.toThrow(
    "modification interdite",
  );
  await expect(withTenant(sql, A, (tx) => tx`DELETE FROM document WHERE id = ${d.id}`)).rejects.toThrow();
  const p = await withTenant(sql, A, (tx) => changerStatut(tx, null, d.id, "paye"));
  expect(p.statut).toBe("paye");
  await expect(withTenant(sql, A, (tx) => changerStatut(tx, null, d.id, "annule"))).rejects.toThrow("interdite");
});

test("isolation entre tenants", async () => {
  const docB = await withTenant(sql, B, (tx) => creerBrouillon(tx, null, facture));
  const vusParA = await withTenant(sql, A, (tx) => lister(tx));
  expect(vusParA.some((d) => d.id === docB.id)).toBe(false);
  expect(await withTenant(sql, A, (tx) => tx`SELECT id FROM tenant`)).toHaveLength(1);
  // Écriture forcée vers un autre tenant : refusée par la politique WITH CHECK.
  await expect(
    withTenant(sql, A, (tx) => tx`INSERT INTO client (tenant_id, nom, adresse) VALUES (${B}, 'x', 'y')`),
  ).rejects.toThrow();
  // Sans tenant posé : aucune ligne.
  const rien = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE auto_app`;
    return tx`SELECT id FROM document`;
  });
  expect(rien).toHaveLength(0);
  // Numérotation indépendante par tenant.
  const e = await withTenant(sql, B, (tx) => emettre(tx, null, docB.id));
  expect(e.numero).toBe("F-2026-0001");
});

test("100 émissions concurrentes : numéros continus sans doublon", async () => {
  const [{ id: C }] = (await sql<
    { id: string }[]
  >`INSERT INTO tenant (nom, siren, siret) VALUES ('C', '732829320', '73282932000074') RETURNING id`) as unknown as [
    { id: string },
  ];
  const ids = await withTenant(sql, C, async (tx) => {
    const out: string[] = [];
    for (let i = 0; i < 100; i++) out.push((await creerBrouillon(tx, null, facture)).id);
    return out;
  });
  const emis = await Promise.all(ids.map((id) => withTenant(sql, C, (tx) => emettre(tx, null, id))));
  const seqs = emis.map((d) => Number(d.numero!.slice(-4))).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
});

test("piste d'audit chaînée", async () => {
  const r = await withTenant(sql, A, (tx) => verifierAudit(tx));
  expect(r.ok).toBe(true);
  expect(r.entrees).toBeGreaterThan(5);
  await expect(withTenant(sql, A, (tx) => tx`DELETE FROM audit`)).rejects.toThrow();
});

test("fichier figé : immuable et isolé", async () => {
  const d = await withTenant(sql, A, async (tx) => emettre(tx, null, (await creerBrouillon(tx, null, facture)).id));
  const octets = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const sha = await withTenant(sql, A, (tx) => enregistrerFichier(tx, null, d.id, "facturx", octets));
  const lu = await withTenant(sql, A, (tx) => lireFichier(tx, d.id, "facturx"));
  expect(lu!.contenu).toEqual(octets);
  expect(lu!.sha256).toBe(sha);
  expect(await withTenant(sql, B, (tx) => lireFichier(tx, d.id, "facturx"))).toBeNull();
  await expect(withTenant(sql, A, (tx) => tx`UPDATE fichier SET taille = 0`)).rejects.toThrow();
  await expect(withTenant(sql, A, (tx) => enregistrerFichier(tx, null, d.id, "facturx", octets))).rejects.toThrow();
});

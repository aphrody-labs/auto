import { afterAll, beforeAll, expect, test } from "bun:test";
import { envoyeurMemoire } from "@auto/mail";
import { listerEvenements, majAbonnement, testDb, withTenant, type Sql } from "@auto/store";
import { jourPlus, rappelerRenouvellement } from "./renouvellement";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
});
afterAll(() => drop());

const JOUR = "2026-10-23";
/** Échéance à midi (Paris), `n` jours après JOUR. */
const echeance = (n: number) => new Date(`${jourPlus(JOUR, n)}T10:00:00Z`).toISOString();

async function entreprise(email: string) {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO tenant (nom, siren, siret) VALUES ('Atelier', '732829320', '73282932000074') RETURNING id`;
  const [u] = await sql<
    { id: string }[]
  >`INSERT INTO app_user (email, name) VALUES (${email}, 'propriétaire') RETURNING id`;
  await sql`INSERT INTO membership (tenant_id, user_id, role) VALUES (${t!.id}, ${u!.id}, 'owner')`;
  return t!.id;
}

const types = async (tenant: string) =>
  (await withTenant(sql, tenant, (tx) => listerEvenements(tx))).map((e) => e.type);

test("rappel sept jours avant le renouvellement : événement et e-mail au propriétaire", async () => {
  const t = await entreprise("owner@atelier.fr");
  await withTenant(sql, t, (tx) =>
    majAbonnement(tx, { plan: "pro", periodicite: "mensuel", statut: "active", periodeFin: echeance(7) }),
  );
  const envoyeur = envoyeurMemoire();
  const r = await rappelerRenouvellement(sql, t, JOUR, { envoyeur, urlApp: "https://auto.exemple" });
  expect(r).toMatchObject({ plan: "pro", essai: false, montantHtCents: 1400 });
  expect(await types(t)).toContain("abonnement.renouvellement_proche");
  expect(envoyeur.envoyes).toHaveLength(1);
  const m = envoyeur.envoyes[0]!;
  expect(m.a).toEqual(["owner@atelier.fr"]);
  expect(m.sujet).toBe("Votre abonnement auto sera renouvelé le 30 octobre 2026");
  expect(m.texte).toMatch(/14,00\s€ HT/);
  expect(m.texte).toContain("https://auto.exemple/app/parametres");

  // La veille ou le lendemain : rien.
  for (const j of ["2026-10-22", "2026-10-24"])
    expect(await rappelerRenouvellement(sql, t, j, { envoyeur })).toBeNull();
  expect(envoyeur.envoyes).toHaveLength(1);
});

test("essai, résiliation programmée et offre gratuite", async () => {
  const essai = await entreprise("essai@atelier.fr");
  await withTenant(sql, essai, (tx) =>
    majAbonnement(tx, { plan: "business", periodicite: "annuel", statut: "trialing", essaiFin: echeance(7) }),
  );
  const envoyeur = envoyeurMemoire();
  expect(await rappelerRenouvellement(sql, essai, JOUR, { envoyeur })).toMatchObject({
    essai: true,
    montantHtCents: 39000,
  });
  expect(envoyeur.envoyes[0]!.sujet).toBe("Votre essai auto se termine le 30 octobre 2026");

  const resilie = await entreprise("resilie@atelier.fr");
  await withTenant(sql, resilie, (tx) =>
    majAbonnement(tx, { plan: "pro", statut: "active", periodeFin: echeance(7), annulationFinPeriode: true }),
  );
  const gratuit = await entreprise("gratuit@atelier.fr");
  for (const t of [resilie, gratuit]) {
    expect(await rappelerRenouvellement(sql, t, JOUR, { envoyeur })).toBeNull();
    expect(await types(t)).not.toContain("abonnement.renouvellement_proche");
  }
  expect(envoyeur.envoyes).toHaveLength(1);
});

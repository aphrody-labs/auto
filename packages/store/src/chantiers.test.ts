import { afterAll, beforeAll, expect, test } from "bun:test";
import { avoirTotal, type Document } from "@auto/domain";
import type { FactureRecue } from "@auto/ingest";
import {
  affecterAchat,
  affecterDocument,
  creerBrouillon,
  creerClient,
  dossierChantier,
  emettre,
  enregistrerChantier,
  enregistrerFournisseur,
  enregistrerPiece,
  listerChantiers,
  listerFournisseurs,
  listerPieces,
  lire,
  testDb,
  verifierAudit,
  executerSuppression,
  purgerTenant,
  withTenant,
  type Sql,
  type Tx,
  enregistrerRecue,
  type Chantier,
  type Fournisseur,
} from "./index";
import { verifierChantier, verifierFournisseur, verifierPiece } from "./chantiers";
let sql: Sql, drop: () => Promise<void>, A: string, B: string;
const partie = { nom: "Client test", siret: "73282932000074", adresse: "2 rue B", tvaIntracom: "FR44732829320" };
const base: Document = {
  type: "facture",
  date: "2026-10-24",
  emetteur: partie,
  client: partie,
  lignes: [{ designation: "Maçonnerie", quantite: 1, prixUnitaireHtCents: 100000, tva: 200 }],
  datePrestation: "2026-10-24",
  echeance: "2026-11-24",
  penalitesRetard: "3 fois le taux légal",
  escompte: "aucun",
};
const fournisseur = {
  nom: "Matériaux test",
  adresse: "1 rue A",
  siret: "",
  email: "contact@exemple.fr",
  telephone: "",
  contact: "",
  notes: "",
  archive: false,
};
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const r =
    await sql`INSERT INTO tenant (nom,siren,siret) VALUES ('Chantier A','732829320','73282932000074'),('Chantier B','732829320','73282932000074') RETURNING id`;
  A = r[0].id;
  B = r[1].id;
});
afterAll(async () => {
  if (drop) await drop();
});
async function preparer(tx: Tx) {
  const client = await creerClient(tx, null, partie);
  const f = await enregistrerFournisseur(tx, null, fournisseur);
  const c = await enregistrerChantier(tx, null, {
    nom: "Villa test",
    code: crypto.randomUUID(),
    clientId: client.id,
    adresse: "1 rue A",
    budgetHtCents: 200000,
    avancement: 25,
    statut: "en_cours",
    debut: "2026-10-01",
    fin: "2026-12-01",
    notes: "",
    archive: false,
  });
  return { client, f, c };
}
const piece = (f: Fournisseur, c: Chantier) => ({
  type: "confirmation_commande",
  reference: crypto.randomUUID(),
  fournisseurId: f.id,
  chantierId: c.id,
  recueId: null,
  date: "2026-10-24",
  statut: "valide",
  lignes: [{ designation: "Matériaux", quantite: 2, prixUnitaireHtCents: 15000, tva: 200 }],
  notes: "",
  archive: false,
});
async function achat(
  tx: Tx,
  statut: "validee" | "a_verifier" = "validee",
  devise = "EUR",
  type: FactureRecue["type"] = "facture",
) {
  const facture: FactureRecue = {
    type,
    numero: crypto.randomUUID(),
    date: "2026-10-24",
    devise,
    fournisseur: { nom: fournisseur.nom },
    lignes: [],
    totaux: { htCents: 30000, tvaCents: 6000, ttcCents: 36000 },
  };
  return enregistrerRecue(
    tx,
    null,
    { contenu: new TextEncoder().encode(crypto.randomUUID()), typeMime: "application/pdf", canal: "api" },
    { source: "facturx", statut, facture, anomalies: [] },
  );
}
test("validations : dates réelles, centimes entiers, TVA et identifiants", () => {
  expect(() => verifierFournisseur({ ...fournisseur, siret: "123" })).toThrow("SIRET");
  expect(() => verifierFournisseur({ ...fournisseur, email: "non" })).toThrow("e-mail");
  expect(() =>
    verifierChantier({
      nom: "A",
      code: "A",
      clientId: crypto.randomUUID(),
      budgetHtCents: 0.5,
      avancement: 0,
      statut: "en_cours",
    }),
  ).toThrow("budget");
  expect(() =>
    verifierPiece({
      ...piece({ id: crypto.randomUUID() } as Fournisseur, { id: crypto.randomUUID() } as Chantier),
      date: "2026-02-30",
    }),
  ).toThrow("date");
  expect(() =>
    verifierPiece({
      ...piece({ id: crypto.randomUUID() } as Fournisseur, { id: crypto.randomUUID() } as Chantier),
      lignes: [],
    }),
  ).toThrow("lignes");
});
test("répertoires persistants, archives et isolation des cinq tables", async () => {
  const x = await withTenant(sql, A, preparer);
  const p = await withTenant(sql, A, (tx) => enregistrerPiece(tx, null, piece(x.f, x.c)));
  await withTenant(sql, A, (tx) => enregistrerFournisseur(tx, null, { ...x.f, archive: true }, x.f.id));
  expect((await withTenant(sql, A, listerFournisseurs)).find((f) => f.id === x.f.id)?.archive).toBe(true);
  expect(await withTenant(sql, B, listerFournisseurs)).toHaveLength(0);
  expect(await withTenant(sql, B, listerChantiers)).toHaveLength(0);
  expect(await withTenant(sql, B, listerPieces)).toHaveLength(0);
  await expect(withTenant(sql, B, (tx) => dossierChantier(tx, x.c.id))).rejects.toThrow("introuvable");
  await expect(withTenant(sql, B, (tx) => enregistrerPiece(tx, null, { ...p, reference: "INTERDIT" }))).rejects.toThrow(
    "introuvable",
  );
  await expect(
    withTenant(
      sql,
      B,
      (tx) =>
        tx`INSERT INTO achat_affectation (recue_id,fournisseur_id,chantier_id) VALUES (${crypto.randomUUID()},${x.f.id},${x.c.id})`,
    ),
  ).rejects.toThrow();
});
test("une facture émise reste figée après affectation ; incohérence client refusée", async () => {
  const x = await withTenant(sql, A, preparer);
  const doc = await withTenant(sql, A, async (tx) =>
    emettre(tx, null, (await creerBrouillon(tx, null, base, x.client.id)).id),
  );
  await withTenant(sql, A, (tx) => affecterDocument(tx, null, doc.id, x.c.id));
  expect((await withTenant(sql, A, (tx) => lire(tx, doc.id)))?.data).toEqual(base);
  const autre = await withTenant(sql, A, preparer);
  await expect(withTenant(sql, A, (tx) => affecterDocument(tx, null, doc.id, autre.c.id))).rejects.toThrow("client");
  await expect(withTenant(sql, B, (tx) => affecterDocument(tx, null, doc.id, x.c.id))).rejects.toThrow("introuvable");
});
test("analytique : brouillons et devis exclus, commandes séparées, achats rejetés ou non EUR exclus", async () => {
  const x = await withTenant(sql, A, preparer);
  const resultat = await withTenant(sql, A, async (tx) => {
    for (const type of ["facture", "devis", "facture"] as const) {
      const d = await creerBrouillon(tx, null, { ...base, type }, x.client.id);
      await affecterDocument(tx, null, d.id, x.c.id);
      if (type === "devis" || (await dossierChantier(tx, x.c.id)).analytique.ventesHtCents === 0)
        await emettre(tx, null, d.id);
    }
    const r = await achat(tx);
    await affecterAchat(tx, null, r.id, x.f.id, x.c.id);
    const nonValide = await achat(tx, "a_verifier");
    await affecterAchat(tx, null, nonValide.id, x.f.id, x.c.id);
    const dollars = await achat(tx, "validee", "USD");
    await affecterAchat(tx, null, dollars.id, x.f.id, x.c.id);
    await enregistrerPiece(tx, null, piece(x.f, x.c));
    await enregistrerPiece(tx, null, { ...piece(x.f, x.c), type: "bon_livraison" });
    return dossierChantier(tx, x.c.id);
  });
  expect(resultat.analytique).toMatchObject({
    ventesHtCents: 100000,
    achatsHtCents: 30000,
    soldeHtCents: 70000,
    commandesHtCents: 30000,
    achatsAffectes: 3,
    achatsNonChiffres: 1,
  });
});
test("rapprochement : pas de double compte, même fournisseur et chantier, archives neutres", async () => {
  const x = await withTenant(sql, A, preparer);
  const r = await withTenant(sql, A, achat);
  const p = await withTenant(sql, A, (tx) =>
    enregistrerPiece(tx, null, { ...piece(x.f, x.c), recueId: r.id, archive: true }),
  );
  expect((await withTenant(sql, A, (tx) => dossierChantier(tx, x.c.id))).analytique).toMatchObject({
    achatsHtCents: 30000,
    commandesHtCents: 0,
  });
  const autre = await withTenant(sql, A, preparer);
  await expect(withTenant(sql, A, (tx) => affecterAchat(tx, null, r.id, autre.f.id, autre.c.id))).rejects.toThrow(
    "pièces rapprochées",
  );
  await expect(
    withTenant(sql, A, (tx) => enregistrerPiece(tx, null, { ...p, reference: "autre", fournisseurId: autre.f.id })),
  ).rejects.toThrow("autre fournisseur");
  expect((await withTenant(sql, A, verifierAudit)).ok).toBe(true);
});
test("avoir total non affecté : suit la facture et annule son montant analytique", async () => {
  const x = await withTenant(sql, A, preparer);
  await withTenant(sql, A, async (tx) => {
    const d = await emettre(tx, null, (await creerBrouillon(tx, null, base, x.client.id)).id);
    await affecterDocument(tx, null, d.id, x.c.id);
    const a = await creerBrouillon(tx, null, avoirTotal(base, d.numero!, "2026-10-24"), x.client.id);
    await emettre(tx, null, a.id);
  });
  expect((await withTenant(sql, A, (tx) => dossierChantier(tx, x.c.id))).analytique.ventesHtCents).toBe(0);
});
test("codes et références concurrentes : une seule création acceptée", async () => {
  const x = await withTenant(sql, A, preparer);
  const code = crypto.randomUUID();
  const results = await Promise.allSettled(
    [1, 2].map(() => withTenant(sql, A, (tx) => enregistrerChantier(tx, null, { ...x.c, code }))),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const p = piece(x.f, x.c);
  const pieces = await Promise.allSettled([1, 2].map(() => withTenant(sql, A, (tx) => enregistrerPiece(tx, null, p))));
  expect(pieces.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

test("conservation et purge : achats et pièces seuls conservent aussi le dossier", async () => {
  const [t] =
    await sql`INSERT INTO tenant (nom,siren,siret) VALUES ('Conservation chantier','732829320','73282932000074') RETURNING id`;
  const x = await withTenant(sql, t.id, preparer);
  await withTenant(sql, t.id, async (tx) => {
    const r = await achat(tx);
    await affecterAchat(tx, null, r.id, x.f.id, x.c.id);
    await enregistrerPiece(tx, null, { ...piece(x.f, x.c), recueId: r.id });
  });
  const resultat = await executerSuppression(sql, t.id);
  expect(resultat.conservationJusqua).toBe("2036-12-31");
  expect((await withTenant(sql, t.id, (tx) => dossierChantier(tx, x.c.id))).achats).toHaveLength(1);
  await sql`UPDATE tenant SET conservation_jusqua=current_date-1 WHERE id=${t.id}`;
  await purgerTenant(sql, t.id);
  expect(await sql`SELECT id FROM tenant WHERE id=${t.id}`).toHaveLength(0);
});

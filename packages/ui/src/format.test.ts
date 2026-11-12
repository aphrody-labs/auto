import { expect, test } from "bun:test";
import { totaux } from "@auto/domain";
import {
  ajouterJours,
  bornesMois,
  dateFr,
  depuisCentimes,
  emailValide,
  erreursLigne,
  eur,
  grouperSiret,
  htLigneSaisie,
  indicateurs,
  jours,
  libelleStatut,
  moisFr,
  octets,
  statutVisuel,
  tauxTva,
  versCentimes,
  versLigne,
  versPointsDeBase,
  versQuantite,
  type DocResume,
} from "./format";

// Espaces de la locale fr-FR : insécable fine (U+202F) pour les milliers, insécable (U+00A0) avant « € ».
const sans = (s: string) => s.replace(/[  ]/g, " ");

test("montants : Intl fr-FR, centimes entiers, négatifs", () => {
  expect(sans(eur(123456))).toBe("1 234,56 €");
  expect(sans(eur(0))).toBe("0,00 €");
  expect(sans(eur(-4000))).toBe("-40,00 €");
  expect(eur(100)).toMatch(/ €$/);
});

test("saisie des montants → centimes", () => {
  expect(versCentimes("1 234,56")).toBe(123456);
  expect(versCentimes("1234.5")).toBe(123450);
  expect(versCentimes("12 €")).toBe(1200);
  expect(versCentimes("0,1")).toBe(10);
  expect(versCentimes("1,234")).toBeNull();
  expect(versCentimes("-5")).toBeNull();
  expect(versCentimes("abc")).toBeNull();
  expect(versCentimes("")).toBeNull();
  expect(depuisCentimes(123450)).toBe("1234,50");
  expect(depuisCentimes(1200)).toBe("12");
});

test("remises, quantités et taux de TVA", () => {
  expect(versPointsDeBase("10")).toBe(1000);
  expect(versPointsDeBase("12,5 %")).toBe(1250);
  expect(versPointsDeBase("")).toBe(0);
  expect(versPointsDeBase("101")).toBeNull();
  expect(versQuantite("1,5")).toBe(1.5);
  expect(versQuantite("0")).toBeNull();
  expect(versQuantite("1,2345")).toBeNull();
  expect(tauxTva(200)).toBe("20 %");
  expect(tauxTva(55)).toBe("5,5 %");
  expect(tauxTva(21)).toBe("2,1 %");
});

test("dates : affichage fr-FR sans décalage de fuseau, mois, bornes, échéances", () => {
  expect(dateFr("2026-10-22")).toBe("22/10/2026");
  expect(dateFr("2026-01-01T23:30:00Z")).toBe("01/01/2026");
  expect(dateFr(null)).toBe("");
  expect(moisFr("2026-10-22")).toBe("octobre 2026");
  expect(bornesMois("2024-02-10")).toEqual({ du: "2024-02-01", au: "2024-02-29" });
  expect(ajouterJours("2026-12-15", 30)).toBe("2027-01-14");
});

test("lignes saisies → lignes du domaine, totaux identiques à @auto/domain", () => {
  const s = { designation: " Conseil ", quantite: "2,5", unite: "h", prix: "80", remise: "10", tva: 200 as const };
  const l = versLigne(s)!;
  expect(l).toEqual({
    designation: "Conseil",
    quantite: 2.5,
    prixUnitaireHtCents: 8000,
    remiseBp: 1000,
    tva: 200,
    unite: "h",
  });
  expect(htLigneSaisie(s)).toBe(18000);
  expect(totaux([l])).toMatchObject({ htCents: 18000, tvaCents: 3600, ttcCents: 21600 });
  expect(versLigne({ ...s, prix: "x" })).toBeNull();
  expect(htLigneSaisie({ ...s, prix: "x" })).toBe(0);
  expect(erreursLigne({ ...s, designation: "", quantite: "0", prix: "", remise: "200" })).toEqual({
    designation: expect.any(String),
    quantite: expect.any(String),
    prix: expect.any(String),
    remise: expect.any(String),
  });
  expect(erreursLigne(s)).toEqual({});
});

test("statuts : « en retard » dérivé, libellés accordés", () => {
  const f = {
    type: "facture" as const,
    statut: "emis" as const,
    data: { date: "2026-09-01", echeance: "2026-10-01", client: { nom: "C" } },
  };
  expect(statutVisuel(f, "2026-10-02")).toBe("en_retard");
  expect(statutVisuel(f, "2026-10-01")).toBe("emis");
  expect(statutVisuel({ ...f, statut: "paye" }, "2026-12-01")).toBe("paye");
  expect(statutVisuel({ ...f, type: "devis" }, "2026-12-01")).toBe("emis");
  expect(libelleStatut("emis", "facture")).toBe("Émise");
  expect(libelleStatut("emis", "devis")).toBe("Émis");
  expect(libelleStatut("en_retard", "facture")).toBe("En retard");
});

test("indicateurs du tableau de bord : CA, TVA, impayés, retards, avoirs déduits", () => {
  const doc = (
    id: string,
    p: Partial<DocResume> & { date: string; echeance?: string; origine?: string },
  ): DocResume & { id: string } => ({
    id,
    type: p.type ?? "facture",
    statut: p.statut ?? "emis",
    numero: p.numero ?? id,
    htCents: p.htCents ?? 10000,
    tvaCents: p.tvaCents ?? 2000,
    ttcCents: p.ttcCents ?? 12000,
    data: { date: p.date, echeance: p.echeance, origine: p.origine, client: { nom: "C" } },
  });
  const docs = [
    doc("F1", { date: "2026-10-05", echeance: "2026-10-10" }), // en retard
    doc("F2", { date: "2026-10-15", echeance: "2026-11-15" }),
    doc("F3", { date: "2026-09-01", echeance: "2026-09-30", statut: "paye" }),
    doc("A1", { type: "avoir", date: "2026-10-20", htCents: 5000, tvaCents: 1000, ttcCents: 6000, origine: "F2" }),
    doc("D1", { type: "devis", date: "2026-10-01" }),
    doc("B1", { statut: "brouillon", numero: null, date: "2026-10-02" }),
  ];
  const k = indicateurs(docs, "2026-10-22");
  expect(k.caMoisHtCents).toBe(10000 + 10000 - 5000);
  expect(k.tvaMoisCents).toBe(2000 + 2000 - 1000);
  expect(k.impayes).toBe(2);
  expect(k.impayesCents).toBe(12000 + 6000);
  expect(k).toMatchObject({ enRetard: 1, enRetardCents: 12000, devisEnAttente: 1 });
  // Paiement partiel connu : le reste dû remplace le TTC.
  expect(indicateurs(docs, "2026-10-22", { F1: 2000 }).enRetardCents).toBe(2000);
});

test("divers : e-mail, SIRET groupé, octets, jours", () => {
  expect(emailValide("a@b.fr")).toBe(true);
  expect(emailValide("a@b")).toBe(false);
  expect(grouperSiret("73282932000074")).toBe("732 829 320 00074");
  expect(grouperSiret("732 829 320")).toBe("732 829 320");
  expect(octets(1_500_000_000)).toBe("1,5 Go");
  expect(octets(20_000_000_000)).toBe("20 Go");
  expect(octets(512)).toBe("512 o");
  expect(jours(1)).toBe("1 jour");
  expect(jours(2.5)).toBe("2,5 jours");
});

import { expect, test } from "bun:test";
import { congesAcquis, debutPeriode, joursFeries, joursOuvrables, paques, verifierEmploye } from "./rh";

test("Pâques et jours fériés mobiles", () => {
  expect(paques(2024)).toBe("2024-03-31");
  expect(paques(2026)).toBe("2026-04-05");
  expect(paques(2027)).toBe("2027-03-28");
  expect(joursFeries(2026)).toEqual([
    "2026-01-01",
    "2026-04-06",
    "2026-05-01",
    "2026-05-08",
    "2026-05-14",
    "2026-05-25",
    "2026-07-14",
    "2026-08-15",
    "2026-11-01",
    "2026-11-11",
    "2026-12-25",
  ]);
});

test("jours ouvrables : dimanches et fériés exclus", () => {
  // du lundi 4 au dimanche 10 mai 2026 : 8 mai férié, dimanche exclu
  expect(joursOuvrables("2026-05-04", "2026-05-10")).toBe(5);
  expect(joursOuvrables("2026-08-03", "2026-08-08")).toBe(6);
  expect(joursOuvrables("2026-12-28", "2027-01-02")).toBe(5);
  expect(joursOuvrables("2026-05-10", "2026-05-04")).toBe(0);
});

test("congés acquis : 2,5 jours par mois entier, plafond 30", () => {
  expect(debutPeriode("2026-05-31")).toBe("2025-06-01");
  expect(debutPeriode("2026-06-01")).toBe("2026-06-01");
  const e = { dateEntree: "2020-01-01" };
  expect(congesAcquis(e, "2026-06-15")).toBe(0);
  expect(congesAcquis(e, "2026-07-01")).toBe(3); // 1 mois, 2,5 arrondi au supérieur
  expect(congesAcquis(e, "2026-10-31")).toBe(13); // 5 mois
  expect(congesAcquis(e, "2027-05-31")).toBe(30);
  expect(congesAcquis({ dateEntree: "2026-09-15" }, "2026-10-14")).toBe(3);
  expect(congesAcquis({ dateEntree: "2026-09-15" }, "2026-10-13")).toBe(0);
  expect(congesAcquis({ dateEntree: "2026-06-01", dateSortie: "2026-08-31" }, "2026-10-31")).toBe(8);
});

test("vérification d'un employé", () => {
  const ok = {
    nom: "Martin",
    prenom: "Léa",
    poste: "Assistante",
    contrat: "cdi" as const,
    dateEntree: "2026-01-05",
    tempsTravail: 100,
    salaireBrutMensuelCents: 220000,
  };
  expect(verifierEmploye(ok)).toEqual([]);
  expect(verifierEmploye({ ...ok, contrat: "cdd" })).toContain("CDD : date de fin obligatoire");
  expect(verifierEmploye({ ...ok, tempsTravail: 0 })).toContain("temps de travail entre 1 et 100 %");
  expect(verifierEmploye({ ...ok, dateSortie: "2025-01-01" })).toContain("date de sortie antérieure à l'entrée");
});

import { expect, test } from "bun:test";
import { compteClient, desequilibres, ecritureEncaissement, ecritureVente, fec, latin9, nomFec, totaux } from "./index";

const t = totaux([
  { designation: "A", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 },
  { designation: "B", quantite: 1, prixUnitaireHtCents: 5000, tva: 55 },
]);
const client = { nom: "Société Durand", siret: "73282932000074" };

test("vente équilibrée, TVA par taux, avoir inversé, devis ignoré", () => {
  const v = ecritureVente({ type: "facture", numero: "F-2026-0001", date: "2026-10-01", client, totaux: t });
  expect(v.map((l) => [l.compteNum, l.compteLib, l.debitCents, l.creditCents])).toEqual([
    ["411000", "Clients", 17275, 0],
    ["706000", "Prestations de services", 0, 15000],
    ["445710", "TVA collectée 5,5 %", 0, 275],
    ["445710", "TVA collectée 20 %", 0, 2000],
  ]);
  expect(v[0]!.compAuxNum).toBe("C732829320");
  expect(desequilibres(v)).toEqual([]);
  const a = ecritureVente({ type: "avoir", numero: "A-2026-0001", date: "2026-10-02", client, totaux: t });
  expect([a[0]!.debitCents, a[0]!.creditCents, a[1]!.debitCents]).toEqual([0, 17275, 15000]);
  expect(desequilibres(a)).toEqual([]);
  expect(ecritureVente({ type: "devis", numero: "D-1", date: "2026-10-01", client, totaux: t })).toEqual([]);
  expect(compteClient("Société Durand")).toBe("CSOCIETEDU");
});

test("FEC : 18 champs, dates AAAAMMJJ, virgule décimale, tri, équilibre exigé", () => {
  const lignes = [
    ...ecritureEncaissement({
      numero: "BQ-0001",
      date: "2026-10-15",
      factureNumero: "F-2026-0001",
      client,
      montantCents: 17275,
    }),
    ...ecritureVente({ type: "facture", numero: "F-2026-0001", date: "2026-10-01", client, totaux: t }),
  ];
  const texte = fec(lignes);
  expect(texte.endsWith("\r\n")).toBe(true);
  const rangs = texte
    .slice(0, -2)
    .split("\r\n")
    .map((r) => r.split("\t"));
  expect(rangs).toHaveLength(7);
  expect(rangs.every((r) => r.length === 18)).toBe(true);
  expect(rangs[0]![0]).toBe("JournalCode");
  expect(rangs[1]!.slice(0, 4)).toEqual(["VE", "Ventes", "F-2026-0001", "20261001"]);
  expect(rangs[1]![11]).toBe("172,75");
  expect(rangs[6]!.slice(0, 2)).toEqual(["BQ", "Banque"]);
  expect(() => fec([{ ...lignes[0]!, debitCents: 1 }])).toThrow("déséquilibré");
  expect(nomFec("732829320", "2026-12-31")).toBe("732829320FEC20261231.txt");
  expect([...latin9("é€x一")]).toEqual([0xe9, 0xa4, 0x78, 0x3f]);
});

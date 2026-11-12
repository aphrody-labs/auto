import { expect, test } from "bun:test";
import {
  avecMentionsParDefaut,
  avoirPartiel,
  avoirTotal,
  htLigne,
  devisVersFacture,
  numero,
  sirenValide,
  siretValide,
  totaux,
  tvaIntracomFr,
  verifier,
  type Document,
} from "./index";

const emetteur = { nom: "ACME", siret: "73282932000074", adresse: "1 rue A, Paris", tvaIntracom: "FR44732829320" };
const client = { nom: "Client", siret: "73282932000074", adresse: "2 rue B, Lyon" };
const devis: Document = {
  type: "devis",
  date: "2026-10-01",
  emetteur,
  client,
  lignes: [{ designation: "Audit", quantite: 2, prixUnitaireHtCents: 50000, tva: 200 }],
  validiteJours: 30,
};

test("totaux par taux", () => {
  const t = totaux([
    { designation: "a", quantite: 2, prixUnitaireHtCents: 5000, tva: 200 },
    { designation: "b", quantite: 1, prixUnitaireHtCents: 1000, tva: 55 },
  ]);
  expect(t.htCents).toBe(11000);
  expect(t.tvaCents).toBe(2000 + 55);
  expect(t.ttcCents).toBe(13055);
});

test("siret, siren, tva intracom", () => {
  expect(siretValide("73282932000074")).toBe(true);
  expect(siretValide("73282932000075")).toBe(false);
  expect(sirenValide("732829320")).toBe(true);
  expect(sirenValide("732829321")).toBe(false);
  expect(tvaIntracomFr("732829320")).toBe("FR44732829320");
});

test("numérotation par série", () => {
  expect(numero("facture", 2026, 1)).toBe("F-2026-0001");
  expect(numero("acompte", 2026, 2)).toBe("F-2026-0002");
  expect(numero("avoir", 2026, 1)).toBe("A-2026-0001");
  expect(numero("devis", 2026, 12)).toBe("D-2026-0012");
});

test("devis valide, facture issue du devis valide", () => {
  expect(verifier(devis)).toEqual([]);
  const f = devisVersFacture(devis, "D-2026-0001", "2026-10-10", "2026-11-09");
  expect(verifier(f)).toEqual(["date de livraison ou de prestation manquante"]);
  expect(verifier({ ...f, datePrestation: "2026-10-05" })).toEqual([]);
  expect(f.origine).toBe("D-2026-0001");
});

test("mentions obligatoires de facture", () => {
  const f: Document = { ...devis, type: "facture" };
  const e = verifier(f);
  expect(e).toContain("date d'échéance manquante");
  expect(e).toContain("taux des pénalités de retard manquant");
  expect(verifier(avecMentionsParDefaut({ ...f, echeance: "2026-11-01", datePrestation: "2026-10-01" }))).toEqual([]);
});

test("franchise en base", () => {
  const f: Document = { ...devis, emetteur: { ...emetteur, tvaIntracom: undefined }, franchiseTva: true };
  expect(verifier(f)).toContain("franchise en base : toutes les lignes doivent être à 0 % de TVA");
  expect(verifier({ ...f, lignes: [{ ...devis.lignes[0]!, tva: 0 }] })).toEqual([]);
});

test("avoir", () => {
  const f = devisVersFacture(devis, "D-2026-0001", "2026-10-10", "2026-11-09");
  const a = avoirTotal(f, "F-2026-0001", "2026-10-20");
  expect(a.type).toBe("avoir");
  expect(a.origine).toBe("F-2026-0001");
  expect(() => avoirTotal(devis, "D-1", "2026-10-20")).toThrow();
});

test("remises identiques à auto-modele", () => {
  const l = (quantite: number, prixUnitaireHtCents: number, remiseBp: number) =>
    htLigne({ designation: "x", quantite, prixUnitaireHtCents, tva: 200, remiseBp });
  expect(l(3, 33333, 1250)).toBe(87499);
  expect(l(1.5, 19999, 1000)).toBe(26999);
  expect(l(7, 1999, 333)).toBe(13527);
  expect(verifier({ ...devis, lignes: [{ ...devis.lignes[0]!, remiseBp: 12000 }] })).toContain(
    "ligne 1 : remise invalide",
  );
});

test("avoir partiel", () => {
  const f = devisVersFacture(devis, "D-2026-0001", "2026-10-10", "2026-11-09");
  const a = avoirPartiel(f, "F-2026-0001", "2026-10-20", [{ ...f.lignes[0]!, quantite: 1 }]);
  expect(a.type).toBe("avoir");
  expect(totaux(a.lignes).ttcCents).toBe(60000);
  expect(() => avoirPartiel(f, "F-2026-0001", "2026-10-20", [])).toThrow();
});

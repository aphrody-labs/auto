import { expect, test } from "bun:test";
import {
  ecrireXlsx,
  lireTableur,
  modifierXlsx,
  creerDocx,
  remplacerDocx,
  texteDocx,
  champsDocx,
  remplirDocx,
} from "./index";
test("Gridcraft : édition ciblée, conservation des autres feuilles et recalcul dépendant", () => {
  const original = ecrireXlsx({
    feuilles: [
      {
        nom: "Calcul",
        colonnes: [
          { titre: "A", type: "nombre" },
          { titre: "B", type: "nombre" },
          { titre: "Total", type: "nombre" },
        ],
        lignes: [[2, 3, null]],
      },
      { nom: "Historique", colonnes: [{ titre: "Note" }], lignes: [["Conserver cette feuille"]] },
    ],
  });
  const avecFormule = modifierXlsx(original, [{ feuille: "Calcul", ligne: 2, colonne: 3, formule: "=A2+B2" }]);
  expect(lireTableur(avecFormule).feuilles[0]!.lignes[1]![2]).toBe(5);
  const edite = modifierXlsx(avecFormule, [{ feuille: "Calcul", ligne: 2, colonne: 1, valeur: 10 }]);
  const relu = lireTableur(edite);
  expect(relu.feuilles[0]!.lignes[1]).toEqual([10, 3, 13]);
  expect(relu.feuilles[1]!.lignes[1]).toEqual(["Conserver cette feuille"]);
  expect(lireTableur(original).feuilles[0]!.lignes[1]).toEqual([2, 3, null]);
  expect(() => modifierXlsx(original, [{ feuille: "Calcul", ligne: 0, colonne: 1, valeur: 2 }])).toThrow();
  expect(() => modifierXlsx(original, [{ feuille: "Absente", ligne: 1, colonne: 1, valeur: 2 }])).toThrow();
});
test("Wordcraft : remplacement Unicode hors gabarit et conservation des champs", () => {
  const original = creerDocx({
    titre: "Compte rendu",
    paragraphes: [{ texte: "Bonjour Élodie, chantier {{lot}}.", gras: true }, { texte: "Élodie suit la livraison." }],
  });
  const edite = remplacerDocx(original, [{ chercher: "Élodie", remplacer: "François" }]);
  expect(texteDocx(edite)).toContain("Bonjour François, chantier {{lot}}.");
  expect(texteDocx(edite)).toContain("François suit la livraison.");
  expect(champsDocx(edite)).toEqual(["lot"]);
  expect(texteDocx(remplirDocx(edite, { lot: "CH-001" }))).toContain("chantier CH-001");
  expect(texteDocx(original)).toContain("Élodie");
  expect(() => remplacerDocx(original, [{ chercher: "", remplacer: "X" }])).toThrow();
});

import { MODELES, catalogueJson, valider, type Definition } from "@auto/automate";
import type { TypeNoeudApi } from "@auto/client";
import { expect, test } from "bun:test";
import { filtrerCatalogue } from "./palette";
import {
  avecResultats,
  cheminsDe,
  connexionValide,
  definitionVide,
  elaguer,
  espacer,
  nouveauNoeud,
  nouvelId,
  sortiesNoeud,
  versDefinition,
  versFlux,
} from "./graphe";

// Le catalogue servi par l'API est `catalogueJson()` : les tests utilisent la même source.
const CATALOGUE = catalogueJson() as TypeNoeudApi[];
const type = (t: string) => CATALOGUE.find((x) => x.type === t)!;

test("aller-retour définition → canevas → définition sans perte, pour chaque modèle", () => {
  for (const m of MODELES) {
    const { nodes, edges } = versFlux(m.definition);
    expect(nodes).toHaveLength(m.definition.noeuds.length);
    expect(edges).toHaveLength(m.definition.connexions.length);
    expect(versDefinition(nodes, edges)).toEqual(m.definition);
    expect(() => valider(versDefinition(nodes, edges))).not.toThrow();
  }
});

test("une connexion devient une arête dont la poignée source porte l'indice de sortie", () => {
  const ia = MODELES.find((m) => m.id === "ia-tri-messages")!;
  const { edges } = versFlux(ia.definition);
  const support = edges.find((e) => e.target === "support")!;
  expect(support).toMatchObject({ source: "aiguillage", sourceHandle: "s1", target: "support" });
  expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
});

test("versDefinition : positions arrondies, arêtes orphelines et doublons écartés", () => {
  const { nodes, edges } = versFlux(definitionVide());
  nodes[0]!.position = { x: 12.6, y: -40.2 };
  const http = nouveauNoeud(type("reseau.http"), { x: 300, y: 0 }, ["declencheur"]);
  const arete = { id: "a", source: "declencheur", sourceHandle: "s0", target: http.id };
  const def = versDefinition(
    [...nodes, http],
    [...edges, arete, { ...arete, id: "b" }, { id: "c", source: "fantome", target: http.id }],
  );
  expect(def.noeuds[0]!.position).toEqual([13, -40]);
  expect(def.connexions).toEqual([{ de: "declencheur", sortie: 0, vers: "http" }]);
});

test("nouveau nœud : identifiant unique, libellé et paramètres par défaut du schéma", () => {
  expect(nouvelId("reseau.http", [])).toBe("http");
  expect(nouvelId("reseau.http", ["http", "http_2"])).toBe("http_3");
  const n = nouveauNoeud(type("reseau.http"), { x: 10.4, y: 20 }, ["http"]);
  expect(n.id).toBe("http_2");
  expect(n.data.noeud).toMatchObject({
    nom: "Requête HTTP",
    position: [10, 20],
    parametres: { methode: "GET", url: "", entetes: [], requete: [], format: "auto", echecSiErreur: true },
  });
  const si = nouveauNoeud(type("logique.si"), { x: 0, y: 0 }, []);
  expect(si.data.noeud.parametres).toEqual({
    conditions: [{ gauche: "", operateur: "egal", droite: "" }],
    combinaison: "et",
  });
});

test("sorties : fixes (si), dynamiques (aiguillage : cas puis « autre »), principale sinon", () => {
  expect(sortiesNoeud({ parametres: {} }, type("logique.si"))).toEqual(["vrai", "faux"]);
  expect(sortiesNoeud({ parametres: { cas: ["devis", ""] } }, type("logique.aiguillage"))).toEqual([
    "devis",
    "cas 2",
    "autre",
  ]);
  expect(sortiesNoeud({ parametres: {} }, type("donnees.trier"))).toEqual(["principale"]);
  expect(sortiesNoeud({ parametres: {} }, undefined)).toEqual(["principale"]);
});

test("connexions refusées : boucle, entrée de déclencheur, doublon, soi-même", () => {
  const def: Definition = {
    noeuds: [
      ...definitionVide().noeuds,
      { ...nouveauNoeud(type("donnees.trier"), { x: 0, y: 0 }, []).data.noeud, id: "a" },
      { ...nouveauNoeud(type("donnees.trier"), { x: 0, y: 0 }, []).data.noeud, id: "b" },
    ],
    connexions: [
      { de: "declencheur", sortie: 0, vers: "a" },
      { de: "a", sortie: 0, vers: "b" },
    ],
  };
  const { nodes, edges } = versFlux(def);
  const ok = (source: string, target: string, sourceHandle = "s0") =>
    connexionValide({ source, target, sourceHandle }, nodes, edges);
  expect(ok("declencheur", "b")).toBe(true);
  expect(ok("b", "a")).toBe(false);
  expect(ok("a", "declencheur")).toBe(false);
  expect(ok("a", "b")).toBe(false);
  expect(ok("a", "a")).toBe(false);
});

test("élagage des arêtes d'une sortie disparue (cas d'aiguillage retiré)", () => {
  const ia = MODELES.find((m) => m.id === "ia-tri-messages")!;
  const { edges } = versFlux(ia.definition);
  const restantes = elaguer(edges, "aiguillage", 1);
  expect(restantes.some((e) => e.target === "support")).toBe(false);
  expect(restantes.some((e) => e.target === "devis")).toBe(true);
  expect(restantes).toHaveLength(edges.length - 1);
});

test("résultats d'essai reportés sur les nœuds, puis effacés", () => {
  const { nodes } = versFlux(definitionVide());
  const etape = {
    noeud: "declencheur",
    nom: "Lancement manuel",
    type: "declencheur.manuel",
    debut: "2026-10-23T10:00:00.000Z",
    dureeMs: 1,
    entree: 1,
    sorties: [1],
    apercu: [{ json: { a: 1 } }],
  };
  const avec = avecResultats(nodes, [etape]);
  expect(avec[0]!.data.resultat).toEqual(etape);
  expect(avecResultats(avec, null)[0]!.data.resultat).toBeUndefined();
  expect(versDefinition(avec, [])).toEqual(definitionVide());
});

test("chemins proposés dans l'aide aux expressions", () => {
  expect(cheminsDe({ client: { nom: "A", "e-mail": "x" }, "montant total": 3, liste: [1] })).toEqual([
    ".client",
    ".client.nom",
    ".client.e-mail",
    '["montant total"]',
    ".liste",
  ]);
});

test("palette : recherche sans accents, groupes dans l'ordre des catégories", () => {
  const groupes = filtrerCatalogue(CATALOGUE, "requete");
  expect(groupes.map((g) => g.categorie)).toEqual(["declencheur", "reseau", "auto"]);
  expect(filtrerCatalogue(CATALOGUE, "tableur")[0]!.types.map((t) => t.type)).toEqual([
    "fichier.tableur",
    "fichier.lire_tableur",
  ]);
  expect(filtrerCatalogue(CATALOGUE, "")[0]!.categorie).toBe("declencheur");
  expect(filtrerCatalogue(CATALOGUE, "zzz")).toEqual([]);
});

test("espacement des nœuds trop serrés (import n8n), positions déjà espacées inchangées", () => {
  const base = definitionVide().noeuds[0]!;
  const def: Definition = {
    noeuds: [
      { ...base, id: "a", position: [0, 0] },
      { ...base, id: "b", position: [220, 0] },
      { ...base, id: "c", position: [440, 100] },
    ],
    connexions: [],
  };
  expect(espacer(def).noeuds.map((n) => n.position)).toEqual([
    [0, 0],
    [260, 0],
    [520, 140],
  ]);
  const modele = MODELES[0]!.definition;
  expect(espacer(modele)).toBe(modele);
});

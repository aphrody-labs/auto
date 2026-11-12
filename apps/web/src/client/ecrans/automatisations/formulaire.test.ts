import { catalogueJson } from "@auto/automate";
import type { SchemaJson, TypeNoeudApi } from "@auto/client";
import { expect, test } from "bun:test";
import {
  champsDepuisSchema,
  depuisLibre,
  erreursChamps,
  genreDe,
  valeursInitiales,
  versLibre,
  versNombre,
} from "./formulaire";

const CATALOGUE = catalogueJson() as TypeNoeudApi[];
const schema = (t: string) => CATALOGUE.find((x) => x.type === t)!.parametres;
const genres = (t: string) => Object.fromEntries(champsDepuisSchema(schema(t)).map((c) => [c.cle, c.genre]));

test("chaque propriété du catalogue reçoit un genre de champ connu", () => {
  for (const t of CATALOGUE)
    for (const c of champsDepuisSchema(t.parametres))
      expect([
        "texte",
        "zone",
        "nombre",
        "booleen",
        "choix",
        "liste",
        "paires",
        "conditions",
        "objets",
        "libre",
        "objet",
      ]).toContain(c.genre);
});

test("genres déduits du JSON Schema : requête HTTP", () => {
  expect(genres("reseau.http")).toEqual({
    methode: "choix",
    url: "texte",
    entetes: "paires",
    requete: "paires",
    corps: "libre",
    format: "choix",
    echecSiErreur: "booleen",
  });
  const methode = champsDepuisSchema(schema("reseau.http")).find((c) => c.cle === "methode")!;
  expect(methode).toMatchObject({ libelle: "Méthode", requis: false, defaut: "GET" });
  expect(methode.options?.map((o) => o.valeur)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
});

test("genres : conditions, liste de chaînes, nombre borné, zone, objet", () => {
  expect(genres("logique.si")).toEqual({ conditions: "conditions", combinaison: "choix" });
  const conditions = champsDepuisSchema(schema("logique.si"))[0]!;
  expect(conditions).toMatchObject({ requis: true, min: 1, max: 20 });
  expect(conditions.operateurs?.find((o) => o.valeur === "non_vide")?.libelle).toBe("n'est pas vide");
  expect(genres("logique.aiguillage")).toEqual({ valeur: "libre", cas: "liste" });
  const secondes = champsDepuisSchema(schema("logique.attendre"))[0]!;
  expect(secondes).toMatchObject({ genre: "nombre", min: 0, max: 60, requis: true });
  expect(champsDepuisSchema(schema("donnees.limiter"))[0]).toMatchObject({ entier: true, min: 1 });
  expect(genres("communication.mail")).toEqual({ a: "texte", sujet: "texte", texte: "zone", piece: "libre" });
  expect(genres("declencheur.manuel")).toEqual({ donnees: "objet" });
  expect(champsDepuisSchema(schema("declencheur.evenement"))[0]!.suggestions).toContain("document.emis");
  expect(genreDe("x", { type: ["string", "null"] })).toBe("texte");
  expect(genreDe("x", {})).toBe("libre");
});

test("tableaux d'objets quelconques : une ligne de sous-champs (extraction HTML, colonnes de tableur)", () => {
  const champs = champsDepuisSchema(schema("reseau.extraire")).find((c) => c.cle === "champs")!;
  expect(champs.genre).toBe("objets");
  expect(champs.sousChamps?.map((c) => [c.cle, c.genre, c.requis])).toEqual([
    ["nom", "texte", true],
    ["selecteur", "texte", true],
    ["attribut", "texte", false],
    ["tous", "booleen", false],
  ]);
  expect(valeursInitiales(schema("reseau.extraire")).champs).toEqual([
    { nom: "", selecteur: "", attribut: "", tous: false },
  ]);
  expect(valeursInitiales(schema("fichier.tableur"))).toEqual({ nom: "export", colonnes: [{ titre: "", champ: "" }] });
  expect(erreursChamps(schema("fichier.tableur"), { colonnes: [{ titre: "N°", champ: "" }] })).toEqual({
    colonnes: "Ligne 1 : champ obligatoire vide.",
  });
  expect(erreursChamps(schema("fichier.tableur"), { colonnes: [{ titre: "N°", champ: "numero" }] })).toEqual({});
});

test("valeurs initiales : défauts du schéma et lignes vides des listes obligatoires", () => {
  expect(valeursInitiales(schema("donnees.definir"))).toEqual({ champs: [{ nom: "", valeur: "" }], conserver: true });
  expect(valeursInitiales(schema("declencheur.evenement"))).toEqual({ types: [""] });
  expect(valeursInitiales(schema("ia.texte"))).toMatchObject({
    url: "http://localhost:11434/v1",
    modele: "",
    prompt: "",
    temperature: 0.2,
    json: false,
  });
  // Les défauts sont copiés : modifier un nœud ne modifie pas le schéma partagé.
  const s: SchemaJson = { type: "object", properties: { l: { type: "array", default: [] } } };
  (valeursInitiales(s).l as unknown[]).push(1);
  expect(s.properties!.l!.default).toEqual([]);
});

test("erreurs : obligatoires, bornes, entiers, listes ; expressions laissées au moteur", () => {
  expect(erreursChamps(schema("logique.attendre"), {})).toEqual({ secondes: "Champ obligatoire." });
  expect(erreursChamps(schema("logique.attendre"), { secondes: 90 })).toEqual({ secondes: "Maximum : 60." });
  expect(erreursChamps(schema("logique.attendre"), { secondes: "{{ $json.delai }}" })).toEqual({});
  expect(erreursChamps(schema("donnees.limiter"), { max: 2.5 })).toEqual({ max: "Nombre entier attendu." });
  expect(erreursChamps(schema("donnees.limiter"), { max: "beaucoup" })).toEqual({
    max: "Nombre attendu, ou une expression {{ … }}.",
  });
  expect(erreursChamps(schema("donnees.definir"), { champs: [{ nom: " ", valeur: 1 }] })).toEqual({
    champs: "Chaque ligne doit avoir un nom.",
  });
  expect(erreursChamps(schema("logique.si"), { conditions: [] })).toEqual({ conditions: "Champ obligatoire." });
  expect(erreursChamps(schema("logique.aiguillage"), { cas: ["a"] })).toEqual({});
});

test("conversions de saisie : nombres, JSON libre, affichage", () => {
  expect(versNombre("12,5")).toBe(12.5);
  expect(versNombre(" ")).toBe("");
  expect(versNombre("{{ $json.n }}")).toBe("{{ $json.n }}");
  expect(versNombre("douze")).toBe("douze");
  expect(versLibre('{ "a": 1 }')).toEqual({ a: 1 });
  expect(versLibre("[1, 2]")).toEqual([1, 2]);
  expect(versLibre("{ pas du json }")).toBe("{ pas du json }");
  expect(versLibre("bonjour")).toBe("bonjour");
  expect(depuisLibre({ a: 1 })).toBe('{\n  "a": 1\n}');
  expect(depuisLibre(undefined)).toBe("");
  expect(depuisLibre(3)).toBe("3");
});

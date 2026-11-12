// Formulaire des paramètres d'un nœud, déduit du JSON Schema publié par le catalogue (`catalogueJson()`).
// Chaque propriété devient un champ typé ; les valeurs restent libres d'accueillir une expression `{{ … }}`,
// que seul le moteur résout à l'exécution : un nombre saisi « {{ $json.total }} » reste une chaîne.
import type { SchemaJson } from "@auto/client";

export type GenreChamp =
  | "texte"
  | "zone"
  | "nombre"
  | "booleen"
  | "choix"
  | "liste"
  | "paires"
  | "conditions"
  | "objets"
  | "libre"
  | "objet";

export interface Option {
  valeur: string;
  libelle: string;
}

export interface Champ {
  cle: string;
  libelle: string;
  genre: GenreChamp;
  requis: boolean;
  aide?: string;
  options?: Option[];
  /** Opérateurs proposés par un champ « conditions ». */
  operateurs?: Option[];
  min?: number;
  max?: number;
  entier?: boolean;
  defaut?: unknown;
  /** Suggestions (liste de valeurs connues, par exemple les types d'événements). */
  suggestions?: string[];
  /** Sous-champs de chaque ligne d'un tableau d'objets (genre « objets »). */
  sousChamps?: Champ[];
}

export const LIBELLES: Record<string, string> = {
  a: "Destinataire",
  cas: "Cas",
  champ: "Champ",
  champs: "Champs",
  chat: "Identifiant du chat",
  chemin: "Chemin de l'API",
  cle: "Clé d'API",
  combinaison: "Combinaison",
  conditions: "Conditions",
  conserver: "Conserver les autres champs",
  corps: "Corps",
  colonnes: "Colonnes",
  cron: "Expression cron",
  attribut: "Attribut",
  donnees: "Données d'essai",
  eclater: "Un élément par résultat",
  echecSiErreur: "Échouer si la réponse est une erreur HTTP",
  entetes: "En-têtes",
  format: "Format de la réponse",
  fuseau: "Fuseau horaire",
  jeton: "Jeton du bot",
  json: "Réponse en JSON",
  max: "Nombre maximum",
  memoire: "Mémoire (valeurs retenues)",
  feuille: "Feuille",
  nom: "Nom",
  piece: "Pièce jointe",
  selecteur: "Sélecteur CSS",
  titre: "Titre",
  tous: "Tous les éléments",
  message: "Message d'erreur",
  methode: "Méthode",
  modele: "Modèle",
  ordre: "Ordre",
  prompt: "Invite",
  reponse: "Réponse au webhook",
  requete: "Paramètres de requête",
  secondes: "Durée (secondes)",
  sujet: "Objet",
  systeme: "Consigne système",
  temperature: "Température",
  texte: "Message",
  types: "Types d'événements",
  url: "URL",
  valeur: "Valeur",
  webhook: "URL du webhook",
};

export const AIDES: Record<string, string> = {
  cron: "Cinq champs : minute heure jour mois jour-de-semaine. Exemple : 0 8 * * 1 (lundi 8 h).",
  chemin: "Chemin de l'API d'auto, par exemple /v1/clients.",
  valeur: "Valeur comparée aux cas, souvent une expression comme {{ $json.categorie }}.",
  cas: "Une sortie par cas, plus une sortie « autre ».",
  corps: "Texte ou JSON ; les expressions sont résolues dans les chaînes.",
  donnees: "Objet JSON reçu par le premier nœud lors d'un lancement manuel.",
  cle: "Utilisez un secret : {{ $secret.nom }}.",
  jeton: "Utilisez un secret : {{ $secret.nom }}.",
  webhook: "Utilisez un secret : {{ $secret.nom }}.",
  types: "Un type par ligne, par exemple document.emis.",
  piece: "Fichier produit par « Créer un tableur » : {{ $json.fichier }}. Vide : aucune pièce jointe.",
  memoire: "Nombre de valeurs déjà vues conservées d'une exécution à l'autre.",
  feuille: "Nom de la feuille ; vide : la première.",
  colonnes: "Une colonne par champ de l'élément, par exemple numero ou client.nom.",
  champ: "Chemin du champ dans l'élément, par exemple client.email.",
};

export const LIBELLES_OPTIONS: Record<string, string> = {
  egal: "est égal à",
  different: "est différent de",
  contient: "contient",
  ne_contient_pas: "ne contient pas",
  commence_par: "commence par",
  superieur: "est supérieur à",
  inferieur: "est inférieur à",
  vide: "est vide",
  non_vide: "n'est pas vide",
  vrai: "est vrai",
  faux: "est faux",
  correspond: "correspond au motif",
  et: "Toutes les conditions (et)",
  ou: "Au moins une condition (ou)",
  croissant: "Croissant",
  decroissant: "Décroissant",
  immediate: "Immédiate (202)",
  fin: "À la fin de l'exécution",
  auto: "Automatique",
  texte: "Texte",
  json: "JSON",
};

/** Opérateurs sans valeur de droite. */
export const UNAIRES = new Set(["vide", "non_vide", "vrai", "faux"]);

/** Événements publiés par auto (déclencheur « Événement auto »). */
export const EVENEMENTS = [
  "document.emis",
  "document.statut",
  "paiement.enregistre",
  "relance.a_envoyer",
  "absence.demandee",
  "absence.decidee",
  "facture.recue",
  "pa.statut",
  "export.mensuel",
];

const ZONES = new Set(["texte", "prompt", "systeme", "message"]);

const typeDe = (s: SchemaJson) => (Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type);

export const libelleDe = (cle: string) =>
  LIBELLES[cle] ??
  cle.charAt(0).toUpperCase() +
    cle
      .slice(1)
      .replace(/([A-Z])/g, " $1")
      .toLowerCase();

const options = (valeurs: unknown[]): Option[] =>
  valeurs.map((v) => ({ valeur: String(v), libelle: LIBELLES_OPTIONS[String(v)] ?? String(v) }));

/** Genre de champ d'une propriété du schéma. */
export function genreDe(cle: string, s: SchemaJson): GenreChamp {
  const t = typeDe(s);
  if (s.enum) return "choix";
  if (t === "boolean") return "booleen";
  if (t === "number" || t === "integer") return "nombre";
  if (t === "string") return ZONES.has(cle) ? "zone" : "texte";
  if (t === "array") {
    const p = s.items?.properties;
    if (p && "nom" in p && "valeur" in p) return "paires";
    if (p && "gauche" in p && "operateur" in p) return "conditions";
    if (typeDe(s.items ?? {}) === "string") return "liste";
    if (p) return "objets";
    return "libre";
  }
  if (t === "object") return "objet";
  return "libre";
}

/** Champs du formulaire, dans l'ordre des propriétés du schéma. */
export function champsDepuisSchema(schema: SchemaJson): Champ[] {
  const requis = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([cle, s]) => {
    const genre = genreDe(cle, s);
    const c: Champ = { cle, libelle: libelleDe(cle), genre, requis: requis.has(cle) };
    if (AIDES[cle]) c.aide = AIDES[cle];
    if (s.enum) c.options = options(s.enum);
    if (s.default !== undefined) c.defaut = s.default;
    if (genre === "nombre") {
      if (s.minimum !== undefined) c.min = s.minimum;
      if (s.maximum !== undefined) c.max = s.maximum;
      if (typeDe(s) === "integer") c.entier = true;
    }
    if (genre === "liste" || genre === "paires" || genre === "conditions" || genre === "objets") {
      if (s.minItems !== undefined) c.min = s.minItems;
      if (s.maxItems !== undefined) c.max = s.maxItems;
    }
    if (genre === "conditions") c.operateurs = options(s.items?.properties?.operateur?.enum ?? []);
    if (genre === "objets") c.sousChamps = champsDepuisSchema(s.items ?? {});
    if (cle === "types") c.suggestions = EVENEMENTS;
    return c;
  });
}

/** Valeur vide d'un élément de tableau d'objets. */
export function elementVide(champ: Champ): Record<string, unknown> {
  if (champ.genre === "conditions")
    return { gauche: "", operateur: champ.operateurs?.[0]?.valeur ?? "egal", droite: "" };
  if (champ.genre === "objets")
    return Object.fromEntries(
      (champ.sousChamps ?? []).map((c) => [
        c.cle,
        c.defaut !== undefined ? structuredClone(c.defaut) : c.genre === "booleen" ? false : "",
      ]),
    );
  return { nom: "", valeur: "" };
}

/** Paramètres d'un nouveau nœud : valeurs par défaut du schéma, et une ligne vide pour les listes obligatoires. */
export function valeursInitiales(schema: SchemaJson): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const c of champsDepuisSchema(schema)) {
    if (c.defaut !== undefined) v[c.cle] = structuredClone(c.defaut);
    else if (!c.requis) continue;
    else if (c.genre === "paires" || c.genre === "conditions" || c.genre === "objets") v[c.cle] = [elementVide(c)];
    else if (c.genre === "liste") v[c.cle] = [""];
    else if (c.genre === "booleen") v[c.cle] = false;
    else if (c.genre === "choix") v[c.cle] = c.options?.[0]?.valeur ?? "";
    else if (c.genre === "objet") v[c.cle] = {};
    else v[c.cle] = "";
  }
  return v;
}

export const estExpression = (v: unknown) => typeof v === "string" && v.includes("{{");

/** Saisie d'un champ nombre : un nombre si le texte en est un, sinon le texte (expression). */
export function versNombre(texte: string): number | string {
  const t = texte.trim();
  if (t === "") return "";
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) && !estExpression(t) ? n : texte;
}

/** Saisie d'un champ libre : JSON si le texte en est (objet, tableau), sinon le texte tel quel. */
export function versLibre(texte: string): unknown {
  const t = texte.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return texte;
    }
  }
  return texte;
}

/** Affichage d'une valeur libre dans une zone de texte. */
export function depuisLibre(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

const vide = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Erreurs visibles avant l'enregistrement : champs obligatoires vides, nombres hors bornes, listes trop
 * courtes. Les expressions ne sont pas jugées ici : le moteur les vérifie à l'exécution.
 */
export function erreursChamps(schema: SchemaJson, valeurs: Record<string, unknown>): Record<string, string> {
  const e: Record<string, string> = {};
  for (const c of champsDepuisSchema(schema)) {
    const v = valeurs[c.cle];
    if (c.requis && vide(v) && c.genre !== "libre") {
      e[c.cle] = "Champ obligatoire.";
      continue;
    }
    if (estExpression(v) || vide(v)) continue;
    if (c.genre === "nombre") {
      if (typeof v !== "number") e[c.cle] = "Nombre attendu, ou une expression {{ … }}.";
      else if (c.min !== undefined && v < c.min) e[c.cle] = `Minimum : ${c.min}.`;
      else if (c.max !== undefined && v > c.max) e[c.cle] = `Maximum : ${c.max}.`;
      else if (c.entier && !Number.isInteger(v)) e[c.cle] = "Nombre entier attendu.";
    }
    if (Array.isArray(v) && ["liste", "paires", "conditions", "objets"].includes(c.genre)) {
      if (c.min !== undefined && v.length < c.min) e[c.cle] = `Au moins ${c.min} élément${c.min > 1 ? "s" : ""}.`;
      if (c.genre === "paires" && v.some((p) => !(p as { nom?: string }).nom?.trim()))
        e[c.cle] = "Chaque ligne doit avoir un nom.";
      if (c.genre === "objets") {
        const i = v.findIndex((l) =>
          (c.sousChamps ?? []).some((s) => s.requis && vide((l as Record<string, unknown>)?.[s.cle])),
        );
        if (i >= 0) e[c.cle] = `Ligne ${i + 1} : champ obligatoire vide.`;
      }
    }
  }
  return e;
}

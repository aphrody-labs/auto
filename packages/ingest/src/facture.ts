// Facture fournisseur reçue, au format normalisé commun au Factur-X et à l'OCR + LLM.
import { sirenValide, siretValide, tvaIntracomFr } from "@auto/domain";

export interface LigneRecue {
  designation: string;
  quantite: number;
  prixUnitaireHtCents: number;
  /** Taux de TVA en dixièmes de pourcent : 200 = 20 %. */
  tauxTva: number;
  htCents: number;
}

export interface FactureRecue {
  type: "facture" | "avoir" | "acompte";
  numero: string;
  /** Dates ISO AAAA-MM-JJ. */
  date: string;
  echeance?: string;
  datePrestation?: string;
  devise: string;
  fournisseur: { nom: string; siren?: string; siret?: string; tvaIntracom?: string; adresse?: string };
  acheteur?: { nom: string; siren?: string };
  lignes: LigneRecue[];
  totaux: { htCents: number; tvaCents: number; ttcCents: number };
}

export type Source = "facturx" | "ocr";

const texte = { type: "string", minLength: 1 };
const texteNul = { type: ["string", "null"] };
// Classes explicites : également comprises par les grammaires JSON Schema de llama.cpp.
const dateIso = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
const dateNulle = { type: ["string", "null"], pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
const centimes = { type: "integer" };

/** JSON Schema imposé au LLM (mode strict : tous les champs présents, `null` si absent). */
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "numero",
    "date",
    "echeance",
    "datePrestation",
    "devise",
    "fournisseur",
    "acheteur",
    "lignes",
    "totaux",
  ],
  properties: {
    type: { type: "string", enum: ["facture", "avoir", "acompte"] },
    numero: texte,
    date: dateIso,
    echeance: dateNulle,
    datePrestation: dateNulle,
    devise: { type: "string", pattern: "^[A-Z]{3}$" },
    fournisseur: {
      type: "object",
      additionalProperties: false,
      required: ["nom", "siren", "siret", "tvaIntracom", "adresse"],
      properties: {
        nom: texte,
        siren: { type: ["string", "null"], pattern: "^[0-9]{9}$" },
        siret: { type: ["string", "null"], pattern: "^[0-9]{14}$" },
        tvaIntracom: texteNul,
        adresse: texteNul,
      },
    },
    acheteur: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["nom", "siren"],
      properties: { nom: texte, siren: { type: ["string", "null"], pattern: "^[0-9]{9}$" } },
    },
    lignes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["designation", "quantite", "prixUnitaireHtCents", "tauxTva", "htCents"],
        properties: {
          designation: texte,
          quantite: { type: "number" },
          prixUnitaireHtCents: centimes,
          tauxTva: { type: "integer", minimum: 0, maximum: 1000 },
          htCents: centimes,
        },
      },
    },
    totaux: {
      type: "object",
      additionalProperties: false,
      required: ["htCents", "tvaCents", "ttcCents"],
      properties: { htCents: centimes, tvaCents: centimes, ttcCents: centimes },
    },
  },
} as const;

type Schema = {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  required?: readonly string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
};

function typeDe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Sous-ensemble de JSON Schema suffisant pour SCHEMA : renvoie les écarts (vide = conforme). */
export function conforme(s: Schema, v: unknown, chemin = "$"): string[] {
  const t = typeDe(v);
  if (s.type) {
    const types = typeof s.type === "string" ? [s.type] : s.type;
    if (!types.includes(t) && !(t === "integer" && types.includes("number")))
      return [`${chemin} : ${t} au lieu de ${types.join("|")}`];
  }
  if (v === null) return [];
  const e: string[] = [];
  if (s.enum && !s.enum.includes(v)) e.push(`${chemin} : valeur hors de ${s.enum.join(", ")}`);
  if (typeof v === "string") {
    if (s.minLength && v.length < s.minLength) e.push(`${chemin} : vide`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) e.push(`${chemin} : format invalide`);
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) e.push(`${chemin} : < ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) e.push(`${chemin} : > ${s.maximum}`);
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) e.push(`${chemin}.${k} : manquant`);
    for (const [k, x] of Object.entries(o)) {
      const sp = s.properties?.[k];
      if (sp) e.push(...conforme(sp, x, `${chemin}.${k}`));
      else if (s.additionalProperties === false) e.push(`${chemin}.${k} : propriété inattendue`);
    }
  }
  if (t === "array" && s.items) (v as unknown[]).forEach((x, i) => e.push(...conforme(s.items!, x, `${chemin}[${i}]`)));
  return e;
}

/** Retire les `null` (champs absents) d'une sortie conforme à SCHEMA. */
export function sansNuls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sansNuls) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== null)
        .map(([k, x]) => [k, sansNuls(x)]),
    ) as T;
  return v;
}

function dateValide(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/** Montant en centimes affiché en euros dans les anomalies (lues par l'utilisateur). */
const eur = (c: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(c / 100);

const jourPlus = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/**
 * Contrôles de cohérence : identifiants (SIREN, SIRET, TVA), dates, totaux. Vide = la facture peut
 * être validée sans intervention ; sinon elle part dans la file « à vérifier ».
 */
export function valider(f: FactureRecue, aujourdhui = new Date().toISOString().slice(0, 10)): string[] {
  const e: string[] = [];
  if (!f.numero?.trim()) e.push("numéro absent");
  if (!f.fournisseur?.nom?.trim()) e.push("fournisseur absent");

  const { siren, siret, tvaIntracom } = f.fournisseur ?? {};
  if (siren && !sirenValide(siren)) e.push(`SIREN ${siren} invalide`);
  if (siret && !siretValide(siret)) e.push(`SIRET ${siret} invalide`);
  if (siret && siren && !siret.startsWith(siren)) e.push("SIRET et SIREN discordants");
  const s = siren ?? siret?.slice(0, 9);
  if (tvaIntracom?.startsWith("FR") && s && sirenValide(s) && tvaIntracomFr(s) !== tvaIntracom.replace(/\s/g, ""))
    e.push(`TVA ${tvaIntracom} discordante avec le SIREN ${s}`);
  if (!s && !tvaIntracom) e.push("aucun identifiant du fournisseur (SIREN, SIRET ou TVA)");

  if (!dateValide(f.date)) e.push(`date ${f.date} invalide`);
  else if (f.date > jourPlus(aujourdhui, 1)) e.push(`date ${f.date} dans le futur`);
  for (const [nom, d] of [
    ["échéance", f.echeance],
    ["date de prestation", f.datePrestation],
  ] as const)
    if (d !== undefined && !dateValide(d)) e.push(`${nom} ${d} invalide`);
  if (f.echeance && dateValide(f.echeance) && dateValide(f.date) && f.echeance < f.date)
    e.push("échéance antérieure à la date de facture");

  const t = f.totaux;
  if (!t) return [...e, "totaux absents"];
  if (t.htCents + t.tvaCents !== t.ttcCents)
    e.push(`HT + TVA ≠ TTC (${eur(t.htCents)} + ${eur(t.tvaCents)} ≠ ${eur(t.ttcCents)})`);
  if (!f.lignes?.length) return [...e, "aucune ligne"];

  const n = f.lignes.length;
  f.lignes.forEach((l, i) => {
    const attendu = Math.round(l.quantite * l.prixUnitaireHtCents);
    // Remise de ligne possible : le HT de ligne ne dépasse pas le brut (au centime près).
    if (l.htCents > attendu + 1 || l.htCents < 0 !== attendu < 0)
      e.push(`ligne ${i + 1} : HT ${eur(l.htCents)} incohérent avec ${l.quantite} × ${eur(l.prixUnitaireHtCents)}`);
  });
  const somme = f.lignes.reduce((a, l) => a + l.htCents, 0);
  if (Math.abs(somme - t.htCents) > n) e.push(`somme des lignes ${eur(somme)} ≠ HT ${eur(t.htCents)}`);
  const parTaux = new Map<number, number>();
  for (const l of f.lignes) parTaux.set(l.tauxTva, (parTaux.get(l.tauxTva) ?? 0) + l.htCents);
  const tva = [...parTaux].reduce((a, [taux, base]) => a + Math.round((base * taux) / 1000), 0);
  if (Math.abs(tva - t.tvaCents) > parTaux.size) e.push(`TVA recalculée ${eur(tva)} ≠ TVA ${eur(t.tvaCents)}`);
  return e;
}

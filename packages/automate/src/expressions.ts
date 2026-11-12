// Expressions `{{ … }}` dans les paramètres des nœuds. Aucun `eval` : un chemin dans les données suivi de
// filtres, par exemple `{{ $json.client.email }}`, `{{ $noeud.facture.json.total | euros }}`,
// `{{ $json.nom | majuscules | defaut:"inconnu" }}`. Une valeur réduite à une seule expression garde son
// type (nombre, objet) ; mêlée à du texte, elle est convertie en texte.

export interface Portee {
  json: Record<string, unknown>;
  /** Premier élément de sortie de chaque nœud déjà exécuté, par identifiant. */
  noeuds: Record<string, Record<string, unknown>>;
  secrets: Record<string, string>;
  execution: { id: string };
  workflow: { id: string; nom: string };
  index: number;
  maintenant?: Date;
}

export class ErreurExpression extends Error {}

const EXPR = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const SEULE = /^\{\{\s*([\s\S]+?)\s*\}\}$/;

/** Découpe sur `|` hors des chaînes entre guillemets. */
function decouper(source: string, sep: string): string[] {
  const parts: string[] = [];
  let cour = "";
  let guillemet: string | null = null;
  for (const c of source) {
    if (guillemet) {
      if (c === guillemet) guillemet = null;
      cour += c;
    } else if (c === '"' || c === "'") {
      guillemet = c;
      cour += c;
    } else if (c === sep) {
      parts.push(cour.trim());
      cour = "";
    } else cour += c;
  }
  parts.push(cour.trim());
  return parts;
}

function litteral(s: string): { ok: true; v: unknown } | { ok: false } {
  if (/^(["']).*\1$/s.test(s)) return { ok: true, v: s.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { ok: true, v: Number(s) };
  if (s === "vrai" || s === "true") return { ok: true, v: true };
  if (s === "faux" || s === "false") return { ok: true, v: false };
  if (s === "nul" || s === "null") return { ok: true, v: null };
  return { ok: false };
}

const SEGMENT = /^\.([\p{L}_$][\p{L}\p{N}_$-]*)|^\[\s*(?:(\d+)|"([^"]*)"|'([^']*)')\s*\]/u;

function chemin(source: string, p: Portee): unknown {
  const tete = /^\$([a-z]+)/i.exec(source);
  if (!tete) throw new ErreurExpression(`expression invalide : ${source}`);
  const racines: Record<string, unknown> = {
    json: p.json,
    noeud: Object.fromEntries(Object.entries(p.noeuds).map(([k, v]) => [k, { json: v }])),
    secret: p.secrets,
    execution: p.execution,
    workflow: p.workflow,
    index: p.index,
    now: (p.maintenant ?? new Date()).toISOString(),
    maintenant: (p.maintenant ?? new Date()).toISOString(),
    aujourdhui: (p.maintenant ?? new Date()).toISOString().slice(0, 10),
  };
  if (!(tete[1]! in racines)) throw new ErreurExpression(`variable inconnue : $${tete[1]}`);
  let v: unknown = racines[tete[1]!];
  let reste = source.slice(tete[0].length).trim();
  while (reste) {
    const m = SEGMENT.exec(reste);
    if (!m) throw new ErreurExpression(`chemin invalide : ${source}`);
    const cle = m[1] ?? m[3] ?? m[4] ?? Number(m[2]);
    v = v != null && typeof v === "object" ? (v as Record<string | number, unknown>)[cle] : undefined;
    reste = reste.slice(m[0].length).trim();
  }
  return v;
}

const texte = (v: unknown): string =>
  v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v as string | number | boolean);

const nombre = (v: unknown): number => {
  const n =
    typeof v === "number"
      ? v
      : Number(
          String(v ?? "")
            .replace(/\s/g, "")
            .replace(",", "."),
        );
  if (!Number.isFinite(n)) throw new ErreurExpression(`nombre attendu : ${texte(v)}`);
  return n;
};

type Filtre = (v: unknown, arg: unknown) => unknown;

export const FILTRES: Record<string, Filtre> = {
  majuscules: (v) => texte(v).toUpperCase(),
  minuscules: (v) => texte(v).toLowerCase(),
  rogner: (v) => texte(v).trim(),
  texte: (v) => texte(v),
  json: (v) => JSON.stringify(v),
  nombre: (v) => nombre(v),
  arrondi: (v, a) => {
    const f = 10 ** Number(a ?? 0);
    return Math.round(nombre(v) * f) / f;
  },
  euros: (v) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(nombre(v)),
  /** Montant en centimes (convention d'auto) affiché en euros. */
  centimes: (v) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(nombre(v) / 100),
  longueur: (v) => (Array.isArray(v) ? v.length : texte(v).length),
  premier: (v) => (Array.isArray(v) ? v[0] : v),
  dernier: (v) => (Array.isArray(v) ? v.at(-1) : v),
  joindre: (v, a) => (Array.isArray(v) ? v.map(texte).join(texte(a ?? ", ")) : texte(v)),
  defaut: (v, a) => (v == null || v === "" ? a : v),
  date: (v, a) => {
    const d = new Date(texte(v) || Date.now());
    if (Number.isNaN(d.getTime())) throw new ErreurExpression(`date invalide : ${texte(v)}`);
    if (a === "iso") return d.toISOString();
    if (a === "jour") return d.toISOString().slice(0, 10);
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" }).format(d);
  },
  plus_jours: (v, a) => {
    const d = new Date(texte(v) || Date.now());
    d.setUTCDate(d.getUTCDate() + Number(a ?? 0));
    return d.toISOString().slice(0, 10);
  },
};

function evaluer(source: string, p: Portee): unknown {
  const [tete = "", ...filtres] = decouper(source, "|");
  const lit = litteral(tete);
  let v = lit.ok ? lit.v : chemin(tete, p);
  for (const f of filtres) {
    const i = f.indexOf(":");
    const nom = (i < 0 ? f : f.slice(0, i)).trim();
    const fn = FILTRES[nom];
    if (!fn) throw new ErreurExpression(`filtre inconnu : ${nom}`);
    let arg: unknown;
    if (i >= 0) {
      const brut = f.slice(i + 1).trim();
      const l = litteral(brut);
      arg = l.ok ? l.v : chemin(brut, p);
    }
    v = fn(v, arg);
  }
  return v;
}

/** Résout les expressions d'une valeur de paramètre (chaînes, tableaux et objets, récursivement). */
export function resoudre(valeur: unknown, p: Portee): unknown {
  if (typeof valeur === "string") {
    if (!valeur.includes("{{")) return valeur;
    const seule = SEULE.exec(valeur);
    if (seule && !seule[1]!.includes("}}")) return evaluer(seule[1]!, p);
    return valeur.replace(EXPR, (_, src: string) => texte(evaluer(src, p)));
  }
  if (Array.isArray(valeur)) return valeur.map((v) => resoudre(v, p));
  if (valeur && typeof valeur === "object")
    return Object.fromEntries(Object.entries(valeur).map(([k, v]) => [k, resoudre(v, p)]));
  return valeur;
}

/** Noms des secrets référencés (`$secret.nom`) : l'API refuse un workflow qui cite un secret inexistant. */
export function secretsCites(valeur: unknown): string[] {
  const s = JSON.stringify(valeur ?? null);
  return [...new Set([...s.matchAll(/\$secret\.([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!))];
}

/** Lecture d'un champ à chemin pointé (`client.adresse.ville`). */
export function lire(o: unknown, champ: string): unknown {
  return champ
    .split(".")
    .reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
}

/** Écriture d'un champ à chemin pointé, en créant les objets intermédiaires. */
export function ecrire(o: Record<string, unknown>, champ: string, valeur: unknown): void {
  const cles = champ.split(".");
  let cour = o;
  for (const k of cles.slice(0, -1)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") throw new ErreurExpression("champ interdit");
    if (cour[k] == null || typeof cour[k] !== "object") cour[k] = {};
    cour = cour[k] as Record<string, unknown>;
  }
  const fin = cles.at(-1)!;
  if (fin === "__proto__" || fin === "constructor" || fin === "prototype") throw new ErreurExpression("champ interdit");
  cour[fin] = valeur;
}

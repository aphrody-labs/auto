// Catalogue des types de nœuds. Chaque type décrit ses paramètres en Zod (validation à l'enregistrement,
// formulaire de l'éditeur par JSON Schema) et s'exécute par élément ou par lot. Les accès au monde extérieur
// (réseau, mail, API d'auto) passent par les services du contexte : le moteur reste testable sans réseau et
// la garde SSRF appartient à l'appelant.
import { z } from "zod";
import { ErreurExpression, ecrire, lire } from "./expressions";
import type { Element } from "./schema";

export interface Services {
  /** `fetch` gardé : refuse les adresses internes en production. */
  fetch(url: string, init: RequestInit): Promise<Response>;
  envoyerMail?(m: { a: string; sujet: string; texte: string; pieces?: Fichier[] }): Promise<void>;
  /** Exécute un autre workflow de l'entreprise et rend ses éléments de sortie (100 au plus). */
  sousWorkflow?(id: string, entree: Element[], signal: AbortSignal): Promise<Element[]>;
  /** Tableurs par la bibliothèque native (crate auto-sheets). */
  tableur?: {
    ecrire(feuille: {
      nom: string;
      colonnes: { titre: string }[];
      lignes: (string | number | boolean | null)[][];
    }): Uint8Array;
    lire(octets: Uint8Array): { feuilles: { nom: string; lignes: (string | number | boolean | null)[][] }[] };
  };
  /** PDF par la bibliothèque native (crate auto-fichiers, pdfcraft) ; pages numérotées à partir de 1. */
  pdf?: {
    fusionner(pdfs: { nom: string; octets: Uint8Array }[]): Uint8Array;
    pages(pdf: Uint8Array, pages: number[]): Uint8Array;
    nombrePages(pdf: Uint8Array): number;
    texte(pdf: Uint8Array): string[];
  };
  /** Caviardage, signature PAdES et présentations par la bibliothèque native (crate auto-fichiers). */
  documents?: {
    caviarder(
      pdf: Uint8Array,
      o: {
        textes: string[];
        motifs: MotifCaviardage[];
        casse: boolean;
        mots_entiers: boolean;
        texte_superpose: string;
      },
    ): { pdf: Uint8Array; rapport: { occurrences: number; pages: number[]; par_recherche: unknown[] } };
    signer(
      pdf: Uint8Array,
      p12: Uint8Array,
      o: {
        mot_de_passe: string;
        raison?: string;
        lieu?: string;
        contact?: string;
        page: number;
        rectangle?: [number, number, number, number];
        certifier?: 1 | 2 | 3;
      },
    ): Uint8Array;
    signatures(pdf: Uint8Array, confiance: string): { signee: boolean; statut: string }[];
    presentation(p: {
      titre: string;
      sous_titre: string;
      diapositives: { titre: string; puces: (string | { texte: string; niveau: number })[]; notes: string }[];
    }): Uint8Array;
    presentationEnPdf(pptx: Uint8Array): Uint8Array;
  };
  /** Documents Word par la bibliothèque native (crate auto-fichiers, wordcraft). */
  word?: {
    creer(d: {
      titre?: string;
      paragraphes: { texte: string; style?: "titre" | "titre1" | "titre2" | "titre3"; gras?: boolean }[];
    }): Uint8Array;
    champs(docx: Uint8Array): string[];
    remplir(docx: Uint8Array, valeurs: Record<string, string>): Uint8Array;
    enPdf(docx: Uint8Array): Uint8Array;
    /** Texte du corps, un paragraphe par ligne. */
    texte?(docx: Uint8Array): string;
  };
  /** Images par Bun.Image (transformation et encodage natifs). */
  image?(
    octets: Uint8Array,
    o: OperationsImage,
  ): Promise<{
    octets: Uint8Array;
    type: string;
    largeur: number;
    hauteur: number;
    source: { largeur: number; hauteur: number; format: string };
  }>;
  /** Vidéos par Bun.Video (fournisseur natif FilmCraft). */
  video?: {
    metadonnees(octets: Uint8Array): Promise<Record<string, unknown>>;
    image(octets: Uint8Array, secondes: number, largeur?: number): Promise<Uint8Array>;
    gif(octets: Uint8Array, debut: number, duree: number, largeur: number): Promise<Uint8Array>;
  };
  /** Page web rendue par Bun.WebView (JavaScript exécuté, comme dans un navigateur). */
  navigateur?(
    url: string,
    o: { largeur: number; hauteur: number; attendreMs: number; texte: boolean; capture: boolean },
  ): Promise<{ titre: string; texte: string | null; capture: Uint8Array | null }>;
  /** Appel de l'API d'auto au nom de l'entreprise du workflow. */
  appelerAuto?(methode: string, chemin: string, corps?: unknown): Promise<{ statut: number; corps: unknown }>;
  /** JavaScript de l'utilisateur dans un bac à sable (sans réseau, ni fichiers, ni Bun), temps et mémoire bornés. */
  script?(code: string, donnees: DonneesScript): Promise<{ resultat: unknown; journal: string[] }>;
  /** Mémoire du workflow conservée d'une exécution à l'autre (clé par nœud). */
  memoire?: { lire(cle: string): Promise<unknown>; ecrire(cle: string, valeur: unknown): Promise<void> };
  /** Base de connaissances de l'entreprise (RAG) : découpage et recherche natifs, embeddings par l'API donnée. */
  connaissance?: {
    indexer(
      o: { base: string; source: string; texte: string; taille?: number; embeddings: ApiEmbeddings },
      signal: AbortSignal,
    ): Promise<{ morceaux: number; remplaces: number }>;
    rechercher(
      o: { base: string; question: string; k: number; scoreMin: number; diversite?: number; embeddings: ApiEmbeddings },
      signal: AbortSignal,
    ): Promise<MorceauTrouve[]>;
  };
}

/** API d'embeddings compatible OpenAI (`POST <url>/embeddings`) : aphrody-llama-server, Ollama, OpenAI… */
export interface ApiEmbeddings {
  url: string;
  modele: string;
  cle?: string;
}

export interface MorceauTrouve {
  source: string;
  position: number;
  texte: string;
  score: number;
}

export interface DonneesScript {
  elements: Record<string, unknown>[];
  /** Élément courant (mode par élément). */
  json: Record<string, unknown> | null;
  noeuds: Record<string, Record<string, unknown>>;
  execution: { id: string };
  workflow: { id: string; nom: string };
}

/** Résultat d'un script → éléments : liste d'objets ou de `{ json }`, un objet seul, ou rien. */
export function elementsDe(r: unknown): Element[] {
  const liste = r == null ? [] : Array.isArray(r) ? r : [r];
  return liste.map((x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      return o.json && typeof o.json === "object" && !Array.isArray(o.json)
        ? { json: o.json as Record<string, unknown> }
        : { json: o };
    }
    return { json: { valeur: x } };
  });
}

/** Fichier transporté dans un élément (pièce jointe, tableur, PDF ou document généré). */
export interface Fichier {
  nom: string;
  type: string;
  base64: string;
}

const Fichier = z.object({
  nom: z.string().min(1).max(200),
  type: z.string().min(1),
  base64: z.string().max(14_000_000),
});

export interface OperationsImage {
  largeur?: number;
  hauteur?: number;
  ajustement: "inside" | "fill";
  recadrer?: { left: number; top: number; width: number; height: number };
  rotation?: 0 | 90 | 180 | 270;
  niveauxDeGris: boolean;
  luminosite: number;
  format: "origine" | "jpeg" | "png" | "webp";
  qualite: number;
}

export interface Contexte {
  services: Services;
  signal: AbortSignal;
  /** Identifiant du nœud en cours. */
  noeud: string;
  /** Sorties des nœuds déjà exécutés (premier élément), exécution et workflow : pour le nœud Code. */
  vus: Record<string, Record<string, unknown>>;
  execution: { id: string };
  workflow: { id: string; nom: string };
}

export type Categorie = "declencheur" | "logique" | "donnees" | "reseau" | "communication" | "ia" | "auto";

/** Sorties d'un nœud : un tableau d'éléments par sortie. */
export type Sorties = Element[][];

export interface TypeNoeud<P extends z.ZodType = z.ZodType> {
  type: string;
  libelle: string;
  description: string;
  categorie: Categorie;
  /** Nom Material Symbols. */
  icone: string;
  parametres: P;
  /** Libellés des sorties (une seule par défaut), éventuellement selon les paramètres. */
  sorties?: string[] | ((p: z.output<P>) => string[]);
  /** Exécution pour chaque élément, paramètres résolus sur cet élément. */
  element?: (p: z.output<P>, el: Element, ctx: Contexte) => Promise<Sorties>;
  /** Exécution une fois pour tous les éléments, paramètres résolus sur le premier. */
  lot?: (p: z.output<P>, els: Element[], ctx: Contexte) => Promise<Sorties>;
}

const def = <P extends z.ZodType>(t: TypeNoeud<P>) => t as unknown as TypeNoeud;

// ── Conditions ─────────────────────────────────────────────────────────────

const OPERATEURS = [
  "egal",
  "different",
  "contient",
  "ne_contient_pas",
  "commence_par",
  "superieur",
  "inferieur",
  "vide",
  "non_vide",
  "vrai",
  "faux",
  "correspond",
] as const;

const Condition = z.object({
  gauche: z.unknown(),
  operateur: z.enum(OPERATEURS),
  droite: z.unknown().optional(),
});

const Conditions = z.object({
  conditions: z.array(Condition).min(1).max(20),
  combinaison: z.enum(["et", "ou"]).default("et"),
});

const t = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v as string));
const n = (v: unknown) => (typeof v === "number" ? v : Number(t(v).replace(",", ".")));

export function tester(c: z.output<typeof Condition>): boolean {
  const { gauche: g, droite: d } = c;
  switch (c.operateur) {
    case "egal":
      return typeof g === "number" || typeof d === "number" ? n(g) === n(d) : t(g) === t(d);
    case "different":
      return typeof g === "number" || typeof d === "number" ? n(g) !== n(d) : t(g) !== t(d);
    case "contient":
      return Array.isArray(g) ? g.map(t).includes(t(d)) : t(g).includes(t(d));
    case "ne_contient_pas":
      return Array.isArray(g) ? !g.map(t).includes(t(d)) : !t(g).includes(t(d));
    case "commence_par":
      return t(g).startsWith(t(d));
    case "superieur":
      return n(g) > n(d);
    case "inferieur":
      return n(g) < n(d);
    case "vide":
      return g == null || g === "" || (Array.isArray(g) && g.length === 0);
    case "non_vide":
      return !(g == null || g === "" || (Array.isArray(g) && g.length === 0));
    case "vrai":
      return g === true || g === "true" || g === 1;
    case "faux":
      return !(g === true || g === "true" || g === 1);
    case "correspond": {
      const motif = t(d);
      if (motif.length > 200) throw new ErreurExpression("motif trop long (200 caractères au plus)");
      return new RegExp(motif, "u").test(t(g));
    }
  }
}

const verifier = (p: z.output<typeof Conditions>) =>
  p.combinaison === "et" ? p.conditions.every(tester) : p.conditions.some(tester);

// ── Réseau ─────────────────────────────────────────────────────────────────

const Paire = z.object({ nom: z.string().min(1), valeur: z.unknown() });

async function lireReponse(r: Response, format: "json" | "texte" | "auto") {
  const type = r.headers.get("content-type") ?? "";
  const brut = await r.text();
  if (brut.length > 5_000_000) throw new Error("réponse trop volumineuse (5 Mo au plus)");
  if (format === "texte" || (format === "auto" && !type.includes("json"))) return brut;
  try {
    return brut ? JSON.parse(brut) : null;
  } catch {
    if (format === "json") throw new Error("réponse JSON invalide");
    return brut;
  }
}

/** Requête JSON (corps sérialisé ; une chaîne ou des octets partent tels quels) ; erreur HTTP explicite. */
async function appeler(
  ctx: Contexte,
  methode: string,
  url: string,
  corps: unknown,
  entetes: Record<string, string> = {},
) {
  const brut = typeof corps === "string" || corps instanceof Uint8Array;
  const r = await ctx.services.fetch(url, {
    method: methode,
    headers: { ...(brut || corps === undefined ? {} : { "content-type": "application/json" }), ...entetes },
    body: corps === undefined ? undefined : brut ? (corps as BodyInit) : JSON.stringify(corps),
    signal: ctx.signal,
  });
  const reponse = await lireReponse(r, "auto");
  if (!r.ok) throw new Error(`HTTP ${r.status} : ${t(reponse).slice(0, 300)}`);
  return reponse;
}

const poster = (ctx: Contexte, url: string, corps: unknown, entetes: Record<string, string> = {}) =>
  appeler(ctx, "POST", url, corps, entetes);

/** Empreinte FNV-1a 32 bits (JS pur : le moteur tourne aussi dans le navigateur). */
function empreinte(texte: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) h = Math.imul(h ^ texte.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Clé stable par exécution, nœud et élément : un nouvel essai ne double pas l'envoi. */
const cleUnique = (ctx: Contexte, el: Element) =>
  `auto-${ctx.execution.id}-${ctx.noeud}-${empreinte(JSON.stringify(el.json))}`;

/** URL de base d'un service auto-hébergé, sans barre finale. */
const base = (url: string) => url.replace(/\/+$/, "");
const porteur = (jeton: string) => ({ authorization: `Bearer ${jeton}` });

const une = (els: Element[]): Sorties => [els];
const avec = (el: Element, champs: Record<string, unknown>): Element => ({ json: { ...el.json, ...champs } });

// ── Fichiers PDF et Word ───────────────────────────────────────────────────

/** Fichier d'entrée : `{ nom, type, base64 }` (sortie d'un autre nœud) ou URL téléchargée. */
const SourceFichier = z.object({
  fichier: z.union([Fichier, z.literal(""), z.null()]).default(null),
  url: z.string().default(""),
});

const OCTETS_MAX = 20_000_000;

async function source(p: { fichier: Fichier | "" | null; url: string }, ctx: Contexte) {
  if (p.fichier) return { nom: p.fichier.nom, octets: Uint8Array.fromBase64(p.fichier.base64) };
  if (!p.url) throw new Error("fichier ou URL requis");
  const r = await ctx.services.fetch(p.url, { signal: ctx.signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const octets = await r.bytes();
  if (octets.length > OCTETS_MAX) throw new Error("fichier trop volumineux (20 Mo au plus)");
  return { nom: decodeURIComponent(new URL(p.url).pathname.split("/").pop() || "fichier"), octets };
}

function natif(ctx: Contexte) {
  const { pdf, word } = ctx.services;
  if (!pdf || !word) throw new Error("bibliothèque native indisponible");
  return { pdf, word };
}

function octetsPdf(f: Fichier) {
  const o = Uint8Array.fromBase64(f.base64);
  if (!new TextDecoder().decode(o.subarray(0, 1024)).includes("%PDF-"))
    throw new Error(`« ${f.nom} » n'est pas un PDF`);
  return o;
}

const nomFichier = (nom: string) => nom.replace(/[^\p{L}\p{N} _-]/gu, "_");

const fichierPdf = (nom: string, octets: Uint8Array): Fichier => ({
  nom: `${nomFichier(nom)}.pdf`,
  type: "application/pdf",
  base64: octets.toBase64(),
});

/** « 1-3, 5, 8- » → [1, 2, 3, 5, 8, …, total] ; pages numérotées à partir de 1. */
export function plagesPages(spec: string, total: number): number[] {
  const pages: number[] = [];
  for (const morceau of spec
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(morceau);
    if (!m || (!m[1] && !m[3])) throw new Error(`pages invalides : « ${morceau} »`);
    const debut = Number(m[1] ?? 1);
    const fin = m[2] ? Number(m[3] ?? total) : debut;
    if (debut < 1 || fin > total || debut > fin)
      throw new Error(`pages hors du document (${total} page${total > 1 ? "s" : ""}) : « ${morceau} »`);
    for (let i = debut; i <= fin; i++) pages.push(i);
  }
  if (pages.length > 5000) throw new Error("5 000 pages au plus");
  return pages;
}

// ── Base de connaissances ──────────────────────────────────────────────────

/** API compatible OpenAI par défaut des nœuds IA : `AUTO_IA_URL` du serveur (Ollama de l'Aphrody Box), sinon local. */
const IA_URL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AUTO_IA_URL ||
  "http://localhost:11434/v1";

const BASE_CONNAISSANCE = /^[a-z0-9_-]{1,60}$/;

/** API d'embeddings compatible OpenAI ; clé par `{{ $secret.nom }}`. */
const ParametresEmbeddings = {
  api: z.string().default(IA_URL),
  modele: z.string().min(1).max(200).default("nomic-embed-text"),
  cle: z.string().default(""),
};

const embeddingsDe = (p: { api: string; modele: string; cle: string }): ApiEmbeddings => ({
  url: p.api,
  modele: p.modele,
  ...(p.cle ? { cle: p.cle } : {}),
});

function connaissance(ctx: Contexte) {
  if (!ctx.services.connaissance) throw new Error("base de connaissances indisponible");
  return ctx.services.connaissance;
}

/** Texte d'un document : PDF (couche texte) et Word par la bibliothèque native, sinon UTF-8. */
function texteDocument(nom: string, octets: Uint8Array, ctx: Contexte): string {
  const debut = new TextDecoder().decode(octets.subarray(0, 1024));
  if (debut.includes("%PDF-")) return natif(ctx).pdf.texte(octets).join("\n\n");
  if (debut.startsWith("PK") && /\.docx$/i.test(nom)) {
    const texte = ctx.services.word?.texte;
    if (!texte) throw new Error("bibliothèque native indisponible");
    return texte(octets);
  }
  return new TextDecoder().decode(octets);
}

// ── Caviardage, signature, présentations ───────────────────────────────────

export const MOTIFS_CAVIARDAGE = ["iban", "email", "telephone", "carte", "date"] as const;
export type MotifCaviardage = (typeof MOTIFS_CAVIARDAGE)[number];

function documents(ctx: Contexte) {
  const d = ctx.services.documents;
  if (!d) throw new Error("bibliothèque native indisponible");
  return d;
}

const Diapositive = z.object({
  titre: z.string().max(500).default(""),
  puces: z
    .array(
      z.union([
        z.string().max(5000),
        z.object({ texte: z.string().max(5000), niveau: z.number().int().min(0).max(4).default(0) }),
      ]),
    )
    .max(100)
    .default([]),
  notes: z.string().max(20_000).default(""),
});

// ── Web : HTMLRewriter (extraction) et Bun.XML (flux) ──────────────────────

/** Valeurs des sélecteurs CSS d'une page, par le parseur HTML en flux de Bun. */
export function extraireHtml(
  html: string,
  champs: { nom: string; selecteur: string; attribut: string; tous: boolean }[],
): Record<string, string | string[] | null> {
  const valeurs = champs.map(() => [] as string[]);
  let rw = new HTMLRewriter();
  for (const [i, c] of champs.entries()) {
    const liste = valeurs[i]!;
    let cour: string | null = null;
    rw = rw.on(c.selecteur, {
      element(e) {
        if (c.attribut) liste.push(e.getAttribute(c.attribut) ?? "");
        else {
          cour = "";
          liste.push("");
          const indice = liste.length - 1;
          e.onEndTag(() => {
            liste[indice] = (cour ?? "").replace(/\s+/g, " ").trim();
            cour = null;
          });
        }
      },
      text(t) {
        if (cour !== null) cour += t.text;
      },
    });
  }
  rw.transform(html);
  return Object.fromEntries(champs.map((c, i) => [c.nom, c.tous ? valeurs[i]! : (valeurs[i]![0] ?? null)]));
}

const enListe = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const enTexte = (v: unknown): string =>
  v == null ? "" : typeof v === "object" ? t((v as Record<string, unknown>)["#text"] ?? "") : t(v);

/** Articles d'un flux RSS 2.0 ou Atom, par le parseur XML natif de Bun. */
export function lireFlux(xml: string): Record<string, unknown>[] {
  const doc = Bun.XML.parse(xml) as Record<string, Record<string, unknown>>;
  if (doc.rss) {
    const canal = (doc.rss.channel ?? {}) as Record<string, unknown>;
    return enListe(canal.item).map((x) => {
      const i = x as Record<string, unknown>;
      return {
        titre: enTexte(i.title),
        lien: enTexte(i.link),
        date: enTexte(i.pubDate),
        resume: enTexte(i.description),
        id: enTexte(i.guid) || enTexte(i.link),
      };
    });
  }
  if (doc.feed)
    return enListe(doc.feed.entry).map((x) => {
      const i = x as Record<string, unknown>;
      const liens = enListe(i.link) as Record<string, unknown>[];
      const lien = liens.find((l) => !l?.["@rel"] || l["@rel"] === "alternate") ?? liens[0];
      return {
        titre: enTexte(i.title),
        lien: t(lien?.["@href"] ?? ""),
        date: enTexte(i.updated ?? i.published),
        resume: enTexte(i.summary ?? i.content),
        id: enTexte(i.id),
      };
    });
  throw new Error("ni RSS ni Atom");
}

// ── Catalogue ──────────────────────────────────────────────────────────────

export const TYPES: TypeNoeud[] = [
  def({
    type: "declencheur.manuel",
    libelle: "Lancement manuel",
    description: "Démarre le workflow depuis l'éditeur, l'API ou le CLI, avec des données d'essai.",
    categorie: "declencheur",
    icone: "play_circle",
    parametres: z.object({ donnees: z.record(z.string(), z.unknown()).default({}) }),
  }),
  def({
    type: "declencheur.evenement",
    libelle: "Événement auto",
    description: "Démarre à chaque événement de l'entreprise : facture émise, paiement reçu, absence…",
    categorie: "declencheur",
    icone: "bolt",
    parametres: z.object({
      types: z
        .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/))
        .min(1)
        .max(30),
    }),
  }),
  def({
    type: "declencheur.planifie",
    libelle: "Planification",
    description: "Démarre selon une expression cron (minute heure jour mois jour-de-semaine).",
    categorie: "declencheur",
    icone: "schedule",
    parametres: z.object({
      cron: z.string().refine((c) => {
        try {
          Bun.cron.parse(c);
          return true;
        } catch {
          return false;
        }
      }, "expression cron invalide (5 champs)"),
      fuseau: z.string().default("Europe/Paris"),
    }),
  }),
  def({
    type: "declencheur.webhook",
    libelle: "Webhook entrant",
    description: "Démarre à chaque requête reçue sur l'URL secrète du workflow.",
    categorie: "declencheur",
    icone: "webhook",
    parametres: z.object({
      reponse: z.enum(["immediate", "fin"]).default("immediate"),
    }),
  }),

  def({
    type: "logique.si",
    libelle: "Si",
    description: "Oriente chaque élément vers « vrai » ou « faux » selon des conditions.",
    categorie: "logique",
    icone: "call_split",
    parametres: Conditions,
    sorties: ["vrai", "faux"],
    element: async (p, el) => (verifier(p) ? [[el], []] : [[], [el]]),
  }),
  def({
    type: "logique.aiguillage",
    libelle: "Aiguillage",
    description: "Oriente chaque élément vers la sortie dont la valeur correspond.",
    categorie: "logique",
    icone: "alt_route",
    parametres: z.object({ valeur: z.unknown(), cas: z.array(z.string()).min(1).max(10) }),
    sorties: (p) => [...p.cas, "autre"],
    element: async (p, el) => {
      const i = p.cas.indexOf(t(p.valeur));
      const sorties: Sorties = Array.from({ length: p.cas.length + 1 }, () => []);
      sorties[i < 0 ? p.cas.length : i]!.push(el);
      return sorties;
    },
  }),
  def({
    type: "logique.attendre",
    libelle: "Attendre",
    description: "Marque une pause (60 secondes au plus) avant de continuer.",
    categorie: "logique",
    icone: "hourglass",
    parametres: z.object({ secondes: z.number().min(0).max(60) }),
    lot: async (p, els, ctx) => {
      await new Promise<void>((ok, ko) => {
        const h = setTimeout(ok, p.secondes * 1000);
        ctx.signal.addEventListener("abort", () => (clearTimeout(h), ko(new Error("exécution interrompue"))), {
          once: true,
        });
      });
      return une(els);
    },
  }),
  def({
    type: "logique.passer",
    libelle: "Laisser passer",
    description: "Transmet les éléments sans les modifier : point de jonction, ou emplacement d'un nœud à remplacer.",
    categorie: "logique",
    icone: "arrow_forward",
    parametres: z.object({}),
    lot: async (_p, els) => une(els),
  }),
  def({
    type: "logique.arreter",
    libelle: "Arrêter en erreur",
    description: "Interrompt l'exécution avec un message d'erreur.",
    categorie: "logique",
    icone: "block",
    parametres: z.object({ message: z.string().min(1).max(500) }),
    element: async (p) => {
      throw new Error(p.message);
    },
  }),

  def({
    type: "donnees.definir",
    libelle: "Définir des champs",
    description: "Ajoute ou remplace des champs, valeurs fixes ou expressions.",
    categorie: "donnees",
    icone: "edit_note",
    parametres: z.object({
      champs: z.array(Paire).min(1).max(50),
      conserver: z.boolean().default(true),
    }),
    element: async (p, el) => {
      const json: Record<string, unknown> = p.conserver ? structuredClone(el.json) : {};
      for (const c of p.champs) ecrire(json, c.nom, c.valeur);
      return une([{ json }]);
    },
  }),
  def({
    type: "donnees.filtrer",
    libelle: "Filtrer",
    description: "Ne garde que les éléments qui remplissent les conditions.",
    categorie: "donnees",
    icone: "filter_alt",
    parametres: Conditions,
    element: async (p, el) => une(verifier(p) ? [el] : []),
  }),
  def({
    type: "donnees.code",
    libelle: "Code",
    description:
      'JavaScript libre dans un bac à sable : $input.all(), items, $json, $("nœud").first().json ; renvoie une liste d\'objets.',
    categorie: "donnees",
    icone: "code",
    parametres: z.object({
      code: z.string().min(1).max(50_000),
      mode: z.enum(["lot", "element"]).default("lot"),
    }),
    async lot(p, els, ctx) {
      if (!ctx.services.script) throw new Error("bac à sable JavaScript indisponible");
      const base = { noeuds: ctx.vus, execution: ctx.execution, workflow: ctx.workflow };
      if (p.mode === "lot") {
        const r = await ctx.services.script(p.code, {
          ...base,
          elements: els.map((e) => e.json),
          json: els[0]?.json ?? null,
        });
        return une(elementsDe(r.resultat));
      }
      const sortie: Element[] = [];
      for (const e of els) {
        const r = await ctx.services.script(p.code, { ...base, elements: [e.json], json: e.json });
        sortie.push(...elementsDe(r.resultat));
      }
      return une(sortie);
    },
  }),
  def({
    type: "donnees.trier",
    libelle: "Trier",
    description: "Trie les éléments selon un champ.",
    categorie: "donnees",
    icone: "sort",
    parametres: z.object({
      champ: z.string().min(1),
      ordre: z.enum(["croissant", "decroissant"]).default("croissant"),
    }),
    lot: async (p, els) => {
      const s = p.ordre === "croissant" ? 1 : -1;
      return une(
        els.toSorted((a, b) => {
          const x = lire(a.json, p.champ);
          const y = lire(b.json, p.champ);
          if (typeof x === "number" && typeof y === "number") return (x - y) * s;
          return t(x).localeCompare(t(y), "fr") * s;
        }),
      );
    },
  }),
  def({
    type: "donnees.limiter",
    libelle: "Limiter",
    description: "Ne garde que les N premiers éléments.",
    categorie: "donnees",
    icone: "low_priority",
    parametres: z.object({ max: z.number().int().min(1).max(5000) }),
    lot: async (p, els) => une(els.slice(0, p.max)),
  }),
  def({
    type: "donnees.dedoublonner",
    libelle: "Dédoublonner",
    description: "Retire les éléments dont le champ a déjà été vu.",
    categorie: "donnees",
    icone: "filter_none",
    parametres: z.object({ champ: z.string().min(1) }),
    lot: async (p, els) => {
      const vus = new Set<string>();
      return une(els.filter((e) => !vus.has(t(lire(e.json, p.champ))) && vus.add(t(lire(e.json, p.champ)))));
    },
  }),
  def({
    type: "donnees.nouveaux",
    libelle: "Seulement les nouveaux",
    description: "Ne laisse passer que les éléments jamais vus lors des exécutions précédentes (veille, flux, API).",
    categorie: "donnees",
    icone: "fiber_new",
    parametres: z.object({ champ: z.string().min(1), memoire: z.number().int().min(10).max(10_000).default(1000) }),
    lot: async (p, els, ctx) => {
      const m = ctx.services.memoire;
      if (!m) throw new Error("mémoire du workflow indisponible");
      const cle = `vus:${ctx.noeud}`;
      const deja = (await m.lire(cle)) as string[] | undefined;
      const vus = new Set(Array.isArray(deja) ? deja : []);
      const nouveaux = els.filter((e) => {
        const v = t(lire(e.json, p.champ));
        if (!v || vus.has(v)) return false;
        vus.add(v);
        return true;
      });
      await m.ecrire(cle, [...vus].slice(-p.memoire));
      return une(nouveaux);
    },
  }),
  def({
    type: "donnees.agreger",
    libelle: "Regrouper",
    description: "Réunit tous les éléments en un seul, sous forme de liste.",
    categorie: "donnees",
    icone: "stacks",
    parametres: z.object({
      champ: z.string().min(1).default("elements"),
      /** Ne garder que ce champ de chaque élément (liste de valeurs). */
      valeur: z.string().default(""),
    }),
    lot: async (p, els) =>
      une([{ json: { [p.champ]: els.map((e) => (p.valeur ? lire(e.json, p.valeur) : e.json)), nombre: els.length } }]),
  }),
  def({
    type: "donnees.separer",
    libelle: "Éclater une liste",
    description: "Produit un élément par entrée d'une liste.",
    categorie: "donnees",
    icone: "call_split",
    parametres: z.object({ champ: z.string().min(1) }),
    element: async (p, el) => {
      const liste = lire(el.json, p.champ);
      if (!Array.isArray(liste)) throw new Error(`« ${p.champ} » n'est pas une liste`);
      return une(
        liste.map((v) => ({ json: v && typeof v === "object" && !Array.isArray(v) ? { ...v } : { valeur: v } })),
      );
    },
  }),

  def({
    type: "fichier.tableur",
    libelle: "Créer un tableur",
    description: "Réunit les éléments dans un classeur Excel (une ligne par élément), prêt à joindre à un mail.",
    categorie: "donnees",
    icone: "table_view",
    parametres: z.object({
      nom: z.string().min(1).max(120).default("export"),
      colonnes: z
        .array(z.object({ titre: z.string().min(1), champ: z.string().min(1) }))
        .min(1)
        .max(100),
    }),
    lot: async (p, els, ctx) => {
      if (!ctx.services.tableur) throw new Error("bibliothèque native indisponible");
      const lignes = els.map((e) =>
        p.colonnes.map((c) => {
          const v = lire(e.json, c.champ);
          return v == null || typeof v === "number" || typeof v === "boolean" ? (v ?? null) : t(v);
        }),
      );
      const octets = ctx.services.tableur.ecrire({ nom: p.nom.slice(0, 31), colonnes: p.colonnes, lignes });
      const fichier: Fichier = {
        nom: `${p.nom.replace(/[^\p{L}\p{N} _-]/gu, "_")}.xlsx`,
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        base64: octets.toBase64(),
      };
      return une([{ json: { fichier, lignes: lignes.length } }]);
    },
  }),
  def({
    type: "fichier.lire_tableur",
    libelle: "Lire un tableur",
    description:
      "Télécharge un classeur (xlsx, ods, csv) et produit un élément par ligne, la première servant d'en-tête.",
    categorie: "donnees",
    icone: "grid_on",
    parametres: z.object({ url: z.string().min(1), feuille: z.string().default("") }),
    element: async (p, _el, ctx) => {
      if (!ctx.services.tableur) throw new Error("bibliothèque native indisponible");
      const r = await ctx.services.fetch(p.url, { signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const octets = await r.bytes();
      if (octets.length > 20_000_000) throw new Error("classeur trop volumineux (20 Mo au plus)");
      const { feuilles } = ctx.services.tableur.lire(octets);
      const f = p.feuille ? feuilles.find((x) => x.nom === p.feuille) : feuilles[0];
      if (!f) throw new Error(`feuille introuvable : ${p.feuille}`);
      const [entete = [], ...lignes] = f.lignes;
      const cles = entete.map((c, i) => t(c) || `colonne_${i + 1}`);
      return une(
        lignes.slice(0, 5000).map((l) => ({ json: Object.fromEntries(cles.map((c, i) => [c, l[i] ?? null])) })),
      );
    },
  }),
  def({
    type: "fichier.pdf_fusionner",
    libelle: "Fusionner des PDF",
    description:
      "Réunit les PDF des éléments (ou une liste de fichiers) en un seul, dans l'ordre, un signet par fichier.",
    categorie: "donnees",
    icone: "picture_as_pdf",
    parametres: z.object({
      /** Liste explicite, par exemple `{{ $json.pieces }}` ; vide : le champ `champ` de chaque élément. */
      fichiers: z.array(Fichier).max(50).default([]),
      champ: z.string().min(1).default("fichier"),
      nom: z.string().min(1).max(120).default("fusion"),
    }),
    lot: async (p, els, ctx) => {
      const pdf = natif(ctx).pdf;
      const fichiers = p.fichiers.length
        ? p.fichiers
        : els.flatMap((e) => {
            const v = lire(e.json, p.champ);
            return (Array.isArray(v) ? v : [v]).filter((f) => f != null && f !== "").map((f) => Fichier.parse(f));
          });
      if (!fichiers.length) throw new Error(`aucun fichier dans « ${p.champ} »`);
      if (fichiers.length > 50) throw new Error("50 PDF au plus");
      const octets = pdf.fusionner(fichiers.map((f) => ({ nom: f.nom, octets: octetsPdf(f) })));
      return une([{ json: { fichier: fichierPdf(p.nom, octets), fichiers: fichiers.length } }]);
    },
  }),
  def({
    type: "fichier.pdf_pages",
    libelle: "Extraire des pages d'un PDF",
    description: "Garde les pages choisies d'un PDF (« 1-3, 5, 8- »), dans l'ordre indiqué.",
    categorie: "donnees",
    icone: "auto_stories",
    parametres: SourceFichier.extend({
      pages: z.string().min(1).max(500),
      nom: z.string().max(120).default(""),
    }),
    element: async (p, el, ctx) => {
      const pdf = natif(ctx).pdf;
      const { nom, octets } = await source(p, ctx);
      const pages = plagesPages(p.pages, pdf.nombrePages(octets));
      const fichier = fichierPdf(p.nom || `${nom.replace(/\.pdf$/i, "")}-pages`, pdf.pages(octets, pages));
      return une([avec(el, { fichier, pages: pages.length })]);
    },
  }),
  def({
    type: "fichier.pdf_texte",
    libelle: "Lire le texte d'un PDF",
    description:
      "Extrait le texte d'un PDF dans l'ordre de lecture (par exemple avant un nœud IA). Un scan sans couche texte donne un texte vide.",
    categorie: "donnees",
    icone: "text_snippet",
    parametres: SourceFichier.extend({ champ: z.string().min(1).default("texte") }),
    element: async (p, el, ctx) => {
      const pages = natif(ctx).pdf.texte((await source(p, ctx)).octets);
      const sortie = { ...el.json };
      ecrire(sortie, p.champ, pages.join("\n\n"));
      return une([{ json: { ...sortie, pages: pages.length } }]);
    },
  }),
  def({
    type: "fichier.pdf_caviarder",
    libelle: "Caviarder un PDF",
    description:
      "Supprime définitivement les textes choisis et les IBAN, e-mails, téléphones, cartes ou dates d'un PDF (contenu effacé sous un pavé noir, vérifié) et compte les occurrences.",
    categorie: "donnees",
    icone: "ink_eraser",
    parametres: SourceFichier.extend({
      /** Textes ou expressions : une liste (`{{ $json.noms }}`) ou un par ligne. */
      textes: z.union([z.array(z.string().max(256)).max(1000), z.string().max(256_000)]).default([]),
      motifs: z.array(z.enum(MOTIFS_CAVIARDAGE)).max(5).default([]),
      casse: z.boolean().default(false),
      motsEntiers: z.boolean().default(false),
      /** Texte écrit sur chaque pavé (Helvetica, caractères latins). */
      texteSuperpose: z.string().max(200).default(""),
      nom: z.string().max(120).default(""),
    }),
    element: async (p, el, ctx) => {
      const { nom, octets } = await source(p, ctx);
      const textes = (typeof p.textes === "string" ? p.textes.split("\n") : p.textes)
        .map((x) => x.trim())
        .filter(Boolean);
      if (!textes.length && !p.motifs.length) throw new Error("textes ou motifs requis");
      const { pdf, rapport } = documents(ctx).caviarder(octets, {
        textes,
        motifs: p.motifs,
        casse: p.casse,
        mots_entiers: p.motsEntiers,
        texte_superpose: p.texteSuperpose,
      });
      const fichier = fichierPdf(p.nom || `${nom.replace(/\.pdf$/i, "")}-caviarde`, pdf);
      return une([
        avec(el, {
          fichier,
          occurrences: rapport.occurrences,
          pagesCaviardees: rapport.pages,
          parRecherche: rapport.par_recherche,
        }),
      ]);
    },
  }),
  def({
    type: "fichier.pdf_signer",
    libelle: "Signer un PDF",
    description:
      "Signature électronique PAdES (B-B) avec un certificat PKCS #12 (.p12, .pfx) gardé en secret ; visible ou invisible, éventuellement certifiante.",
    categorie: "donnees",
    icone: "signature",
    parametres: SourceFichier.extend({
      /** Certificat PKCS #12 en base64, par exemple `{{ $secret.certificat }}`, ou fichier. */
      certificat: z.union([Fichier, z.string().min(1).max(1_000_000)]),
      /** Par exemple `{{ $secret.certificat_mot_de_passe }}`. */
      motDePasse: z.string().max(1000).default(""),
      raison: z.string().max(500).default(""),
      lieu: z.string().max(200).default(""),
      contact: z.string().max(200).default(""),
      visible: z.boolean().default(false),
      page: z.number().int().min(1).default(1),
      /** `[x0, y0, x1, y1]` en points depuis le coin bas gauche ; par défaut 200 × 60 en bas à gauche. */
      rectangle: z.array(z.number()).length(4).nullable().default(null),
      certifier: z.enum(["non", "aucune_modification", "formulaires", "commentaires"]).default("non"),
      nom: z.string().max(120).default(""),
    }),
    element: async (p, el, ctx) => {
      const { nom, octets } = await source(p, ctx);
      const p12 = Uint8Array.fromBase64(typeof p.certificat === "string" ? p.certificat.trim() : p.certificat.base64);
      const rectangle = p.visible ? ((p.rectangle ?? [36, 36, 236, 96]) as [number, number, number, number]) : null;
      const certifier = { non: null, aucune_modification: 1, formulaires: 2, commentaires: 3 } as const;
      const niveau = certifier[p.certifier];
      const signe = documents(ctx).signer(octets, p12, {
        mot_de_passe: p.motDePasse,
        page: p.page - 1,
        ...(p.raison ? { raison: p.raison } : {}),
        ...(p.lieu ? { lieu: p.lieu } : {}),
        ...(p.contact ? { contact: p.contact } : {}),
        ...(rectangle ? { rectangle } : {}),
        ...(niveau ? { certifier: niveau } : {}),
      });
      return une([avec(el, { fichier: fichierPdf(p.nom || `${nom.replace(/\.pdf$/i, "")}-signe`, signe) })]);
    },
  }),
  def({
    type: "fichier.pdf_verifier_signature",
    libelle: "Vérifier les signatures d'un PDF",
    description:
      "Liste et vérifie les signatures électroniques d'un PDF : intégrité, signataire, modifications après signature, confiance dans le certificat.",
    categorie: "donnees",
    icone: "verified",
    parametres: SourceFichier.extend({
      /** Certificats de confiance (PEM) ; sans eux, une signature intacte a une identité « inconnue ». */
      confiance: z.string().max(1_000_000).default(""),
    }),
    element: async (p, el, ctx) => {
      const signatures = documents(ctx).signatures((await source(p, ctx)).octets, p.confiance);
      const signees = signatures.filter((s) => s.signee);
      return une([
        avec(el, {
          signatures,
          signe: signees.length > 0,
          intacte: signees.length > 0 && signees.every((s) => s.statut !== "invalide"),
          valide: signees.length > 0 && signees.every((s) => s.statut === "valide"),
        }),
      ]);
    },
  }),
  def({
    type: "fichier.presentation",
    libelle: "Créer une présentation",
    description:
      "Présentation PowerPoint (PPTX 16:9) : une diapositive de titre puis une diapositive titre et puces par élément (ou par entrée de la liste) ; en PPTX, en PDF ou les deux.",
    categorie: "donnees",
    icone: "slideshow",
    parametres: z.object({
      titre: z.string().max(500).default(""),
      sousTitre: z.string().max(2000).default(""),
      /** Liste explicite ; vide : une diapositive par élément, lue dans les champs ci-dessous. */
      diapositives: z.array(Diapositive).max(500).default([]),
      champTitre: z.string().min(1).default("titre"),
      champPuces: z.string().min(1).default("puces"),
      champNotes: z.string().min(1).default("notes"),
      format: z.enum(["pptx", "pdf", "pptx_pdf"]).default("pptx"),
      nom: z.string().min(1).max(120).default("presentation"),
    }),
    lot: async (p, els, ctx) => {
      const d = documents(ctx);
      const sources = p.diapositives.length
        ? p.diapositives
        : els.map((e) => {
            const v = lire(e.json, p.champPuces);
            const puces: unknown[] = Array.isArray(v) ? v : v == null || v === "" ? [] : t(v).split("\n");
            return Diapositive.parse({
              titre: t(lire(e.json, p.champTitre)),
              puces: puces.map((x) =>
                x && typeof x === "object" && "texte" in x
                  ? {
                      texte: t(x.texte),
                      niveau: Math.min(4, Math.max(0, Math.trunc(Number((x as { niveau?: unknown }).niveau)) || 0)),
                    }
                  : t(x),
              ),
              notes: t(lire(e.json, p.champNotes)),
            });
          });
      const diapositives = sources
        .map((x) => ({ ...x, puces: x.puces.filter((y) => (typeof y === "string" ? y : y.texte).trim()) }))
        .filter((x) => x.titre || x.puces.length);
      if (diapositives.length > 500) throw new Error("500 diapositives au plus");
      if (!p.titre && !diapositives.length) throw new Error("titre ou diapositives requis");
      const pptx = d.presentation({ titre: p.titre, sous_titre: p.sousTitre, diapositives });
      const fichierPptx: Fichier = {
        nom: `${nomFichier(p.nom)}.pptx`,
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        base64: pptx.toBase64(),
      };
      const sortie: Record<string, unknown> =
        p.format === "pptx"
          ? { fichier: fichierPptx }
          : p.format === "pdf"
            ? { fichier: fichierPdf(p.nom, d.presentationEnPdf(pptx)) }
            : { fichier: fichierPptx, pdf: fichierPdf(p.nom, d.presentationEnPdf(pptx)) };
      return une([{ json: { ...sortie, diapositives: diapositives.length + (p.titre || p.sousTitre ? 1 : 0) } }]);
    },
  }),
  def({
    type: "fichier.document",
    libelle: "Créer un document Word",
    description:
      "Remplit les champs {{ nom }} d'un gabarit DOCX (fichier ou URL), ou compose un document simple (titre et paragraphes) ; en DOCX, en PDF ou les deux.",
    categorie: "donnees",
    icone: "description",
    parametres: z.object({
      /** Gabarit, par exemple `{{ $json.fichier }}` ; sinon `url` ; sinon document composé. */
      gabarit: z.union([Fichier, z.literal(""), z.null()]).default(null),
      url: z.string().default(""),
      /** Valeurs des champs du gabarit ; un champ absent est cherché dans l'élément (`{{ client.nom }}`). */
      champs: z.array(Paire).max(200).default([]),
      titre: z.string().max(500).default(""),
      paragraphes: z
        .array(
          z.object({
            texte: z.string().max(50_000),
            style: z.enum(["normal", "titre1", "titre2", "titre3"]).default("normal"),
            gras: z.boolean().default(false),
          }),
        )
        .max(1000)
        .default([]),
      format: z.enum(["docx", "pdf", "docx_pdf"]).default("docx"),
      nom: z.string().min(1).max(120).default("document"),
    }),
    element: async (p, el, ctx) => {
      const word = natif(ctx).word;
      let docx: Uint8Array;
      const manquants: string[] = [];
      if (p.gabarit || p.url) {
        const gabarit = (await source({ fichier: p.gabarit, url: p.url }, ctx)).octets;
        const fournis = new Map(p.champs.map((c) => [c.nom.trim(), c.valeur]));
        const valeurs: Record<string, string> = {};
        for (const nom of word.champs(gabarit)) {
          const v = fournis.has(nom) ? fournis.get(nom) : lire(el.json, nom.replace(/^\$json\./, ""));
          if (v === undefined) manquants.push(nom);
          else valeurs[nom] = t(v);
        }
        docx = word.remplir(gabarit, valeurs);
      } else {
        if (!p.titre && !p.paragraphes.length) throw new Error("gabarit, URL, titre ou paragraphes requis");
        docx = word.creer({
          titre: p.titre,
          paragraphes: p.paragraphes.map((x) => ({
            texte: x.texte,
            gras: x.gras,
            ...(x.style === "normal" ? {} : { style: x.style }),
          })),
        });
      }
      const fichierDocx: Fichier = {
        nom: `${nomFichier(p.nom)}.docx`,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        base64: docx.toBase64(),
      };
      const sortie: Record<string, unknown> =
        p.format === "docx"
          ? { fichier: fichierDocx }
          : p.format === "pdf"
            ? { fichier: fichierPdf(p.nom, word.enPdf(docx)) }
            : { fichier: fichierDocx, pdf: fichierPdf(p.nom, word.enPdf(docx)) };
      return une([avec(el, { ...sortie, manquants })]);
    },
  }),
  def({
    type: "media.image",
    libelle: "Transformer une image",
    description: "Redimensionne, recadre, pivote, convertit (JPEG, PNG, WebP) et allège une image.",
    categorie: "donnees",
    icone: "image",
    parametres: z.object({
      fichier: z.union([Fichier, z.literal(""), z.null()]).default(null),
      url: z.string().default(""),
      largeur: z.number().int().min(1).max(8000).optional(),
      hauteur: z.number().int().min(1).max(8000).optional(),
      ajustement: z.enum(["inside", "fill"]).default("inside"),
      recadrer: z
        .object({
          left: z.number().int().min(0),
          top: z.number().int().min(0),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
      niveauxDeGris: z.boolean().default(false),
      luminosite: z.number().min(0).max(3).default(1),
      format: z.enum(["origine", "jpeg", "png", "webp"]).default("webp"),
      qualite: z.number().int().min(1).max(100).default(80),
    }),
    element: async (p, el, ctx) => {
      if (!ctx.services.image) throw new Error("traitement d'image indisponible");
      const { nom, octets } = await source(p, ctx);
      const r = await ctx.services.image(octets, p);
      const extension = r.type.split("/")[1] === "jpeg" ? "jpg" : r.type.split("/")[1];
      const fichier: Fichier = {
        nom: `${nomFichier(nom.replace(/\.[^.]+$/, ""))}.${extension}`,
        type: r.type,
        base64: r.octets.toBase64(),
      };
      return une([
        avec(el, { fichier, largeur: r.largeur, hauteur: r.hauteur, source: r.source, octets: r.octets.length }),
      ]);
    },
  }),
  def({
    type: "media.video",
    libelle: "Vidéo",
    description: "Lit les métadonnées d'une vidéo, en extrait une image ou un GIF animé.",
    categorie: "donnees",
    icone: "movie",
    parametres: z.object({
      fichier: z.union([Fichier, z.literal(""), z.null()]).default(null),
      url: z.string().default(""),
      action: z.enum(["metadonnees", "image", "gif"]).default("metadonnees"),
      secondes: z.number().min(0).default(0),
      duree: z.number().min(0.1).max(5).default(3),
      largeur: z.number().int().min(16).max(640).default(480),
    }),
    element: async (p, el, ctx) => {
      if (!ctx.services.video) throw new Error("traitement vidéo indisponible");
      const { nom, octets } = await source(p, ctx);
      const base = nomFichier(nom.replace(/\.[^.]+$/, ""));
      const video = await ctx.services.video.metadonnees(octets);
      if (p.action === "metadonnees") return une([avec(el, { video })]);
      if (p.action === "image") {
        const o = await ctx.services.video.image(octets, p.secondes, p.largeur);
        return une([
          avec(el, { video, fichier: { nom: `${base}-${p.secondes}s.jpg`, type: "image/jpeg", base64: o.toBase64() } }),
        ]);
      }
      const o = await ctx.services.video.gif(octets, p.secondes, p.duree, p.largeur);
      return une([avec(el, { video, fichier: { nom: `${base}.gif`, type: "image/gif", base64: o.toBase64() } })]);
    },
  }),
  def({
    type: "reseau.navigateur",
    libelle: "Ouvrir dans un navigateur",
    description:
      "Charge une page comme un vrai navigateur (JavaScript compris) : titre, texte visible et capture d'écran.",
    categorie: "reseau",
    icone: "travel_explore",
    parametres: z.object({
      url: z.string().min(1),
      capture: z.boolean().default(true),
      texte: z.boolean().default(true),
      largeur: z.number().int().min(320).max(2560).default(1280),
      hauteur: z.number().int().min(320).max(2560).default(800),
      attendreMs: z.number().int().min(0).max(15_000).default(1000),
    }),
    element: async (p, el, ctx) => {
      if (!ctx.services.navigateur) throw new Error("navigateur indisponible");
      const r = await ctx.services.navigateur(p.url, p);
      const fichier: Fichier | null = r.capture
        ? { nom: `${nomFichier(new URL(p.url).hostname)}.png`, type: "image/png", base64: r.capture.toBase64() }
        : null;
      return une([avec(el, { url: p.url, titre: r.titre, texte: r.texte, ...(fichier ? { fichier } : {}) })]);
    },
  }),
  def({
    type: "reseau.http",
    libelle: "Requête HTTP",
    description: "Appelle n'importe quelle API web (GET, POST…) et récupère sa réponse.",
    categorie: "reseau",
    icone: "language",
    parametres: z.object({
      methode: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      url: z.string().min(1),
      entetes: z.array(Paire).max(30).default([]),
      requete: z.array(Paire).max(30).default([]),
      corps: z.unknown().optional(),
      format: z.enum(["auto", "json", "texte"]).default("auto"),
      echecSiErreur: z.boolean().default(true),
    }),
    element: async (p, el, ctx) => {
      const u = new URL(p.url);
      for (const q of p.requete) u.searchParams.append(q.nom, t(q.valeur));
      const entetes = new Headers(p.entetes.map((h) => [h.nom, t(h.valeur)] as [string, string]));
      let body: string | undefined;
      if (p.corps !== undefined && p.corps !== "" && p.methode !== "GET") {
        body = typeof p.corps === "string" ? p.corps : JSON.stringify(p.corps);
        if (!entetes.has("content-type"))
          entetes.set("content-type", typeof p.corps === "string" ? "text/plain" : "application/json");
      }
      const r = await ctx.services.fetch(u.toString(), {
        method: p.methode,
        headers: entetes,
        body,
        signal: ctx.signal,
      });
      const corps = await lireReponse(r, p.format);
      if (!r.ok && p.echecSiErreur) throw new Error(`HTTP ${r.status} : ${t(corps).slice(0, 300)}`);
      return une([{ json: { statut: r.status, entetes: Object.fromEntries(r.headers), corps, entree: el.json } }]);
    },
  }),

  def({
    type: "reseau.extraire",
    libelle: "Extraire d'une page web",
    description: "Lit une page HTML et en extrait des valeurs par sélecteur CSS (texte ou attribut).",
    categorie: "reseau",
    icone: "travel_explore",
    parametres: z.object({
      url: z.string().min(1),
      champs: z
        .array(
          z.object({
            nom: z.string().min(1),
            selecteur: z.string().min(1).max(300),
            attribut: z.string().default(""),
            tous: z.boolean().default(false),
          }),
        )
        .min(1)
        .max(30),
    }),
    element: async (p, el, ctx) => {
      const r = await ctx.services.fetch(p.url, { headers: { accept: "text/html" }, signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (html.length > 5_000_000) throw new Error("page trop volumineuse (5 Mo au plus)");
      return une([{ json: { url: p.url, ...extraireHtml(html, p.champs) } }]);
    },
  }),
  def({
    type: "reseau.flux",
    libelle: "Lire un flux RSS",
    description: "Lit un flux RSS ou Atom et produit un élément par article (titre, lien, date, résumé).",
    categorie: "reseau",
    icone: "rss_feed",
    parametres: z.object({ url: z.string().min(1), max: z.number().int().min(1).max(500).default(50) }),
    element: async (p, _el, ctx) => {
      const r = await ctx.services.fetch(p.url, { signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return une(
        lireFlux(await r.text())
          .slice(0, p.max)
          .map((json) => ({ json })),
      );
    },
  }),

  def({
    type: "communication.mail",
    libelle: "Envoyer un mail",
    description: "Envoie un mail depuis la boîte de l'entreprise.",
    categorie: "communication",
    icone: "mail",
    parametres: z.object({
      a: z.email(),
      sujet: z.string().min(1).max(200),
      texte: z.string().min(1).max(50_000),
      /** Pièce jointe, par exemple `{{ $json.fichier }}` produit par « Créer un tableur ». */
      piece: z.union([Fichier, z.literal(""), z.null()]).default(null),
    }),
    element: async (p, el, ctx) => {
      if (!ctx.services.envoyerMail) throw new Error("aucune boîte mail configurée pour l'entreprise");
      await ctx.services.envoyerMail({ a: p.a, sujet: p.sujet, texte: p.texte, pieces: p.piece ? [p.piece] : [] });
      return une([avec(el, { mail: { a: p.a, sujet: p.sujet, envoye: true } })]);
    },
  }),
  def({
    type: "communication.slack",
    libelle: "Message Slack",
    description: "Publie un message dans un canal par son webhook entrant.",
    categorie: "communication",
    icone: "forum",
    parametres: z.object({ webhook: z.url(), texte: z.string().min(1).max(40_000) }),
    element: async (p, el, ctx) => {
      await poster(ctx, p.webhook, { text: p.texte });
      return une([avec(el, { slack: { envoye: true } })]);
    },
  }),
  def({
    type: "communication.discord",
    libelle: "Message Discord",
    description: "Publie un message dans un salon par son webhook.",
    categorie: "communication",
    icone: "chat",
    parametres: z.object({ webhook: z.url(), texte: z.string().min(1).max(2000) }),
    element: async (p, el, ctx) => {
      await poster(ctx, p.webhook, { content: p.texte });
      return une([avec(el, { discord: { envoye: true } })]);
    },
  }),
  def({
    type: "communication.telegram",
    libelle: "Message Telegram",
    description: "Envoie un message par un bot Telegram.",
    categorie: "communication",
    icone: "send",
    parametres: z.object({ jeton: z.string().min(10), chat: z.string().min(1), texte: z.string().min(1).max(4096) }),
    element: async (p, el, ctx) => {
      const r = await poster(ctx, `https://api.telegram.org/bot${p.jeton}/sendMessage`, {
        chat_id: p.chat,
        text: p.texte,
      });
      return une([avec(el, { telegram: r })]);
    },
  }),

  // Services libres auto-hébergeables : API HTTP documentées, jetons par `{{ $secret.nom }}`.
  def({
    type: "communication.ntfy",
    libelle: "Notification ntfy",
    description: "Pousse une notification sur un sujet ntfy (ntfy.sh ou votre serveur), reçue sur téléphone et bureau.",
    categorie: "communication",
    icone: "notifications_active",
    parametres: z.object({
      serveur: z.url().default("https://ntfy.sh"),
      sujet: z.string().regex(/^[\w-]{1,64}$/, "lettres, chiffres, - et _"),
      texte: z.string().min(1).max(4096),
      titre: z.string().max(250).default(""),
      priorite: z.number().int().min(1).max(5).default(3),
      etiquettes: z.string().max(250).default(""),
      lien: z.string().default(""),
      jeton: z.string().default(""),
    }),
    element: async (p, el, ctx) => {
      const r = await appeler(ctx, "POST", `${base(p.serveur)}/${p.sujet}`, p.texte, {
        "content-type": "text/plain; charset=utf-8",
        priority: String(p.priorite),
        ...(p.titre ? { title: p.titre } : {}),
        ...(p.etiquettes ? { tags: p.etiquettes } : {}),
        ...(p.lien ? { click: p.lien } : {}),
        ...(p.jeton ? porteur(p.jeton) : {}),
      });
      return une([avec(el, { ntfy: r })]);
    },
  }),
  def({
    type: "communication.gotify",
    libelle: "Notification Gotify",
    description: "Envoie un message à votre serveur Gotify avec le jeton d'une application.",
    categorie: "communication",
    icone: "campaign",
    parametres: z.object({
      serveur: z.url(),
      jeton: z.string().min(1),
      texte: z.string().min(1).max(20_000),
      titre: z.string().max(250).default(""),
      priorite: z.number().int().min(0).max(10).default(5),
    }),
    element: async (p, el, ctx) => {
      const r = await poster(
        ctx,
        `${base(p.serveur)}/message`,
        { message: p.texte, priority: p.priorite, ...(p.titre ? { title: p.titre } : {}) },
        { "x-gotify-key": p.jeton },
      );
      return une([avec(el, { gotify: r })]);
    },
  }),
  def({
    type: "communication.matrix",
    libelle: "Message Matrix",
    description:
      "Publie un message dans un salon Matrix (Element, Synapse, Conduit…) avec le jeton d'accès d'un compte.",
    categorie: "communication",
    icone: "tag",
    parametres: z.object({
      serveur: z.url(),
      jeton: z.string().min(1),
      salon: z.string().regex(/^!.+:.+$/, "identifiant de salon, ex. !abc:matrix.org"),
      texte: z.string().min(1).max(60_000),
    }),
    element: async (p, el, ctx) => {
      const txn = cleUnique(ctx, el);
      const r = await appeler(
        ctx,
        "PUT",
        `${base(p.serveur)}/_matrix/client/v3/rooms/${encodeURIComponent(p.salon)}/send/m.room.message/${encodeURIComponent(txn)}`,
        { msgtype: "m.text", body: p.texte },
        porteur(p.jeton),
      );
      return une([avec(el, { matrix: r })]);
    },
  }),
  def({
    type: "communication.mastodon",
    libelle: "Publication Mastodon",
    description: "Publie un statut sur une instance Mastodon (ou compatible) avec un jeton d'application.",
    categorie: "communication",
    icone: "public",
    parametres: z.object({
      instance: z.url(),
      jeton: z.string().min(1),
      texte: z.string().min(1).max(5000),
      visibilite: z.enum(["public", "unlisted", "private", "direct"]).default("unlisted"),
      avertissement: z.string().max(500).default(""),
    }),
    element: async (p, el, ctx) => {
      const r = (await poster(
        ctx,
        `${base(p.instance)}/api/v1/statuses`,
        { status: p.texte, visibility: p.visibilite, ...(p.avertissement ? { spoiler_text: p.avertissement } : {}) },
        {
          ...porteur(p.jeton),
          "idempotency-key": cleUnique(ctx, el),
        },
      )) as { id?: string; url?: string } | null;
      return une([avec(el, { mastodon: { id: r?.id ?? null, url: r?.url ?? null } })]);
    },
  }),
  def({
    type: "reseau.home_assistant",
    libelle: "Home Assistant",
    description: "Appelle un service de votre maison (allumer, ouvrir, notifier…) ou lit l'état d'une entité.",
    categorie: "reseau",
    icone: "home_iot_device",
    parametres: z.object({
      url: z.url(),
      jeton: z.string().min(1),
      operation: z.enum(["service", "etat"]).default("service"),
      service: z
        .string()
        .regex(/^[a-z_]+\.[a-z0-9_]+$/, "domaine.service, ex. light.turn_on")
        .default("homeassistant.toggle"),
      entite: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/, "domaine.objet, ex. light.salon"),
      donnees: z.record(z.string(), z.unknown()).default({}),
    }),
    element: async (p, el, ctx) => {
      if (p.operation === "etat") {
        const r = await appeler(ctx, "GET", `${base(p.url)}/api/states/${p.entite}`, undefined, porteur(p.jeton));
        return une([avec(el, { home_assistant: r })]);
      }
      const [domaine, service] = p.service.split(".");
      const r = await poster(
        ctx,
        `${base(p.url)}/api/services/${domaine}/${service}`,
        { entity_id: p.entite, ...p.donnees },
        porteur(p.jeton),
      );
      return une([avec(el, { home_assistant: r })]);
    },
  }),
  def({
    type: "reseau.nextcloud",
    libelle: "Déposer dans Nextcloud",
    description: "Dépose un fichier dans votre Nextcloud par WebDAV, avec un mot de passe d'application.",
    categorie: "reseau",
    icone: "cloud_upload",
    parametres: z.object({
      ...SourceFichier.shape,
      serveur: z.url(),
      utilisateur: z.string().min(1),
      motDePasse: z.string().min(1),
      dossier: z.string().default("/auto"),
      nom: z.string().default(""),
    }),
    element: async (p, el, ctx) => {
      const f = await source(p, ctx);
      const nom = (p.nom || f.nom).replaceAll("/", "_");
      const dossier = p.dossier.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      const chemin = `${dossier ? `${dossier}/` : ""}${encodeURIComponent(nom)}`;
      const auth = { authorization: `Basic ${Buffer.from(`${p.utilisateur}:${p.motDePasse}`).toString("base64")}` };
      const r = await ctx.services.fetch(
        `${base(p.serveur)}/remote.php/dav/files/${encodeURIComponent(p.utilisateur)}/${chemin}`,
        { method: "PUT", headers: auth, body: f.octets, signal: ctx.signal },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status} : ${(await r.text()).slice(0, 300)}`);
      return une([avec(el, { nextcloud: { chemin: `/${decodeURIComponent(chemin)}`, octets: f.octets.length } })]);
    },
  }),

  def({
    type: "ia.texte",
    libelle: "Modèle de langage",
    description: "Génère ou analyse un texte avec un modèle compatible OpenAI : Ollama, Mistral, OpenAI…",
    categorie: "ia",
    icone: "auto_awesome",
    parametres: z.object({
      url: z.string().default(IA_URL),
      modele: z.string().min(1),
      systeme: z.string().max(20_000).default(""),
      prompt: z.string().min(1).max(100_000),
      cle: z.string().default(""),
      temperature: z.number().min(0).max(2).default(0.2),
      json: z.boolean().default(false),
    }),
    element: async (p, el, ctx) => {
      const messages = [
        ...(p.systeme ? [{ role: "system", content: p.systeme }] : []),
        { role: "user", content: p.prompt },
      ];
      const r = (await poster(
        ctx,
        `${p.url.replace(/\/+$/, "")}/chat/completions`,
        {
          model: p.modele,
          messages,
          temperature: p.temperature,
          ...(p.json ? { response_format: { type: "json_object" } } : {}),
        },
        p.cle ? { authorization: `Bearer ${p.cle}` } : {},
      )) as { choices?: { message?: { content?: string } }[]; usage?: unknown };
      const contenu = r.choices?.[0]?.message?.content ?? "";
      let reponse: unknown = contenu;
      if (p.json) {
        try {
          reponse = JSON.parse(contenu);
        } catch {
          throw new Error("le modèle n'a pas renvoyé de JSON valide");
        }
      }
      return une([avec(el, { reponse, usage: r.usage ?? null })]);
    },
  }),

  def({
    type: "ia.ocr",
    libelle: "Lire une image (OCR)",
    description:
      "Lit le texte d'une image (scan, photo de ticket, capture) avec un modèle de vision : aphrody-llama-server, Ollama, OpenAI…",
    categorie: "ia",
    icone: "document_scanner",
    parametres: z.object({
      fichier: z.union([Fichier, z.literal(""), z.null()]).default(null),
      url: z.string().default(""),
      api: z.string().default(IA_URL),
      modele: z.string().min(1).default("qwen2.5vl"),
      cle: z.string().default(""),
      consigne: z
        .string()
        .max(20_000)
        .default("Transcris fidèlement tout le texte de l'image, ligne par ligne, sans commentaire."),
      json: z.boolean().default(false),
      largeurMax: z.number().int().min(256).max(4096).default(1600),
    }),
    element: async (p, el, ctx) => {
      const { nom, octets } = await source(p, ctx);
      // Image réduite et réencodée par Bun.Image : requête plus légère, formats exotiques normalisés.
      let image: { octets: Uint8Array; type: string } = { octets, type: "image/png" };
      if (ctx.services.image) {
        const r = await ctx.services.image(octets, {
          largeur: p.largeurMax,
          ajustement: "inside",
          niveauxDeGris: false,
          luminosite: 1,
          format: "jpeg",
          qualite: 85,
        });
        image = { octets: r.octets, type: r.type };
      }
      const r = (await poster(
        ctx,
        `${p.api.replace(/\/+$/, "")}/chat/completions`,
        {
          model: p.modele,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: p.consigne },
                { type: "image_url", image_url: { url: `data:${image.type};base64,${image.octets.toBase64()}` } },
              ],
            },
          ],
          ...(p.json ? { response_format: { type: "json_object" } } : {}),
        },
        p.cle ? { authorization: `Bearer ${p.cle}` } : {},
      )) as { choices?: { message?: { content?: string } }[]; usage?: unknown };
      const contenu = r.choices?.[0]?.message?.content ?? "";
      let texte: unknown = contenu;
      if (p.json) {
        try {
          texte = JSON.parse(contenu);
        } catch {
          throw new Error("le modèle n'a pas renvoyé de JSON valide");
        }
      }
      return une([avec(el, { source: nom, texte, usage: r.usage ?? null })]);
    },
  }),
  def({
    type: "ia.indexer",
    libelle: "Indexer dans la base de connaissances",
    description:
      "Découpe un texte ou un document (PDF, Word, Markdown, texte) en morceaux, calcule leurs embeddings et les range dans une base de connaissances de l'entreprise ; une source déjà indexée est remplacée.",
    categorie: "ia",
    icone: "library_add",
    parametres: SourceFichier.extend({
      base: z.string().regex(BASE_CONNAISSANCE, "base : minuscules, chiffres, - ou _").default("documents"),
      /** Nom de la source (remplacée si elle existe) ; vide : nom du fichier. */
      source: z.string().max(300).default(""),
      /** Texte à indexer ; vide : le fichier ou l'URL. */
      texte: z.string().max(5_000_000).default(""),
      ...ParametresEmbeddings,
      taille: z.number().int().min(200).max(8000).default(1400),
    }),
    element: async (p, el, ctx) => {
      let texte = p.texte;
      let nom = p.source.trim();
      if (!texte) {
        const f = await source(p, ctx);
        texte = texteDocument(f.nom, f.octets, ctx);
        nom ||= f.nom;
      }
      nom ||= "texte";
      if (!texte.trim())
        throw new Error("aucun texte à indexer (un scan sans couche texte passe d'abord par « Lire une image (OCR) »)");
      const r = await connaissance(ctx).indexer(
        { base: p.base, source: nom, texte, taille: p.taille, embeddings: embeddingsDe(p) },
        ctx.signal,
      );
      return une([avec(el, { base: p.base, source: nom, morceaux: r.morceaux, remplaces: r.remplaces })]);
    },
  }),
  def({
    type: "ia.rechercher",
    libelle: "Rechercher dans la base de connaissances",
    description:
      "Trouve les morceaux de documents les plus proches d'une question (similarité des embeddings) et prépare un « contexte » à donner au modèle de langage.",
    categorie: "ia",
    icone: "manage_search",
    parametres: z.object({
      base: z.string().regex(BASE_CONNAISSANCE, "base : minuscules, chiffres, - ou _").default("documents"),
      question: z.string().min(1).max(10_000),
      k: z.number().int().min(1).max(20).default(4),
      /** Similarité cosinus minimale (0 à 1) d'un morceau retenu. */
      scoreMin: z.number().min(0).max(1).default(0),
      /** Diversité (λ de MMR) : 1 = pertinence seule, plus bas = moins de redites ; vide : sans. */
      diversite: z.number().min(0).max(1).optional(),
      ...ParametresEmbeddings,
    }),
    element: async (p, el, ctx) => {
      const resultats = await connaissance(ctx).rechercher(
        {
          base: p.base,
          question: p.question,
          k: p.k,
          scoreMin: p.scoreMin,
          diversite: p.diversite,
          embeddings: embeddingsDe(p),
        },
        ctx.signal,
      );
      const contexte = resultats.map((r) => `[${r.source}, partie ${r.position + 1}]\n${r.texte}`).join("\n\n---\n\n");
      return une([avec(el, { resultats, contexte, trouves: resultats.length })]);
    },
  }),
  def({
    type: "auto.workflow",
    libelle: "Exécuter un workflow",
    description:
      "Lance un autre workflow de l'entreprise avec ces éléments et continue avec ce qu'il produit (3 niveaux au plus).",
    categorie: "auto",
    icone: "account_tree",
    parametres: z.object({
      workflow: z.string().regex(/^[0-9a-f-]{36}$/i, "identifiant d'un workflow (UUID)"),
      mode: z.enum(["ensemble", "par_element"]).default("ensemble"),
    }),
    lot: async (p, els, ctx) => {
      const lancer = ctx.services.sousWorkflow;
      if (!lancer) throw new Error("sous-workflows indisponibles ici");
      if (p.mode === "ensemble") return une(await lancer(p.workflow, els, ctx.signal));
      const sortie: Element[] = [];
      for (const el of els) sortie.push(...(await lancer(p.workflow, [el], ctx.signal)));
      return une(sortie);
    },
  }),
  def({
    type: "auto.requete",
    libelle: "Action auto",
    description: "Lit ou modifie les données de l'entreprise : clients, documents, produits, absences…",
    categorie: "auto",
    icone: "deployed_code",
    parametres: z.object({
      methode: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
      chemin: z.string().regex(/^\/v1\/[\w\-/.?=&%]*$/, "chemin de l'API d'auto, par exemple /v1/clients"),
      corps: z.unknown().optional(),
      eclater: z.boolean().default(false),
    }),
    element: async (p, el, ctx) => {
      if (!ctx.services.appelerAuto) throw new Error("API d'auto indisponible");
      if (/^\/v1\/(auth|jetons|membres|automatisations|crochets)/.test(p.chemin))
        throw new Error("chemin réservé : comptes, jetons et automatisations ne sont pas accessibles");
      const r = await ctx.services.appelerAuto(p.methode, p.chemin, p.methode === "GET" ? undefined : p.corps);
      if (r.statut >= 400) throw new Error(`auto ${r.statut} : ${t(r.corps).slice(0, 300)}`);
      if (p.eclater && Array.isArray(r.corps))
        return une(r.corps.map((v) => ({ json: v && typeof v === "object" ? { ...v } : { valeur: v } })));
      return une([
        {
          json:
            r.corps && typeof r.corps === "object" && !Array.isArray(r.corps) ? { ...r.corps } : { resultat: r.corps },
        },
      ]);
    },
  }),
];

export const CATALOGUE = new Map(TYPES.map((x) => [x.type, x]));

/** Libellés des sorties d'un nœud selon ses paramètres validés. */
export function sortiesDe(type: TypeNoeud, p: unknown): string[] {
  const s = type.sorties;
  if (!s) return ["principale"];
  if (Array.isArray(s)) return s;
  const r = type.parametres.safeParse(p);
  return r.success ? s(r.data) : ["principale"];
}

/** Catalogue publiable (éditeur, MCP, OpenAPI) : paramètres en JSON Schema. */
export function catalogueJson() {
  return TYPES.map((x) => ({
    type: x.type,
    libelle: x.libelle,
    description: x.description,
    categorie: x.categorie,
    icone: x.icone,
    sorties: Array.isArray(x.sorties) ? x.sorties : x.sorties ? "dynamiques" : ["principale"],
    parametres: z.toJSONSchema(x.parametres, { io: "input", unrepresentable: "any" }),
  }));
}

// Pont bun:ffi vers crates/auto-ffi : rendu PDF, Factur-X, XML CII, extraction, contrôle PDF/A, tableurs,
// fichiers PDF (fusion, pages, texte) et Word (gabarit, création, export PDF), base de connaissances (découpage,
// plus proches voisins).
// Bibliothèque : AUTO_FFI_LIB, sinon dist/native/<plateforme>/ (bun run build:native).
import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";

const PLATEFORMES: Record<string, string> = {
  "linux-x64": "linux-x64/libauto_ffi.so",
  "win32-x64": "windows-x64/auto_ffi.dll",
};

function chemin(): string {
  if (Bun.env.AUTO_FFI_LIB) return Bun.env.AUTO_FFI_LIB;
  const rel = PLATEFORMES[`${process.platform}-${process.arch}`];
  if (!rel) throw new Error(`auto-ffi : plateforme non prise en charge (${process.platform}-${process.arch})`);
  // Paquet publié : binaires embarqués dans native/ ; dépôt : dist/native/ (bun run build:native).
  const embarque = Bun.fileURLToPath(new URL(`../native/${rel}`, import.meta.url));
  return existsSync(embarque) ? embarque : Bun.fileURLToPath(new URL(`../../../dist/native/${rel}`, import.meta.url));
}

let lib: ReturnType<typeof ouvrir> | undefined;

function ouvrir() {
  return dlopen(chemin(), {
    auto_call: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.ptr,
    },
    auto_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
  });
}

export class ErreurNative extends Error {}

const encodeur = new TextEncoder();
const VIDE = new Uint8Array(1);

function appeler(op: string, entree: Uint8Array): Uint8Array<ArrayBuffer> {
  lib ??= ouvrir();
  const o = encodeur.encode(op);
  const len = new BigUint64Array(1);
  const p = lib.symbols.auto_call(o, o.length, entree.length ? entree : VIDE, entree.length, len) as Pointer;
  const n = Number(len[0]);
  try {
    const sortie = new Uint8Array(toArrayBuffer(p, 0, n)).slice();
    if (sortie[0] !== 0) throw new ErreurNative(new TextDecoder().decode(sortie.subarray(1)));
    return sortie.subarray(1);
  } finally {
    lib.symbols.auto_free(p, n);
  }
}

const json = (doc: unknown) => encodeur.encode(JSON.stringify(doc));

/** Document (JSON de @auto/domain + numero) → PDF A4. */
export const rendrePdf = (doc: unknown) => appeler("rendre", json(doc));

/** Facture émise → Factur-X EN 16931 (PDF/A-3b avec factur-x.xml), contrôlé avant retour. */
export function facturx(doc: unknown, date = new Date()): Uint8Array<ArrayBuffer> {
  const corps = json(doc);
  const entree = new Uint8Array(8 + corps.length);
  new DataView(entree.buffer).setBigInt64(0, BigInt(Math.floor(date.getTime() / 1000)), true);
  entree.set(corps, 8);
  return appeler("facturx", entree);
}

/** XML CII EN 16931 d'une facture émise. */
export const xmlCii = (doc: unknown) => new TextDecoder().decode(appeler("xml", json(doc)));

/** XML Factur-X embarqué d'un PDF reçu, ou null. */
export function extraireXml(pdf: Uint8Array): string | null {
  const x = new TextDecoder().decode(appeler("extraire", pdf));
  return x || null;
}

/** Non-conformités PDF/A-3b (vide = conforme). */
export const verifierPdfA = (pdf: Uint8Array): string[] =>
  JSON.parse(new TextDecoder().decode(appeler("verifier_pdfa", pdf)));

/** Montant TTC (BT-112, GrandTotalAmount) d'un XML CII, en centimes. */
export function totalTtcCents(xml: string): number | null {
  const m = /<ram:GrandTotalAmount>(-?\d+)\.(\d{2})<\/ram:GrandTotalAmount>/.exec(xml);
  if (!m) return null;
  const c = Number(m[1]) * 100 + Number(m[2]);
  return m[1]!.startsWith("-") ? -(Math.abs(Number(m[1])) * 100 + Number(m[2])) : c;
}

export type CelluleLue = string | number | boolean | null;
export interface Lecture {
  format: "xlsx" | "xls" | "xlsb" | "ods" | "csv";
  feuilles: { nom: string; lignes: CelluleLue[][] }[];
  avertissements: string[];
}

/** Classeur xlsx, xls, xlsb, ods ou csv → lignes de valeurs (dates Excel en numéros de série). */
export const lireTableur = (octets: Uint8Array): Lecture =>
  JSON.parse(new TextDecoder().decode(appeler("tableur_lire", octets)));

export type TypeColonne = "texte" | "nombre" | "euros" | "date" | "pourcent";
export interface Classeur {
  feuilles: {
    nom: string;
    colonnes: { titre: string; type?: TypeColonne; largeur?: number }[];
    /** euros en centimes, pourcent en points de base, date « AAAA-MM-JJ ». */
    lignes: CelluleLue[][];
  }[];
}

/** Classeur typé → xlsx (en-tête en gras figée). */
export const ecrireXlsx = (c: Classeur) => appeler("xlsx_ecrire", json(c));
export interface EditionCellule {
  feuille: string;
  ligne: number;
  colonne: number;
  valeur?: CelluleLue;
  formule?: string;
}
/** Coordonnées à partir de 1 ; formules recalculées par Gridcraft, styles conservés. */
export const modifierXlsx = (xlsx: Uint8Array, editions: EditionCellule[]) =>
  appeler("xlsx_modifier", trames([json(editions), xlsx]));
export const remplacerDocx = (docx: Uint8Array, remplacements: { chercher: string; remplacer: string }[]) =>
  appeler("docx_remplacer", trames([json(remplacements), docx]));

/** Numéro de série Excel (système 1900) → « AAAA-MM-JJ ». */
export function dateExcel(serie: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serie) * 86_400_000).toISOString().slice(0, 10);
}

// Fichiers PDF et Word (crate auto-fichiers) ------------------------------------------------------

/** Concatène des trames `u32` LE de longueur + octets (entrée des opérations à plusieurs parties). */
function trames(parties: Uint8Array[]): Uint8Array {
  const sortie = new Uint8Array(parties.reduce((n, p) => n + 4 + p.length, 0));
  const vue = new DataView(sortie.buffer);
  let i = 0;
  for (const p of parties) {
    vue.setUint32(i, p.length, true);
    sortie.set(p, i + 4);
    i += 4 + p.length;
  }
  return sortie;
}

/** PDF fusionnés dans l'ordre, un signet par fichier (son nom). */
export const fusionnerPdf = (pdfs: { nom: string; octets: Uint8Array }[]) =>
  appeler("pdf_fusionner", trames(pdfs.flatMap((p) => [encodeur.encode(p.nom), p.octets])));

/** Nouveau PDF fait des pages données (numérotées à partir de 1, dans l'ordre donné). */
export const extrairePagesPdf = (pdf: Uint8Array, pages: number[]) =>
  appeler("pdf_pages", trames([json(pages.map((p) => p - 1)), pdf]));

/** Nombre de pages d'un PDF. */
export const nombrePagesPdf = (pdf: Uint8Array) => Number(new TextDecoder().decode(appeler("pdf_nombre_pages", pdf)));

/** Texte de chaque page dans l'ordre de lecture (500 pages au plus ; vide pour une page scannée). */
export const textePdf = (pdf: Uint8Array): string[] =>
  (JSON.parse(new TextDecoder().decode(appeler("pdf_texte", pdf))) as { pages: string[] }).pages;

export interface DocumentSimple {
  titre?: string;
  paragraphes: { texte: string; style?: "titre" | "titre1" | "titre2" | "titre3"; gras?: boolean }[];
}

/** Document Word A4 : titre puis paragraphes (une ligne de texte = un paragraphe). */
export const creerDocx = (d: DocumentSimple) => appeler("docx_creer", json(d));

/** Noms des champs `{{ nom }}` d'un gabarit Word, sans doublon. */
export const champsDocx = (docx: Uint8Array): string[] =>
  JSON.parse(new TextDecoder().decode(appeler("docx_champs", docx)));

/** Gabarit Word dont les champs `{{ nom }}` connus sont remplacés (les autres restent). */
export const remplirDocx = (docx: Uint8Array, valeurs: Record<string, string>) =>
  appeler("docx_remplir", trames([json(valeurs), docx]));

/** Texte du corps d'un document Word, un paragraphe par ligne. */
export const texteDocx = (docx: Uint8Array) => new TextDecoder().decode(appeler("docx_texte", docx));

/** Document Word → PDF (mise en page wordcraft, polices embarquées). */
export const docxEnPdf = (docx: Uint8Array) => appeler("docx_pdf", docx);

// Caviardage, signature et présentations (crate auto-fichiers) ------------------------------------

/** Lit des trames `u32` LE de longueur + octets (sortie des opérations à plusieurs parties). */
function lireTrames(o: Uint8Array): Uint8Array[] {
  const vue = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const parties: Uint8Array[] = [];
  for (let i = 0; i < o.length;) {
    const n = vue.getUint32(i, true);
    parties.push(o.subarray(i + 4, i + 4 + n));
    i += 4 + n;
  }
  return parties;
}

export type MotifCaviardage = "iban" | "email" | "telephone" | "carte" | "date";

export interface OptionsCaviardage {
  textes?: string[];
  motifs?: MotifCaviardage[];
  casse?: boolean;
  mots_entiers?: boolean;
  texte_superpose?: string;
}

export interface RapportCaviardage {
  occurrences: number;
  pages: number[];
  par_recherche: { recherche: string; occurrences: number }[];
  glyphes: number;
  images: number;
  traces: number;
  annotations: number;
  champs: number;
}

/** Caviardage définitif (contenu supprimé, pavé noir, vérification) ; sans occurrence, PDF inchangé. */
export function caviarderPdf(pdf: Uint8Array, o: OptionsCaviardage) {
  const [rapport, sortie] = lireTrames(appeler("pdf_caviarder", trames([json(o), pdf])));
  return { pdf: sortie!.slice(), rapport: JSON.parse(new TextDecoder().decode(rapport)) as RapportCaviardage };
}

export interface OptionsSignature {
  mot_de_passe: string;
  /** Date PDF `D:AAAAMMJJHHmmSSZ` ; par défaut maintenant. */
  date?: string;
  raison?: string;
  lieu?: string;
  contact?: string;
  champ?: string;
  /** Page du nouveau champ, à partir de 0. */
  page?: number;
  /** Rectangle visible `[x0, y0, x1, y1]` en points, origine en bas à gauche ; sinon invisible. */
  rectangle?: [number, number, number, number];
  certifier?: 1 | 2 | 3;
}

/** Date PDF UTC (`D:20261023120000Z`). */
export const datePdf = (d = new Date()) => `D:${d.toISOString().replace(/\D/g, "").slice(0, 14)}Z`;

/** Signature PAdES B-B (ETSI.CAdES.detached) avec une identité PKCS #12, en mise à jour incrémentale. */
export const signerPdf = (pdf: Uint8Array, p12: Uint8Array, o: OptionsSignature) =>
  appeler("pdf_signer", trames([json({ ...o, date: o.date ?? datePdf() }), p12, pdf]));

export interface SignatureVerifiee {
  champ: string;
  signee: boolean;
  statut: "valide" | "inconnue" | "invalide" | "non_signee";
  signataire: string | null;
  date: string | null;
  raison: string | null;
  lieu: string | null;
  format: string | null;
  algorithme: string | null;
  certification: number | null;
  horodatage: boolean;
  modifications: "aucune" | "permises" | "interdites";
  changements: string[];
  empreinte: string | null;
  details: string[];
}

/** Signatures d'un PDF vérifiées ; `confiance` : certificats de confiance PEM (sinon identités inconnues). */
export const verifierSignaturesPdf = (pdf: Uint8Array, confiance = ""): SignatureVerifiee[] =>
  JSON.parse(new TextDecoder().decode(appeler("pdf_signatures", trames([encodeur.encode(confiance), pdf]))));

export interface NouvellePresentation {
  titre?: string;
  sous_titre?: string;
  diapositives: { titre?: string; puces?: (string | { texte: string; niveau?: number })[]; notes?: string }[];
}

/** Présentation PPTX 16:9 : diapositive de titre puis diapositives titre et puces. */
export const creerPptx = (p: NouvellePresentation) => appeler("pptx_creer", json(p));

/** PPTX → PDF, une diapositive par page (rendu DeckCraft, texte sélectionnable). */
export const pptxEnPdf = (pptx: Uint8Array) => appeler("pptx_pdf", pptx);

// Base de connaissances (crate auto-connaissance, aphrody-rag-core) --------------------------------

export interface Morceau {
  /** Position dans le document, à partir de 0. */
  position: number;
  texte: string;
  /** Fil des titres (`Guide > Garantie`) d'une source Markdown. */
  titre: string | null;
  ligne_debut: number;
  ligne_fin: number;
}

/** Morceaux d'un texte : sections par titres pour une source `.md`, sinon phrases regroupées (chevauchement 15 %). */
export const decouperTexte = (source: string, texte: string, taille?: number): Morceau[] =>
  JSON.parse(new TextDecoder().decode(appeler("rag_decouper", json({ source, texte, taille }))));

const octetsF32 = (v: Float32Array | number[]) => {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

/**
 * Les `k` lignes de `matrice` (vecteurs de `dimension` nombres mis bout à bout) les plus proches de `question`
 * par similarité cosinus, score décroissant ; `diversite` (λ de MMR, 0 à 1) écarte les quasi-doublons.
 */
export const plusProches = (
  question: Float32Array | number[],
  matrice: Float32Array,
  dimension: number,
  k: number,
  diversite?: number,
): { indice: number; score: number }[] =>
  JSON.parse(
    new TextDecoder().decode(
      appeler("rag_topk", trames([json({ dimension, k, diversite }), octetsF32(question), octetsF32(matrice)])),
    ),
  );

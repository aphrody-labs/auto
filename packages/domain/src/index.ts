export type Tva = 0 | 21 | 55 | 100 | 200; // taux en dixièmes de % : 0, 2,1, 5,5, 10, 20

export interface Ligne {
  designation: string;
  quantite: number;
  prixUnitaireHtCents: number;
  /** Remise sur la ligne en points de base : 1000 = 10 %. */
  remiseBp?: number;
  tva: Tva;
  unite?: string;
}

export interface Partie {
  nom: string;
  siret: string;
  adresse: string;
  adresseLivraison?: string;
  tvaIntracom?: string;
  email?: string;
}

/** devis ; facture (380) ; acompte (386) ; avoir (381). */
export type Type = "devis" | "facture" | "acompte" | "avoir";

export type Statut = "brouillon" | "emis" | "envoye" | "accepte" | "refuse" | "depose" | "rejete" | "paye" | "annule";

export interface Document {
  type: Type;
  date: string; // ISO, date d'émission
  emetteur: Partie;
  client: Partie;
  lignes: Ligne[];
  datePrestation?: string;
  echeance?: string;
  conditionsPaiement?: string;
  /** Taux des pénalités de retard, ex. « 3 fois le taux d'intérêt légal ». */
  penalitesRetard?: string;
  /** Conditions d'escompte, ou « aucun escompte ». */
  escompte?: string;
  /** Franchise en base de TVA (art. 293 B du CGI). */
  franchiseTva?: boolean;
  /** Avoir : numéro de la facture rectifiée. Facture : numéro du devis d'origine. */
  origine?: string;
  validiteJours?: number; // devis
  notes?: string;
  /** Mise en forme du tenant, ajoutée au rendu (jamais stockée dans le document). */
  gabarit?: Gabarit;
}

export const MENTION_FRANCHISE = "TVA non applicable, art. 293 B du CGI";
export const INDEMNITE_RECOUVREMENT_CENTS = 4000;
export const PENALITES_DEFAUT = "3 fois le taux d'intérêt légal";

/** Mise en forme d'un tenant : couleur d'accent, logo JPEG RVB en base64, ligne de pied de page. */
export interface Gabarit {
  couleur?: string;
  logo?: { jpeg: string; largeur: number; hauteur: number };
  piedDePage?: string;
}

export interface Totaux {
  htCents: number;
  tvaParTaux: Record<number, number>;
  tvaCents: number;
  ttcCents: number;
}

/** HT brut d'une ligne (avant remise). */
export const brutLigne = (l: Ligne) => Math.round(l.quantite * l.prixUnitaireHtCents);

/** HT net d'une ligne : même ordre d'opérations que auto-modele (Rust) pour des totaux identiques. */
export const htLigne = (l: Ligne) =>
  Math.round((l.quantite * l.prixUnitaireHtCents * (10000 - (l.remiseBp ?? 0))) / 10000);

export function totaux(lignes: Ligne[]): Totaux {
  const baseParTaux = new Map<number, number>();
  for (const l of lignes) {
    const ht = htLigne(l);
    baseParTaux.set(l.tva, (baseParTaux.get(l.tva) ?? 0) + ht);
  }
  let htCents = 0;
  let tvaCents = 0;
  const tvaParTaux: Record<number, number> = {};
  for (const [taux, base] of baseParTaux) {
    const tva = Math.round((base * taux) / 1000);
    tvaParTaux[taux] = tva;
    htCents += base;
    tvaCents += tva;
  }
  return { htCents, tvaParTaux, tvaCents, ttcCents: htCents + tvaCents };
}

function luhn(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** SIRET : 14 chiffres, clé de Luhn. */
export function siretValide(siret: string): boolean {
  const s = siret.replace(/\s/g, "");
  return /^\d{14}$/.test(s) && luhn(s);
}

/** SIREN : 9 chiffres, clé de Luhn. */
export function sirenValide(siren: string): boolean {
  const s = siren.replace(/\s/g, "");
  return /^\d{9}$/.test(s) && luhn(s);
}

/** TVA intracommunautaire française : FR + clé (2 chiffres) + SIREN. */
export function tvaIntracomFr(siren: string): string {
  const n = BigInt(siren.replace(/\s/g, ""));
  const cle = (12n + 3n * (n % 97n)) % 97n;
  return `FR${String(cle).padStart(2, "0")}${siren.replace(/\s/g, "")}`;
}

/** Série de numérotation : factures et acomptes partagent la série F. */
export function serie(type: Type): "D" | "F" | "A" {
  return type === "devis" ? "D" : type === "avoir" ? "A" : "F";
}

/** Numérotation continue sans trou, par série et par année : F-2026-0001. */
export function numero(type: Type, annee: number, seq: number): string {
  return `${serie(type)}-${annee}-${String(seq).padStart(4, "0")}`;
}

const estFacture = (t: Type) => t !== "devis";

/** Mentions obligatoires manquantes ou incohérentes (liste vide = ok). */
export function verifier(doc: Document): string[] {
  const e: string[] = [];
  if (!siretValide(doc.emetteur.siret)) e.push("siret émetteur invalide");
  if (!doc.emetteur.adresse) e.push("adresse émetteur manquante");
  if (!doc.client.nom || !doc.client.adresse) e.push("nom ou adresse client manquant");
  if (doc.lignes.length === 0) e.push("aucune ligne");
  for (const [i, l] of doc.lignes.entries()) {
    if (!l.designation) e.push(`ligne ${i + 1} : désignation manquante`);
    if (!(l.quantite > 0)) e.push(`ligne ${i + 1} : quantité invalide`);
    if (l.remiseBp !== undefined && !(Number.isInteger(l.remiseBp) && l.remiseBp >= 0 && l.remiseBp <= 10000))
      e.push(`ligne ${i + 1} : remise invalide`);
  }
  if (doc.franchiseTva) {
    if (doc.lignes.some((l) => l.tva !== 0)) e.push("franchise en base : toutes les lignes doivent être à 0 % de TVA");
  } else if (!doc.emetteur.tvaIntracom) {
    e.push("n° de TVA intracommunautaire émetteur manquant");
  }
  if (estFacture(doc.type)) {
    if (doc.client.siret && !siretValide(doc.client.siret)) e.push("siret client invalide");
    if (!doc.echeance) e.push("date d'échéance manquante");
    if (!doc.datePrestation) e.push("date de livraison ou de prestation manquante");
    if (!doc.penalitesRetard) e.push("taux des pénalités de retard manquant");
    if (!doc.escompte) e.push("conditions d'escompte manquantes");
  }
  if (doc.type === "avoir" && !doc.origine) e.push("avoir : facture d'origine manquante");
  return e;
}

/** Valeurs par défaut des mentions légales d'une facture. */
export function avecMentionsParDefaut(doc: Document): Document {
  if (!estFacture(doc.type)) return doc;
  return {
    ...doc,
    penalitesRetard: doc.penalitesRetard ?? PENALITES_DEFAUT,
    escompte: doc.escompte ?? "Pas d'escompte pour paiement anticipé",
    conditionsPaiement: doc.conditionsPaiement ?? "Paiement à 30 jours",
  };
}

/** Facture issue d'un devis accepté. */
export function devisVersFacture(devis: Document, numeroDevis: string, date: string, echeance: string): Document {
  if (devis.type !== "devis") throw new Error("le document source n'est pas un devis");
  const { validiteJours: _, ...rest } = devis;
  return avecMentionsParDefaut({ ...rest, type: "facture", date, echeance, origine: numeroDevis });
}

/** Avoir total annulant une facture. */
export function avoirTotal(facture: Document, numeroFacture: string, date: string): Document {
  if (facture.type === "devis" || facture.type === "avoir")
    throw new Error("seule une facture peut être annulée par un avoir");
  return { ...facture, type: "avoir", date, origine: numeroFacture };
}

/** Avoir partiel : seules les lignes (ou quantités) rectifiées de la facture. */
export function avoirPartiel(facture: Document, numeroFacture: string, date: string, lignes: Ligne[]): Document {
  if (facture.type === "devis" || facture.type === "avoir")
    throw new Error("seule une facture peut être rectifiée par un avoir");
  if (lignes.length === 0) throw new Error("avoir partiel sans ligne");
  return { ...facture, type: "avoir", date, origine: numeroFacture, lignes };
}

export const eur = (cents: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
export * from "./rh";
export * from "./compta";

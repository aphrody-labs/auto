// Logique pure de l'extension (sans API chrome.*) : testée par bun:test, partagée par le service worker et la popup.

export const INSTANCE_PAR_DEFAUT = "https://auto.aphrody.com";
/** Même plafond que l'API (apps/api/src/modules/ingest.ts). */
export const TAILLE_MAX = 20 * 1024 * 1024;

export interface Reglages {
  instance: string;
  jeton: string;
}

/** URL d'instance normalisée (origine seule) ; https exigé, sauf localhost pour une instance de dev. */
export function normaliserInstance(brute: string): string {
  let u: URL;
  try {
    u = new URL(brute.trim());
  } catch {
    throw new Error("Adresse de l'instance invalide (ex. https://auto.aphrody.com)");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:"))
    throw new Error("L'instance doit être en https (http accepté seulement pour localhost)");
  return u.origin;
}

/** Motif d'autorisation d'hôte pour une origine (ex. https://auto.aphrody.com/*). */
export const motifHote = (origine: string) => `${new URL(origine).origin}/*`;

/** Le jeton API d'auto commence par « auto_ » (packages/tenancy). */
export const jetonValide = (j: string) => /^auto_[A-Za-z0-9_-]{20,}$/.test(j.trim());

export type TypeFichier = "application/pdf" | "application/xml";

/** Type du fichier d'après ses premiers octets (prioritaires sur l'en-tête, souvent faux) ; null si ni PDF ni XML. */
export function typeFichier(octets: Uint8Array): TypeFichier | null {
  const debut = new TextDecoder().decode(octets.subarray(0, 512)).replace(/^﻿/, "").trimStart();
  if (debut.startsWith("%PDF-")) return "application/pdf";
  if (debut.startsWith("<?xml") || /^<([\w-]+:)?CrossIndustryInvoice\b/.test(debut)) return "application/xml";
  return null;
}

/** Nom du fichier : Content-Disposition (filename* RFC 5987 puis filename), sinon dernier segment de l'URL. */
export function nomFichier(url: string, contentDisposition: string | null, type: TypeFichier): string {
  const extension = type === "application/pdf" ? ".pdf" : ".xml";
  const cd = contentDisposition ?? "";
  const etoile = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  const simple = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let nom = "";
  try {
    nom = etoile ? decodeURIComponent(etoile[1]!.trim()) : simple ? simple[1]!.trim() : "";
  } catch {
    nom = "";
  }
  if (!nom) {
    try {
      nom = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
    } catch {
      nom = "";
    }
  }
  // Caractères interdits dans un nom de fichier, et caractères de contrôle (code < 32).
  nom =
    [...nom]
      .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? "_" : c))
      .join("")
      .slice(0, 120) || "facture";
  return nom.toLowerCase().endsWith(extension) ? nom : `${nom}${extension}`;
}

/** URL de dépôt d'une facture reçue sur l'instance. */
export const urlDepot = (instance: string, nom: string) =>
  `${instance}/v1/factures-recues?nom=${encodeURIComponent(nom)}`;

export interface Recue {
  id: string;
  statut: "a_verifier" | "validee" | "rejetee";
  doublon?: boolean;
  fournisseur: string | null;
  numero: string | null;
  ttcCents: number | null;
  anomalies: string[];
}

/** Message de notification après un dépôt, du point de vue de l'utilisateur. */
export function messageDepot(r: Recue, nom: string): { titre: string; message: string } {
  if (r.doublon) return { titre: "Déjà reçue", message: `${nom} avait déjà été envoyée à auto.` };
  const qui = r.fournisseur ? ` de ${r.fournisseur}` : "";
  const ttc =
    r.ttcCents !== null
      ? `, ${(r.ttcCents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })} TTC`
      : "";
  const num = r.numero ? ` n° ${r.numero}` : "";
  return r.statut === "validee"
    ? { titre: "Facture enregistrée", message: `Facture${num}${qui}${ttc} lue et validée.` }
    : {
        titre: "Facture à vérifier",
        message: `Facture${num}${qui}${ttc} reçue : ${r.anomalies.length || "des"} point(s) à contrôler dans auto.`,
      };
}

/** Texte du badge : nombre de factures à vérifier, vide à zéro, « 99+ » au-delà. */
export const texteBadge = (n: number) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

/** Message d'erreur lisible depuis une réponse de l'API ({ erreur, details }). */
export function erreurApi(statut: number, corps: unknown): string {
  const c = (corps ?? {}) as { erreur?: string; details?: string[] };
  if (statut === 401) return "Jeton refusé : vérifiez le jeton API dans les réglages de l'extension.";
  if (statut === 402) return c.erreur ?? "Quota de votre abonnement atteint.";
  if (statut === 403) return "Ce jeton n'a pas le droit d'enregistrer des factures (rôle lecture).";
  const details = c.details?.length ? ` (${c.details.join(", ")})` : "";
  return `${c.erreur ?? `Erreur ${statut}`}${details}`;
}

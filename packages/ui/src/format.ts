// Formatage et calculs d'affichage du front (purs, testés) : montants, dates, TVA, remises, statuts, indicateurs.
import { htLigne, type Statut, type Tva, type Type } from "@auto/domain";
import type { StatutVisuel } from "@auto/ui";

const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dates = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const mois = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" });
const nombres = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

/** Centimes → « 1 234,56 € » (espaces insécables de la locale fr-FR). */
export const eur = (cents: number) => euros.format(cents / 100);

/** AAAA-MM-JJ → « 22/10/2026 » ; vide si absent. */
export const dateFr = (iso?: string | null) => (iso ? dates.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "");

/** AAAA-MM-JJ → « octobre 2026 ». */
export const moisFr = (iso: string) => mois.format(new Date(`${iso.slice(0, 7)}-01T00:00:00Z`));

export const nombre = (n: number) => nombres.format(n);

/** Taux de TVA admis, en dixièmes de pourcent. */
export const TAUX_TVA: Tva[] = [200, 100, 55, 21, 0];

/** 200 → « 20 % », 55 → « 5,5 % ». */
export const tauxTva = (t: number) => `${nombres.format(t / 10)} %`;

/**
 * Saisie d'un montant en euros (« 1 234,56 », « 1234.5 », « 12 € ») → centimes entiers ; `null` si invalide.
 * Deux décimales au plus, pas de montant négatif.
 */
export function versCentimes(saisie: string): number | null {
  const s = saisie.replace(/[\s  €]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [ent, dec = ""] = s.split(".");
  return Number(ent) * 100 + Number(dec.padEnd(2, "0"));
}

/** Centimes → valeur de champ « 1234,56 » (sans symbole, pour l'édition). */
export const depuisCentimes = (cents: number) => {
  const e = Math.trunc(cents / 100);
  const c = Math.abs(cents % 100);
  return c ? `${e},${String(c).padStart(2, "0")}` : String(e);
};

/** Saisie d'une remise en % (« 10 », « 12,5 ») → points de base ; `null` hors de 0 à 100 %. */
export function versPointsDeBase(saisie: string): number | null {
  const s = saisie.replace(/[\s%]/g, "").replace(",", ".");
  if (s === "") return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp <= 10000 ? bp : null;
}

export const pourcentDepuisBp = (bp?: number) => (bp ? nombres.format(bp / 100) : "");

/** Quantité saisie (« 1,5 ») → nombre strictement positif ; `null` sinon. */
export function versQuantite(saisie: string): number | null {
  const s = saisie.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** Date locale du poste au format AAAA-MM-JJ. */
export function aujourdhui(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ajouterJours(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Premier et dernier jour du mois de `iso`. */
export function bornesMois(iso: string): { du: string; au: string } {
  const [a, m] = iso.split("-").map(Number) as [number, number];
  const dernier = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return { du: `${a}-${p(m)}-01`, au: `${a}-${p(m)}-${p(dernier)}` };
}

export const LIBELLE_TYPE: Record<Type, string> = {
  devis: "Devis",
  facture: "Facture",
  acompte: "Acompte",
  avoir: "Avoir",
};

/** Statuts pour lesquels une facture reste à encaisser. */
const NON_SOLDES: Statut[] = ["emis", "envoye", "accepte", "depose"];

export interface DocResume {
  type: Type;
  statut: Statut;
  numero: string | null;
  ttcCents: number;
  htCents: number;
  tvaCents: number;
  data: { date: string; echeance?: string; origine?: string; client: { nom: string } };
}

export const estFactureVente = (t: Type) => t === "facture" || t === "acompte";

/** Statut affiché : « en retard » est dérivé (facture échue et non soldée), jamais stocké. */
export function statutVisuel(d: Pick<DocResume, "type" | "statut" | "data">, jour = aujourdhui()): StatutVisuel {
  if (estFactureVente(d.type) && NON_SOLDES.includes(d.statut) && d.data.echeance && d.data.echeance < jour)
    return "en_retard";
  return d.statut;
}

/** Libellés accordés : un devis est « émis », une facture « émise ». */
const MASCULIN: Partial<Record<StatutVisuel, string>> = {
  emis: "Émis",
  envoye: "Envoyé",
  accepte: "Accepté",
  refuse: "Refusé",
  depose: "Déposé",
  rejete: "Rejeté",
  paye: "Payé",
  annule: "Annulé",
};

const FEMININ: Record<StatutVisuel, string> = {
  brouillon: "Brouillon",
  emis: "Émise",
  envoye: "Envoyée",
  accepte: "Acceptée",
  refuse: "Refusée",
  depose: "Déposée",
  rejete: "Rejetée",
  paye: "Payée",
  annule: "Annulée",
  en_retard: "En retard",
};

export const libelleStatut = (s: StatutVisuel, t: Type) =>
  t === "devis" || t === "acompte" || t === "avoir" ? (MASCULIN[s] ?? FEMININ[s]) : FEMININ[s];

export interface Indicateurs {
  /** Chiffre d'affaires HT du mois : factures et acomptes émis, moins les avoirs émis. */
  caMoisHtCents: number;
  /** TVA collectée du mois, avoirs déduits. */
  tvaMoisCents: number;
  /** Factures émises non soldées : TTC moins avoirs (et paiements si fournis). */
  impayesCents: number;
  impayes: number;
  enRetardCents: number;
  enRetard: number;
  devisEnAttente: number;
}

/**
 * Indicateurs du tableau de bord à partir de la liste des documents. `restes` (id → reste dû) affine
 * les impayés avec les paiements partiels quand ils sont connus.
 */
export function indicateurs(
  docs: (DocResume & { id: string })[],
  jour = aujourdhui(),
  restes: Record<string, number> = {},
): Indicateurs {
  const { du, au } = bornesMois(jour);
  const dansMois = (d: DocResume) => d.data.date >= du && d.data.date <= au;
  const emis = docs.filter((d) => d.statut !== "brouillon");
  const avoirsPar = new Map<string, number>();
  let caMoisHtCents = 0;
  let tvaMoisCents = 0;
  for (const d of emis) {
    if (d.type === "avoir" && d.data.origine)
      avoirsPar.set(d.data.origine, (avoirsPar.get(d.data.origine) ?? 0) + d.ttcCents);
    if (!dansMois(d) || d.type === "devis") continue;
    const signe = d.type === "avoir" ? -1 : 1;
    caMoisHtCents += signe * d.htCents;
    tvaMoisCents += signe * d.tvaCents;
  }
  const r: Indicateurs = {
    caMoisHtCents,
    tvaMoisCents,
    impayesCents: 0,
    impayes: 0,
    enRetardCents: 0,
    enRetard: 0,
    devisEnAttente: emis.filter((d) => d.type === "devis" && (d.statut === "emis" || d.statut === "envoye")).length,
  };
  for (const d of emis) {
    if (!estFactureVente(d.type) || !NON_SOLDES.includes(d.statut)) continue;
    const reste = restes[d.id] ?? d.ttcCents - (avoirsPar.get(d.numero ?? "") ?? 0);
    if (reste <= 0) continue;
    r.impayes++;
    r.impayesCents += reste;
    if (statutVisuel(d, jour) === "en_retard") {
      r.enRetard++;
      r.enRetardCents += reste;
    }
  }
  return r;
}

export const emailValide = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());

/** Chiffres seuls d'un SIREN ou SIRET saisi avec espaces. */
export const chiffres = (s: string) => s.replace(/\D/g, "");

/** SIRET (ou SIREN) groupé pour l'affichage : « 732 829 320 00074 ». */
export function grouperSiret(s: string): string {
  const c = chiffres(s);
  return [c.slice(0, 3), c.slice(3, 6), c.slice(6, 9), c.slice(9, 14)].filter(Boolean).join(" ");
}

/** Lignes d'un document converties en lignes du domaine ; `null` pour une ligne invalide. */
export interface SaisieLigne {
  designation: string;
  quantite: string;
  unite: string;
  prix: string;
  remise: string;
  tva: Tva;
}

export function versLigne(s: SaisieLigne) {
  const quantite = versQuantite(s.quantite);
  const prixUnitaireHtCents = versCentimes(s.prix);
  const remiseBp = versPointsDeBase(s.remise);
  if (quantite === null || prixUnitaireHtCents === null || remiseBp === null) return null;
  return {
    designation: s.designation.trim(),
    quantite,
    prixUnitaireHtCents,
    tva: s.tva,
    ...(remiseBp ? { remiseBp } : {}),
    ...(s.unite.trim() ? { unite: s.unite.trim() } : {}),
  };
}

/** HT net d'une ligne en saisie (0 tant qu'elle est incomplète), par la règle de @auto/domain. */
export function htLigneSaisie(s: SaisieLigne): number {
  const l = versLigne(s);
  return l ? htLigne(l) : 0;
}

/** Erreurs d'une ligne en saisie, par champ (affichées sous le champ concerné). */
export function erreursLigne(s: SaisieLigne): Partial<Record<keyof SaisieLigne, string>> {
  const e: Partial<Record<keyof SaisieLigne, string>> = {};
  if (!s.designation.trim()) e.designation = "Désignation obligatoire.";
  if (versQuantite(s.quantite) === null) e.quantite = "Quantité positive, 3 décimales au plus.";
  if (versCentimes(s.prix) === null) e.prix = "Montant en euros, par exemple 120,50.";
  if (versPointsDeBase(s.remise) === null) e.remise = "Remise entre 0 et 100 %.";
  return e;
}

export const LIBELLE_ABSENCE: Record<string, string> = {
  conges_payes: "Congés payés",
  rtt: "RTT",
  maladie: "Maladie",
  sans_solde: "Sans solde",
  evenement_familial: "Événement familial",
  autre: "Autre",
};

export const LIBELLE_STATUT_ABSENCE: Record<string, string> = {
  demandee: "Demandée",
  validee: "Validée",
  refusee: "Refusée",
  annulee: "Annulée",
};

export const LIBELLE_CONTRAT: Record<string, string> = {
  cdi: "CDI",
  cdd: "CDD",
  apprentissage: "Apprentissage",
  professionnalisation: "Professionnalisation",
  stage: "Stage",
  interim: "Intérim",
};

export const LIBELLE_MODE: Record<string, string> = {
  virement: "Virement",
  carte: "Carte",
  cheque: "Chèque",
  especes: "Espèces",
  prelevement: "Prélèvement",
  autre: "Autre",
};

/** Octets (unités décimales, comme les quotas) : « 1,5 Go », « 20 Go », « 350 Mo ». */
export function octets(n: number): string {
  const u = [
    [1e9, "Go"],
    [1e6, "Mo"],
    [1e3, "ko"],
  ] as const;
  for (const [v, s] of u) if (n >= v) return `${nombre(Math.round((n / v) * 10) / 10)} ${s}`;
  return `${nombre(n)} o`;
}

/** Nombre accordé (règle française : 0 et 1 au singulier) : « 1 créé », « 3 créés ». */
export const pluriel = (n: number, singulier: string, pl = `${singulier}s`) =>
  `${nombre(n)} ${Math.abs(n) < 2 ? singulier : pl}`;

/** Jours (ouvrables) : « 1 jour », « 2,5 jours ». */
export const jours = (n: number) => pluriel(n, "jour");

/** Octets → base64 (corps des imports). */
export function enBase64(octets: Uint8Array): string {
  const u = octets as Uint8Array & { toBase64?: () => string };
  if (typeof u.toBase64 === "function") return u.toBase64();
  let s = "";
  for (let i = 0; i < octets.length; i += 0x8000) s += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(s);
}

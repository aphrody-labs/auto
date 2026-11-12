// Gestion des employés : contrats, jours fériés, jours ouvrables et congés payés (Code du travail, L3141-3 et suivants).

export type Contrat = "cdi" | "cdd" | "apprentissage" | "professionnalisation" | "stage" | "interim";
export const CONTRATS: Contrat[] = ["cdi", "cdd", "apprentissage", "professionnalisation", "stage", "interim"];

export type TypeAbsence = "conges_payes" | "rtt" | "maladie" | "sans_solde" | "evenement_familial" | "autre";
export const TYPES_ABSENCE: TypeAbsence[] = [
  "conges_payes",
  "rtt",
  "maladie",
  "sans_solde",
  "evenement_familial",
  "autre",
];

export type StatutAbsence = "demandee" | "validee" | "refusee" | "annulee";

export interface Employe {
  nom: string;
  prenom: string;
  email?: string;
  poste: string;
  contrat: Contrat;
  /** AAAA-MM-JJ */
  dateEntree: string;
  dateSortie?: string;
  /** Temps de travail en pourcentage d'un temps plein (100 = temps plein). */
  tempsTravail: number;
  salaireBrutMensuelCents: number;
}

/** Acquisition légale : 2,5 jours ouvrables par mois de travail effectif, 30 au plus par période. */
export const CP_PAR_MOIS = 2.5;
export const CP_MAX_PERIODE = 30;

const jour = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusJours = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Dimanche de Pâques (algorithme de Meeus/Jones/Butcher, calendrier grégorien). */
export function paques(annee: number): string {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const j = ((h + l - 7 * m + 114) % 31) + 1;
  return `${annee}-${String(mois).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
}

/** Les 11 jours fériés légaux de métropole (L3133-1), hors jours propres à l'Alsace-Moselle et aux DOM. */
export function joursFeries(annee: number): string[] {
  const p = jour(paques(annee));
  return [
    `${annee}-01-01`,
    iso(plusJours(p, 1)),
    `${annee}-05-01`,
    `${annee}-05-08`,
    iso(plusJours(p, 39)),
    iso(plusJours(p, 50)),
    `${annee}-07-14`,
    `${annee}-08-15`,
    `${annee}-11-01`,
    `${annee}-11-11`,
    `${annee}-12-25`,
  ].sort();
}

/** Jours ouvrables (lundi à samedi, hors jours fériés) entre deux dates incluses. */
export function joursOuvrables(debut: string, fin: string): number {
  if (fin < debut) return 0;
  const feries = new Set<string>();
  for (let a = Number(debut.slice(0, 4)); a <= Number(fin.slice(0, 4)); a++)
    for (const f of joursFeries(a)) feries.add(f);
  let n = 0;
  for (let d = jour(debut); iso(d) <= fin; d = plusJours(d, 1)) if (d.getUTCDay() !== 0 && !feries.has(iso(d))) n++;
  return n;
}

/** Début de la période de référence (1er juin) qui contient la date. */
export function debutPeriode(date: string): string {
  const a = Number(date.slice(0, 4));
  return date.slice(5) >= "06-01" ? `${a}-06-01` : `${a - 1}-06-01`;
}

/**
 * Congés payés acquis (jours ouvrables, arrondis au jour supérieur comme l'impose L3141-7) sur la période
 * de référence qui contient `au`, d'après les mois entiers de présence. Les absences assimilées ou non
 * à du travail effectif ne sont pas déduites ici.
 */
export function congesAcquis(e: Pick<Employe, "dateEntree" | "dateSortie">, au: string): number {
  const debut = [debutPeriode(au), e.dateEntree].sort().at(-1)!;
  const fin = [au, e.dateSortie ?? au].sort()[0]!;
  if (fin < debut) return 0;
  let mois = 0;
  for (let d = jour(debut); ; mois++) {
    const suivant = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    if (iso(plusJours(suivant, -1)) > fin) break;
    d = suivant;
  }
  return Math.min(CP_MAX_PERIODE, Math.ceil(mois * CP_PAR_MOIS));
}

/** Erreurs de saisie d'un employé ; tableau vide si valide. */
export function verifierEmploye(e: Partial<Employe>): string[] {
  const err: string[] = [];
  if (!e.nom?.trim()) err.push("nom obligatoire");
  if (!e.prenom?.trim()) err.push("prénom obligatoire");
  if (!e.poste?.trim()) err.push("poste obligatoire");
  if (!CONTRATS.includes(e.contrat as Contrat)) err.push(`contrat attendu : ${CONTRATS.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.dateEntree ?? "")) err.push("date d'entrée AAAA-MM-JJ obligatoire");
  if (e.dateSortie && e.dateSortie < (e.dateEntree ?? "")) err.push("date de sortie antérieure à l'entrée");
  if (e.contrat === "cdd" && !e.dateSortie) err.push("CDD : date de fin obligatoire");
  if (!Number.isInteger(e.tempsTravail) || e.tempsTravail! <= 0 || e.tempsTravail! > 100)
    err.push("temps de travail entre 1 et 100 %");
  if (!Number.isInteger(e.salaireBrutMensuelCents) || e.salaireBrutMensuelCents! < 0)
    err.push("salaire brut mensuel en centimes entier");
  if (e.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email)) err.push("email invalide");
  return err;
}

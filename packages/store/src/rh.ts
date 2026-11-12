// Employés, absences et solde de congés payés.
import {
  congesAcquis,
  debutPeriode,
  joursOuvrables,
  TYPES_ABSENCE,
  verifierEmploye,
  type Employe,
  type StatutAbsence,
  type TypeAbsence,
} from "@auto/domain";
import type { Tx } from "./db";
import { ErreurMetier, journaliser } from "./index";

export interface FicheEmploye extends Employe {
  id: string;
}

interface EmployeRow {
  id: string;
  nom: string;
  prenom: string;
  email: string | null;
  poste: string;
  contrat: Employe["contrat"];
  date_entree: Date;
  date_sortie: Date | null;
  temps_travail: number;
  salaire_brut_mensuel_cents: string;
}

const date = (d: Date) => d.toISOString().slice(0, 10);

const employe = (r: EmployeRow): FicheEmploye => ({
  id: r.id,
  nom: r.nom,
  prenom: r.prenom,
  email: r.email ?? undefined,
  poste: r.poste,
  contrat: r.contrat,
  dateEntree: date(r.date_entree),
  dateSortie: r.date_sortie ? date(r.date_sortie) : undefined,
  tempsTravail: r.temps_travail,
  salaireBrutMensuelCents: Number(r.salaire_brut_mensuel_cents),
});

function controler(e: Partial<Employe>) {
  const err = verifierEmploye(e);
  if (err.length) throw new ErreurMetier("employé invalide", err);
}

export async function creerEmploye(tx: Tx, actor: string | null, e: Employe): Promise<FicheEmploye> {
  controler(e);
  const [r] = await tx<EmployeRow[]>`
    INSERT INTO employe (nom, prenom, email, poste, contrat, date_entree, date_sortie, temps_travail, salaire_brut_mensuel_cents)
    VALUES (${e.nom.trim()}, ${e.prenom.trim()}, ${e.email ?? null}, ${e.poste.trim()}, ${e.contrat}, ${e.dateEntree},
      ${e.dateSortie ?? null}, ${e.tempsTravail}, ${e.salaireBrutMensuelCents})
    RETURNING *`;
  await journaliser(tx, actor, "employe.creer", r!.id);
  return employe(r!);
}

export async function modifierEmploye(tx: Tx, actor: string | null, id: string, e: Employe): Promise<FicheEmploye> {
  controler(e);
  const [r] = await tx<EmployeRow[]>`
    UPDATE employe SET nom = ${e.nom.trim()}, prenom = ${e.prenom.trim()}, email = ${e.email ?? null},
      poste = ${e.poste.trim()}, contrat = ${e.contrat}, date_entree = ${e.dateEntree}, date_sortie = ${e.dateSortie ?? null},
      temps_travail = ${e.tempsTravail}, salaire_brut_mensuel_cents = ${e.salaireBrutMensuelCents}
    WHERE id = ${id} RETURNING *`;
  if (!r) throw new ErreurMetier("employé introuvable", [], 404);
  await journaliser(tx, actor, "employe.modifier", id);
  return employe(r);
}

export async function lireEmploye(tx: Tx, id: string): Promise<FicheEmploye | null> {
  const [r] = await tx<EmployeRow[]>`SELECT * FROM employe WHERE id = ${id}`;
  return r ? employe(r) : null;
}

/** Employés présents à la date (par défaut aujourd'hui), ou tous avec `tous`. */
export async function listerEmployes(tx: Tx, tous = false): Promise<FicheEmploye[]> {
  const rows = tous
    ? await tx<EmployeRow[]>`SELECT * FROM employe ORDER BY nom, prenom LIMIT 1000`
    : await tx<EmployeRow[]>`SELECT * FROM employe WHERE date_sortie IS NULL OR date_sortie >= current_date
        ORDER BY nom, prenom LIMIT 1000`;
  return rows.map(employe);
}

// Absences --------------------------------------------------------------------------------------

export interface Absence {
  id: string;
  employeId: string;
  type: TypeAbsence;
  debut: string;
  fin: string;
  joursOuvrables: number;
  statut: StatutAbsence;
  motif: string | null;
}

interface AbsenceRow {
  id: string;
  employe_id: string;
  type: TypeAbsence;
  debut: Date;
  fin: Date;
  jours_ouvrables: number;
  statut: StatutAbsence;
  motif: string | null;
}

const absence = (r: AbsenceRow): Absence => ({
  id: r.id,
  employeId: r.employe_id,
  type: r.type,
  debut: date(r.debut),
  fin: date(r.fin),
  joursOuvrables: r.jours_ouvrables,
  statut: r.statut,
  motif: r.motif,
});

export interface SoldeConges {
  periode: string;
  acquis: number;
  pris: number;
  demandes: number;
  disponible: number;
}

/** Solde de congés payés sur la période de référence qui contient `au`. */
export async function soldeConges(tx: Tx, employeId: string, au = new Date().toISOString().slice(0, 10)) {
  const e = await lireEmploye(tx, employeId);
  if (!e) throw new ErreurMetier("employé introuvable", [], 404);
  const periode = debutPeriode(au);
  const [r] = await tx<{ pris: string; demandes: string }[]>`
    SELECT coalesce(sum(jours_ouvrables) FILTER (WHERE statut = 'validee'), 0) AS pris,
           coalesce(sum(jours_ouvrables) FILTER (WHERE statut = 'demandee'), 0) AS demandes
    FROM absence WHERE employe_id = ${employeId} AND type = 'conges_payes'
      AND debut >= ${periode}::date AND debut < ${periode}::date + interval '1 year'`;
  const acquis = congesAcquis(e, au);
  const pris = Number(r!.pris);
  const demandes = Number(r!.demandes);
  return { periode, acquis, pris, demandes, disponible: acquis - pris - demandes } satisfies SoldeConges;
}

export async function demanderAbsence(
  tx: Tx,
  actor: string | null,
  employeId: string,
  a: { type: TypeAbsence; debut: string; fin: string; motif?: string },
): Promise<Absence> {
  if (!TYPES_ABSENCE.includes(a.type)) throw new ErreurMetier(`type d'absence attendu : ${TYPES_ABSENCE.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.debut) || !/^\d{4}-\d{2}-\d{2}$/.test(a.fin) || a.fin < a.debut)
    throw new ErreurMetier("période invalide : debut ≤ fin, au format AAAA-MM-JJ");
  const e = await lireEmploye(tx, employeId);
  if (!e) throw new ErreurMetier("employé introuvable", [], 404);
  if (a.debut < e.dateEntree || (e.dateSortie && a.fin > e.dateSortie))
    throw new ErreurMetier("absence hors du contrat de l'employé");
  const [chevauche] = await tx`SELECT 1 FROM absence WHERE employe_id = ${employeId}
    AND statut IN ('demandee', 'validee') AND debut <= ${a.fin} AND fin >= ${a.debut} LIMIT 1`;
  if (chevauche) throw new ErreurMetier("une absence couvre déjà une partie de cette période", [], 409);
  const jours = joursOuvrables(a.debut, a.fin);
  if (a.type === "conges_payes") {
    const s = await soldeConges(tx, employeId, a.debut);
    if (jours > s.disponible)
      throw new ErreurMetier("solde de congés insuffisant", [`demandé : ${jours}, disponible : ${s.disponible}`]);
  }
  const [r] = await tx<AbsenceRow[]>`
    INSERT INTO absence (employe_id, type, debut, fin, jours_ouvrables, motif)
    VALUES (${employeId}, ${a.type}, ${a.debut}, ${a.fin}, ${jours}, ${a.motif ?? null}) RETURNING *`;
  await journaliser(tx, actor, "absence.demander", r!.id, { employeId, type: a.type, jours });
  return absence(r!);
}

const TRANSITIONS: Record<StatutAbsence, StatutAbsence[]> = {
  demandee: ["validee", "refusee", "annulee"],
  validee: ["annulee"],
  refusee: [],
  annulee: [],
};

export async function deciderAbsence(
  tx: Tx,
  actor: string | null,
  id: string,
  statut: Exclude<StatutAbsence, "demandee">,
): Promise<Absence> {
  const [cur] = await tx<AbsenceRow[]>`SELECT * FROM absence WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw new ErreurMetier("absence introuvable", [], 404);
  if (!TRANSITIONS[cur.statut].includes(statut))
    throw new ErreurMetier(`transition ${cur.statut} → ${statut} interdite`, [], 409);
  const [r] = await tx<AbsenceRow[]>`UPDATE absence SET statut = ${statut}, decide_par = ${actor}, decide_at = now()
    WHERE id = ${id} RETURNING *`;
  await journaliser(tx, actor, `absence.${statut}`, id);
  return absence(r!);
}

export async function listerAbsences(
  tx: Tx,
  filtre: { employeId?: string; statut?: StatutAbsence } = {},
): Promise<Absence[]> {
  const rows = await tx<AbsenceRow[]>`SELECT * FROM absence
    WHERE (${filtre.employeId ?? null}::uuid IS NULL OR employe_id = ${filtre.employeId ?? null}::uuid)
      AND (${filtre.statut ?? null}::text IS NULL OR statut = ${filtre.statut ?? null}::text)
    ORDER BY debut DESC LIMIT 1000`;
  return rows.map(absence);
}

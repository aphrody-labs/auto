// Automatisations, exécutions et secrets (migration 017). La validation des définitions appartient au moteur
// (`@auto/automate`) et aux services ; ici, persistance sous RLS et aiguillage des déclenchements.
import type { Sql, Tx } from "./db";
import { avecWorker, enfiler } from "./outbox";
import { ErreurMetier, journaliser } from "./index";

/** Job d'exécution d'un workflow par le worker. */
export const JOB_AUTOMATISATION = "automatisation.executer";

/** Exécutions conservées par workflow (les plus anciennes sont purgées). */
export const EXECUTIONS_CONSERVEES = 200;

export type TypeDeclencheur = "manuel" | "evenement" | "planifie" | "webhook";
export type StatutExecution = "en_cours" | "succes" | "erreur";

export interface Automatisation {
  id: string;
  nom: string;
  description: string;
  actif: boolean;
  declencheur: TypeDeclencheur;
  definition: unknown;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeAutomatisation extends Omit<Automatisation, "definition"> {
  derniereExecution: { id: string; statut: StatutExecution; debut: string } | null;
}

export interface Execution {
  id: string;
  automatisationId: string;
  origine: string;
  statut: StatutExecution;
  erreur: string | null;
  debut: string;
  fin: string | null;
  etapes?: unknown[];
}

/** Champs écrits : le déclencheur est extrait de la définition par l'appelant. */
export interface Ecriture {
  nom: string;
  description: string;
  actif: boolean;
  definition: unknown;
  declencheur: TypeDeclencheur;
  evenements: string[];
  cron: string | null;
  fuseau: string | null;
}

interface Row {
  id: string;
  nom: string;
  description: string;
  actif: boolean;
  declencheur: TypeDeclencheur;
  definition: unknown;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  derniere_id?: string | null;
  derniere_statut?: StatutExecution | null;
  derniere_debut?: Date | null;
}

const automatisation = (r: Row): Automatisation => ({
  id: r.id,
  nom: r.nom,
  description: r.description,
  actif: r.actif,
  declencheur: r.declencheur,
  definition: r.definition,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

interface ExecutionRow {
  id: string;
  automatisation_id: string;
  origine: string;
  statut: StatutExecution;
  erreur: string | null;
  debut: Date;
  fin: Date | null;
  etapes?: unknown[];
}

const execution = (r: ExecutionRow): Execution => ({
  id: r.id,
  automatisationId: r.automatisation_id,
  origine: r.origine,
  statut: r.statut,
  erreur: r.erreur,
  debut: r.debut.toISOString(),
  fin: r.fin?.toISOString() ?? null,
  ...(r.etapes ? { etapes: r.etapes } : {}),
});

export const MAX_AUTOMATISATIONS = 50;

export async function creerAutomatisation(tx: Tx, actor: string | null, e: Ecriture): Promise<Automatisation> {
  const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM automatisation`;
  if (n!.n >= MAX_AUTOMATISATIONS)
    throw new ErreurMetier(`${MAX_AUTOMATISATIONS} automatisations au plus par entreprise`);
  const [r] = await tx<Row[]>`
    INSERT INTO automatisation (nom, description, actif, definition, declencheur, evenements, cron, fuseau, created_by)
    VALUES (${e.nom}, ${e.description}, ${e.actif}, ${e.definition}, ${e.declencheur}, ${e.evenements}, ${e.cron},
      ${e.fuseau}, ${actor})
    RETURNING *`;
  await journaliser(tx, actor, "automatisation.creer", r!.id, { nom: e.nom });
  return automatisation(r!);
}

export async function modifierAutomatisation(
  tx: Tx,
  actor: string | null,
  id: string,
  e: Ecriture,
): Promise<Automatisation> {
  await conserverVersion(tx, actor, id, e);
  const [r] = await tx<Row[]>`
    UPDATE automatisation SET nom = ${e.nom}, description = ${e.description}, actif = ${e.actif},
      definition = ${e.definition}, declencheur = ${e.declencheur}, evenements = ${e.evenements}, cron = ${e.cron},
      fuseau = ${e.fuseau}, updated_at = now()
    WHERE id = ${id} RETURNING *`;
  if (!r) throw new ErreurMetier("automatisation introuvable", [], 404);
  await journaliser(tx, actor, "automatisation.modifier", id, { nom: e.nom, actif: e.actif });
  return automatisation(r);
}

export const VERSIONS_MAX = 50;

export interface VersionAutomatisation {
  numero: number;
  nom: string;
  description: string;
  definition: unknown;
  auteur: string | null;
  createdAt: string;
}

/**
 * Avant une modification du contenu (nom, description ou définition ; pas une simple activation), l'état actuel
 * devient une version numérotée. Les plus anciennes au-delà de VERSIONS_MAX sont effacées.
 */
async function conserverVersion(tx: Tx, actor: string | null, id: string, e: Ecriture) {
  // Égalité jsonb : l'ordre des clés n'entre pas en compte.
  const [avant] = await tx<{ nom: string; description: string; definition: unknown; inchange: boolean }[]>`
    SELECT nom, description, definition,
      nom = ${e.nom} AND description = ${e.description} AND definition = ${e.definition}::jsonb AS inchange
    FROM automatisation WHERE id = ${id} FOR UPDATE`;
  if (!avant || avant.inchange) return;
  await tx`
    INSERT INTO automatisation_version (automatisation_id, numero, nom, description, definition, auteur)
    SELECT ${id}, coalesce(max(numero), 0) + 1, ${avant.nom}, ${avant.description}, ${avant.definition}, ${actor}
    FROM automatisation_version WHERE automatisation_id = ${id}`;
  await tx`
    DELETE FROM automatisation_version WHERE automatisation_id = ${id} AND numero <= (
      SELECT max(numero) - ${VERSIONS_MAX} FROM automatisation_version WHERE automatisation_id = ${id})`;
}

const version = (r: {
  numero: number;
  nom: string;
  description: string;
  definition: unknown;
  auteur: string | null;
  created_at: Date;
}): VersionAutomatisation => ({
  numero: r.numero,
  nom: r.nom,
  description: r.description,
  definition: r.definition,
  auteur: r.auteur,
  createdAt: r.created_at.toISOString(),
});

/** Versions précédentes, de la plus récente à la plus ancienne. */
export async function listerVersions(tx: Tx, id: string): Promise<VersionAutomatisation[]> {
  const rows = await tx<Parameters<typeof version>[0][]>`
    SELECT numero, nom, description, definition, auteur, created_at FROM automatisation_version
    WHERE automatisation_id = ${id} ORDER BY numero DESC`;
  return rows.map(version);
}

export async function lireVersion(tx: Tx, id: string, numero: number): Promise<VersionAutomatisation | null> {
  const [r] = await tx<Parameters<typeof version>[0][]>`
    SELECT numero, nom, description, definition, auteur, created_at FROM automatisation_version
    WHERE automatisation_id = ${id} AND numero = ${numero}`;
  return r ? version(r) : null;
}

export async function lireAutomatisation(tx: Tx, id: string): Promise<Automatisation | null> {
  const [r] = await tx<Row[]>`SELECT * FROM automatisation WHERE id = ${id}`;
  return r ? automatisation(r) : null;
}

export async function listerAutomatisations(tx: Tx): Promise<ResumeAutomatisation[]> {
  const rows = await tx<Row[]>`
    SELECT a.*, e.id AS derniere_id, e.statut AS derniere_statut, e.debut AS derniere_debut
    FROM automatisation a
    LEFT JOIN LATERAL (SELECT id, statut, debut FROM execution WHERE automatisation_id = a.id
      ORDER BY debut DESC LIMIT 1) e ON true
    ORDER BY a.updated_at DESC`;
  return rows.map((r) => {
    const { definition: _, ...reste } = automatisation(r);
    return {
      ...reste,
      derniereExecution: r.derniere_id
        ? { id: r.derniere_id, statut: r.derniere_statut!, debut: r.derniere_debut!.toISOString() }
        : null,
    };
  });
}

export async function supprimerAutomatisation(tx: Tx, actor: string | null, id: string): Promise<void> {
  const r = await tx`DELETE FROM automatisation WHERE id = ${id} RETURNING id`;
  if (!r.length) throw new ErreurMetier("automatisation introuvable", [], 404);
  await journaliser(tx, actor, "automatisation.supprimer", id);
}

export async function debuterExecution(tx: Tx, automatisationId: string, origine: string): Promise<string> {
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO execution (automatisation_id, origine) VALUES (${automatisationId}, ${origine}) RETURNING id`;
  return r!.id;
}

export async function terminerExecution(
  tx: Tx,
  id: string,
  r: { statut: StatutExecution; etapes: unknown[]; erreur: string | null },
): Promise<Execution> {
  const [e] = await tx<ExecutionRow[]>`
    UPDATE execution SET statut = ${r.statut}, etapes = ${r.etapes}, erreur = ${r.erreur}, fin = now()
    WHERE id = ${id} RETURNING *`;
  await tx`
    DELETE FROM execution WHERE automatisation_id = ${e!.automatisation_id} AND id IN (
      SELECT id FROM execution WHERE automatisation_id = ${e!.automatisation_id}
      ORDER BY debut DESC OFFSET ${EXECUTIONS_CONSERVEES})`;
  return execution(e!);
}

export async function listerExecutions(tx: Tx, automatisationId: string, limite = 50): Promise<Execution[]> {
  const rows = await tx<ExecutionRow[]>`
    SELECT id, automatisation_id, origine, statut, erreur, debut, fin FROM execution
    WHERE automatisation_id = ${automatisationId} ORDER BY debut DESC LIMIT ${Math.min(limite, 200)}`;
  return rows.map(execution);
}

export async function lireExecution(tx: Tx, id: string): Promise<Execution | null> {
  const [r] = await tx<ExecutionRow[]>`SELECT * FROM execution WHERE id = ${id}`;
  return r ? execution(r) : null;
}

// ── Secrets ────────────────────────────────────────────────────────────────

export interface Secret {
  id: string;
  nom: string;
  createdAt: string;
}

export async function enregistrerSecret(
  tx: Tx,
  actor: string | null,
  nom: string,
  chiffre: Uint8Array,
): Promise<Secret> {
  if (!/^[a-z0-9_-]{1,60}$/.test(nom)) throw new ErreurMetier("nom du secret : minuscules, chiffres, - et _");
  const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM secret_automatisation`;
  if (n!.n >= 100) throw new ErreurMetier("100 secrets au plus par entreprise");
  const [r] = await tx<{ id: string; nom: string; created_at: Date }[]>`
    INSERT INTO secret_automatisation (nom, valeur_chiffree) VALUES (${nom}, ${chiffre})
    ON CONFLICT (tenant_id, nom) DO UPDATE SET valeur_chiffree = EXCLUDED.valeur_chiffree
    RETURNING id, nom, created_at`;
  await journaliser(tx, actor, "secret.enregistrer", r!.id, { nom });
  return { id: r!.id, nom: r!.nom, createdAt: r!.created_at.toISOString() };
}

export async function listerSecrets(tx: Tx): Promise<Secret[]> {
  const rows = await tx<{ id: string; nom: string; created_at: Date }[]>`
    SELECT id, nom, created_at FROM secret_automatisation ORDER BY nom`;
  return rows.map((r) => ({ id: r.id, nom: r.nom, createdAt: r.created_at.toISOString() }));
}

export async function supprimerSecret(tx: Tx, actor: string | null, id: string): Promise<void> {
  const r = await tx`DELETE FROM secret_automatisation WHERE id = ${id} RETURNING id`;
  if (!r.length) throw new ErreurMetier("secret introuvable", [], 404);
  await journaliser(tx, actor, "secret.supprimer", id);
}

/** Valeurs chiffrées des secrets cités, pour le déchiffrement au moment de l'exécution. */
export async function secretsChiffres(tx: Tx, noms: string[]): Promise<{ nom: string; valeur: Uint8Array }[]> {
  if (!noms.length) return [];
  const rows = await tx<{ nom: string; valeur_chiffree: Uint8Array }[]>`
    SELECT nom, valeur_chiffree FROM secret_automatisation WHERE nom = ANY (${noms})`;
  return rows.map((r) => ({ nom: r.nom, valeur: new Uint8Array(r.valeur_chiffree) }));
}

// ── Déclenchements ─────────────────────────────────────────────────────────

export interface ChargeExecution {
  automatisationId: string;
  origine: string;
  entree: { json: Record<string, unknown> }[];
}

/** Dans la transaction de l'événement : un job par workflow actif abonné à ce type. */
export async function enfilerAutomatisations(
  tx: Tx,
  evenementId: string,
  type: string,
  corps: string,
): Promise<number> {
  const abonnes = await tx<{ id: string }[]>`
    SELECT id FROM automatisation WHERE actif AND declencheur = 'evenement' AND ${type} = ANY (evenements)`;
  for (const a of abonnes) {
    const charge: ChargeExecution = {
      automatisationId: a.id,
      origine: `evenement:${evenementId}`,
      entree: [{ json: JSON.parse(corps) }],
    };
    await enfiler(tx, JOB_AUTOMATISATION, charge, { cle: `automatisation:${a.id}:${evenementId}`, maxEssais: 3 });
  }
  return abonnes.length;
}

/** Workflows planifiés actifs de tous les tenants (worker). */
export function automatisationsPlanifiees(
  sql: Sql,
): Promise<{ id: string; tenantId: string; cron: string; fuseau: string }[]> {
  return avecWorker(sql, async (tx) =>
    (
      await tx<{ id: string; tenant_id: string; cron: string; fuseau: string | null }[]>`
        SELECT id, tenant_id, cron, fuseau FROM automatisation
        WHERE actif AND declencheur = 'planifie' AND cron IS NOT NULL`
    ).map((r) => ({ id: r.id, tenantId: r.tenant_id, cron: r.cron, fuseau: r.fuseau ?? "Europe/Paris" })),
  );
}

// ── Mémoire du workflow ────────────────────────────────────────────────────

export async function lireMemoire(tx: Tx, id: string, cle: string): Promise<unknown> {
  const [r] = await tx<{ v: unknown }[]>`SELECT memoire -> ${cle} AS v FROM automatisation WHERE id = ${id}`;
  return r?.v ?? undefined;
}

export async function ecrireMemoire(tx: Tx, id: string, cle: string, valeur: unknown): Promise<void> {
  const v = JSON.stringify(valeur);
  if (v.length > 1_000_000) throw new ErreurMetier("mémoire du workflow pleine (1 Mo au plus par nœud)");
  await tx`UPDATE automatisation SET memoire = jsonb_set(memoire, ${[cle]}, ${valeur}::jsonb) WHERE id = ${id}`;
}

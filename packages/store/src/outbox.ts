// Outbox des événements et file de jobs Postgres (migration 005).
//
// Côté API : `ajouterEvenement` dans la transaction métier (withTenant). Côté worker : `avecWorker`
// (rôle auto_worker, tous tenants) pour prendre, terminer ou reporter les jobs.
import type { Sql, Tx } from "./db";
import { enfilerWebhooks } from "./webhooks";
import { enfilerAutomatisations } from "./automatisations";

/** Job de livraison d'un événement de l'outbox vers le webhook. */
export const JOB_LIVRAISON = "evenement.livrer";

export type StatutEvenement = "a_livrer" | "livre" | "echec";

export interface EvenementStocke {
  id: string;
  tenantId: string;
  type: string;
  /** Corps JSON exact, signé à chaque essai. */
  corps: string;
  statut: StatutEvenement;
  essais: number;
  derniereErreur: string | null;
  livreAt: string | null;
  createdAt: string;
}

interface EvenementRow {
  id: string;
  tenant_id: string;
  type: string;
  corps: string;
  statut: StatutEvenement;
  essais: number;
  derniere_erreur: string | null;
  livre_at: Date | null;
  created_at: Date;
}

const evenement = (r: EvenementRow): EvenementStocke => ({
  id: r.id,
  tenantId: r.tenant_id,
  type: r.type,
  corps: r.corps,
  statut: r.statut,
  essais: r.essais,
  derniereErreur: r.derniere_erreur,
  livreAt: r.livre_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export type StatutJob = "en_attente" | "en_cours" | "fait" | "echec";

export interface Job<P = Record<string, unknown>> {
  id: string;
  tenantId: string | null;
  type: string;
  payload: P;
  cle: string | null;
  statut: StatutJob;
  /** Essais commencés, celui en cours compris. */
  essais: number;
  maxEssais: number;
  derniereErreur: string | null;
}

interface JobRow {
  id: string;
  tenant_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  cle: string | null;
  statut: StatutJob;
  essais: number;
  max_essais: number;
  derniere_erreur: string | null;
}

const job = (r: JobRow): Job => ({
  id: r.id,
  tenantId: r.tenant_id,
  type: r.type,
  payload: r.payload,
  cle: r.cle,
  statut: r.statut,
  essais: r.essais,
  maxEssais: r.max_essais,
  derniereErreur: r.derniere_erreur,
});

/** Transaction du worker : rôle auto_worker, seul autorisé à lire l'outbox et les jobs de tous les tenants. */
export function avecWorker<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE auto_worker`;
    return fn(tx);
  });
}

export interface OptionsJob {
  /** Clé de dédoublonnage : un job existant de même clé rend l'ajout sans effet. */
  cle?: string;
  executerApres?: Date;
  maxEssais?: number;
  /** Tenant explicite (worker) ; par défaut celui de la transaction (`app.tenant`), NULL hors tenant. */
  tenantId?: string | null;
}

/** Ajoute un job ; renvoie son id, ou null si la clé existait déjà. */
export async function enfiler(tx: Tx, type: string, payload: object = {}, o: OptionsJob = {}): Promise<string | null> {
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO job (tenant_id, type, payload, cle, executer_apres, max_essais)
    VALUES (coalesce(${o.tenantId ?? null}::uuid, CASE WHEN ${o.tenantId === undefined} THEN app_tenant() END),
      ${type}, ${payload}, ${o.cle ?? null}, ${o.executerApres ?? new Date()}, ${o.maxEssais ?? 10})
    ON CONFLICT (cle) DO NOTHING RETURNING id`;
  return r?.id ?? null;
}

/**
 * Ajoute un événement à l'outbox avec son job de livraison, dans la transaction métier : l'événement
 * existe si et seulement si l'action est validée. Corps `{ id, type, tenantId, date, data }`, figé ici.
 */
export async function ajouterEvenement(
  tx: Tx,
  type: string,
  data: unknown,
  maxEssais = 15,
): Promise<{ id: string; corps: string }> {
  const [r] = await tx<{ tenant: string | null }[]>`SELECT app_tenant() AS tenant`;
  if (!r?.tenant) throw new Error("ajouterEvenement : transaction sans tenant (withTenant requis)");
  const id = Bun.randomUUIDv7();
  const corps = JSON.stringify({ id, type, tenantId: r.tenant, date: new Date().toISOString(), data });
  await tx`INSERT INTO evenement (id, type, corps) VALUES (${id}, ${type}, ${corps})`;
  await enfiler(tx, JOB_LIVRAISON, { evenementId: id }, { maxEssais });
  await enfilerWebhooks(tx, id, type);
  await enfilerAutomatisations(tx, id, type, corps);
  return { id, corps };
}

/** Événements du tenant courant (withTenant), plus récents d'abord. */
export async function listerEvenements(tx: Tx, statut?: StatutEvenement, limite = 100): Promise<EvenementStocke[]> {
  const rows = statut
    ? await tx<
        EvenementRow[]
      >`SELECT * FROM evenement WHERE statut = ${statut} ORDER BY created_at DESC LIMIT ${limite}`
    : await tx<EvenementRow[]>`SELECT * FROM evenement ORDER BY created_at DESC LIMIT ${limite}`;
  return rows.map(evenement);
}

export async function lireEvenement(sql: Sql, id: string): Promise<EvenementStocke | null> {
  const [r] = await avecWorker(sql, (tx) => tx<EvenementRow[]>`SELECT * FROM evenement WHERE id = ${id}`);
  return r ? evenement(r) : null;
}

/** Résultat d'un essai de livraison : livré (erreur null), en échec temporaire ou définitif. */
export async function noterLivraison(sql: Sql, id: string, erreur: string | null, definitif = false): Promise<void> {
  await avecWorker(sql, async (tx) => {
    if (erreur === null)
      await tx`UPDATE evenement SET statut = 'livre', essais = essais + 1, livre_at = now(), derniere_erreur = NULL
        WHERE id = ${id}`;
    else if (definitif)
      await tx`UPDATE evenement SET statut = 'echec', derniere_erreur = ${erreur}
        WHERE id = ${id} AND statut <> 'livre'`;
    else await tx`UPDATE evenement SET essais = essais + 1, derniere_erreur = ${erreur} WHERE id = ${id}`;
  });
}

/**
 * Prend jusqu'à `limite` jobs exécutables (FOR UPDATE SKIP LOCKED : plusieurs workers ne prennent jamais
 * le même) et les loue pour `bailMs`. Un job dont le bail a expiré (worker arrêté en cours) est repris ;
 * s'il a épuisé ses essais, il passe en échec.
 */
export async function prendreJobs(sql: Sql, types: string[], limite = 10, bailMs = 60_000): Promise<Job[]> {
  if (!types.length) return [];
  return avecWorker(sql, async (tx) => {
    await tx`UPDATE job SET statut = 'echec', derniere_erreur = coalesce(derniere_erreur || ' ; ', '') || 'bail expiré',
        bail_jusqua = NULL, updated_at = now()
      WHERE statut = 'en_cours' AND bail_jusqua < now() AND essais >= max_essais`;
    const rows = await tx<JobRow[]>`
      UPDATE job j SET statut = 'en_cours', essais = j.essais + 1,
        bail_jusqua = now() + ${bailMs} * interval '1 millisecond', updated_at = now()
      FROM (
        SELECT id FROM job
        WHERE type IN ${tx(types)}
          AND ((statut = 'en_attente' AND executer_apres <= now()) OR (statut = 'en_cours' AND bail_jusqua < now()))
        ORDER BY executer_apres
        LIMIT ${limite}
        FOR UPDATE SKIP LOCKED
      ) s
      WHERE j.id = s.id
      RETURNING j.*`;
    return rows.map(job);
  });
}

export async function terminerJob(sql: Sql, id: string): Promise<void> {
  await avecWorker(
    sql,
    (tx) => tx`UPDATE job SET statut = 'fait', bail_jusqua = NULL, derniere_erreur = NULL, updated_at = now()
      WHERE id = ${id}`,
  );
}

/** Après un essai en échec : nouvel essai dans `delaiMs`, ou échec définitif si les essais sont épuisés. */
export async function reporterJob(sql: Sql, j: Job, erreur: string, delaiMs: number): Promise<"reporte" | "echec"> {
  const definitif = j.essais >= j.maxEssais;
  await avecWorker(sql, (tx) =>
    definitif
      ? tx`UPDATE job SET statut = 'echec', bail_jusqua = NULL, derniere_erreur = ${erreur}, updated_at = now()
          WHERE id = ${j.id}`
      : tx`UPDATE job SET statut = 'en_attente', bail_jusqua = NULL, derniere_erreur = ${erreur},
          executer_apres = now() + ${delaiMs} * interval '1 millisecond', updated_at = now()
          WHERE id = ${j.id}`,
  );
  return definitif ? "echec" : "reporte";
}

export async function lireJob(sql: Sql, id: string): Promise<Job | null> {
  const [r] = await avecWorker(sql, (tx) => tx<JobRow[]>`SELECT * FROM job WHERE id = ${id}`);
  return r ? job(r) : null;
}

/** Délai exponentiel avant l'essai suivant : base × 2^(essais − 1), plafonné. */
export const delaiNouvelEssai = (essais: number, baseMs = 2_000, maxMs = 3_600_000) =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, essais - 1));

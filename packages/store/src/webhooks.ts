// Abonnements webhook par tenant (migration 014) : livrés par le worker comme l'outbox opérateur.
import type { Sql, Tx } from "./db";
import { avecWorker, enfiler } from "./outbox";
import { ErreurMetier, journaliser } from "./index";

/** Job de livraison d'un événement vers un abonnement webhook d'un tenant. */
export const JOB_WEBHOOK = "webhook.livrer";

export interface Webhook {
  id: string;
  url: string;
  types: string[];
  actif: boolean;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  url: string;
  types: string[];
  actif: boolean;
  created_at: Date;
  secret_chiffre: Uint8Array;
}

const webhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  types: r.types,
  actif: r.actif,
  createdAt: r.created_at.toISOString(),
});

export async function creerWebhook(
  tx: Tx,
  actor: string | null,
  w: { url: string; types: string[]; secretChiffre: Uint8Array },
): Promise<Webhook> {
  const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook`;
  if (n!.n >= 10) throw new ErreurMetier("10 abonnements webhook au plus par entreprise");
  const [r] = await tx<WebhookRow[]>`
    INSERT INTO webhook (url, types, secret_chiffre) VALUES (${w.url}, ${w.types}, ${w.secretChiffre}) RETURNING *`;
  await journaliser(tx, actor, "webhook.creer", r!.id, { url: w.url, types: w.types });
  return webhook(r!);
}

export async function listerWebhooks(tx: Tx): Promise<Webhook[]> {
  return (await tx<WebhookRow[]>`SELECT * FROM webhook ORDER BY created_at`).map(webhook);
}

export async function supprimerWebhook(tx: Tx, actor: string | null, id: string): Promise<void> {
  const r = await tx`DELETE FROM webhook WHERE id = ${id} RETURNING id`;
  if (!r.length) throw new ErreurMetier("abonnement introuvable", [], 404);
  await journaliser(tx, actor, "webhook.supprimer", id);
}

/** Dans la transaction de l'événement : un job de livraison par abonnement actif concerné. */
export async function enfilerWebhooks(tx: Tx, evenementId: string, type: string): Promise<number> {
  const abonnes = await tx<{ id: string }[]>`
    SELECT id FROM webhook WHERE actif AND (cardinality(types) = 0 OR ${type} = ANY (types))`;
  for (const a of abonnes) await enfiler(tx, JOB_WEBHOOK, { evenementId, webhookId: a.id }, { maxEssais: 15 });
  return abonnes.length;
}

/** Lecture par le worker (tous tenants) : URL, tenant et secret chiffré. */
export async function lireWebhook(
  sql: Sql,
  id: string,
): Promise<{ id: string; tenantId: string; url: string; actif: boolean; secretChiffre: Uint8Array } | null> {
  const [r] = await avecWorker(
    sql,
    (tx) => tx<(WebhookRow & { tenant_id: string })[]>`SELECT * FROM webhook WHERE id = ${id}`,
  );
  return r
    ? { id: r.id, tenantId: r.tenant_id, url: r.url, actif: r.actif, secretChiffre: new Uint8Array(r.secret_chiffre) }
    : null;
}

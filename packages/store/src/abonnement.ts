// Lot abonnement : état de l'abonnement, consommation et journal des événements Stripe.
import type { Tx } from "./db";

export interface Abonnement {
  plan: "gratuit" | "pro" | "business";
  periodicite: "mensuel" | "annuel" | null;
  statut: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  essaiUtilise: boolean;
  essaiFin: string | null;
  periodeFin: string | null;
  annulationFinPeriode: boolean;
}

interface AbonnementRow {
  plan: Abonnement["plan"];
  periodicite: Abonnement["periodicite"];
  statut: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  essai_utilise: boolean;
  essai_fin: Date | null;
  periode_fin: Date | null;
  annulation_fin_periode: boolean;
}

const SANS: Abonnement = {
  plan: "gratuit",
  periodicite: null,
  statut: "aucun",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  essaiUtilise: false,
  essaiFin: null,
  periodeFin: null,
  annulationFinPeriode: false,
};

/** Pose le tenant courant dans une transaction déjà passée au rôle `auto_app`. */
export async function poserTenant(tx: Tx, tenantId: string) {
  await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
}

/** Abonnement du tenant courant (Gratuit sans ligne). */
export async function lireAbonnement(tx: Tx): Promise<Abonnement> {
  const [r] = await tx<AbonnementRow[]>`SELECT * FROM abonnement`;
  if (!r) return { ...SANS };
  return {
    plan: r.plan,
    periodicite: r.periodicite,
    statut: r.statut,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    essaiUtilise: r.essai_utilise,
    essaiFin: r.essai_fin?.toISOString() ?? null,
    periodeFin: r.periode_fin?.toISOString() ?? null,
    annulationFinPeriode: r.annulation_fin_periode,
  };
}

/** L'essai ne peut que passer à « utilisé ». */
export type MajAbonnement = Partial<Omit<Abonnement, "essaiUtilise">> & { essaiUtilise?: true };

/**
 * Met à jour l'abonnement du tenant courant. Avec `stripeMaj` (date de l'événement Stripe), la mise
 * à jour est ignorée si un événement plus récent a déjà été appliqué ; renvoie `false` dans ce cas.
 */
export async function majAbonnement(tx: Tx, m: MajAbonnement, stripeMaj?: Date): Promise<boolean> {
  await tx`INSERT INTO abonnement DEFAULT VALUES ON CONFLICT (tenant_id) DO NOTHING`;
  const [cur] = await tx<{ stripe_maj: Date | null }[]>`SELECT stripe_maj FROM abonnement FOR UPDATE`;
  if (stripeMaj && cur!.stripe_maj && cur!.stripe_maj > stripeMaj) return false;
  // `undefined` : colonne inchangée ; `null` : colonne effacée.
  const v = <K extends keyof MajAbonnement>(k: K) => m[k];
  const cols: Record<string, unknown> = {
    plan: v("plan"),
    periodicite: v("periodicite"),
    statut: v("statut"),
    stripe_customer_id: v("stripeCustomerId"),
    stripe_subscription_id: v("stripeSubscriptionId"),
    essai_utilise: v("essaiUtilise"),
    essai_fin: v("essaiFin"),
    periode_fin: v("periodeFin"),
    annulation_fin_periode: v("annulationFinPeriode"),
  };
  const set = Object.fromEntries(Object.entries(cols).filter(([, x]) => x !== undefined));
  if (stripeMaj) set.stripe_maj = stripeMaj;
  set.updated_at = new Date();
  await tx`UPDATE abonnement SET ${tx(set)}`;
  return true;
}

/** Compteur mensuel du tenant courant. */
export async function lireCompteur(tx: Tx, periode: string, ressource: string): Promise<number> {
  const [r] = await tx<{ quantite: string }[]>`
    SELECT quantite FROM consommation WHERE periode = ${periode} AND ressource = ${ressource}`;
  return Number(r?.quantite ?? 0);
}

/** Incrémente un compteur mensuel du tenant courant ; renvoie la nouvelle valeur. */
export async function incrementerCompteur(tx: Tx, periode: string, ressource: string, n = 1): Promise<number> {
  const [r] = await tx<{ quantite: string }[]>`
    INSERT INTO consommation (periode, ressource, quantite) VALUES (${periode}, ${ressource}, ${n})
    ON CONFLICT (tenant_id, periode, ressource) DO UPDATE SET quantite = consommation.quantite + ${n}
    RETURNING quantite`;
  return Number(r!.quantite);
}

/** Employés présents (sans date de sortie passée). */
export async function compterEmployesActifs(tx: Tx): Promise<number> {
  const [r] = await tx<{ n: string }[]>`
    SELECT count(*) AS n FROM employe WHERE date_sortie IS NULL OR date_sortie >= current_date`;
  return Number(r!.n);
}

/** Octets des exemplaires figés du tenant courant. */
export async function octetsStockes(tx: Tx): Promise<number> {
  const [r] = await tx<{ n: string }[]>`SELECT coalesce(sum(taille), 0) AS n FROM fichier`;
  return Number(r!.n);
}

// Journal des événements Stripe (opérateur, hors RLS : appeler hors du rôle auto_app) -----------

/** Enregistre un événement ; `false` s'il a déjà été reçu (rejeu). Bloque tant qu'un doublon est en cours. */
export async function recevoirEvenementStripe(
  tx: Tx,
  e: { id: string; type: string; creeAt: Date; objetId?: string | null },
): Promise<boolean> {
  const r = await tx`INSERT INTO stripe_evenement (id, type, cree_at, objet_id)
    VALUES (${e.id}, ${e.type}, ${e.creeAt}, ${e.objetId ?? null}) ON CONFLICT (id) DO NOTHING RETURNING id`;
  return r.length > 0;
}

export async function conclureEvenementStripe(
  tx: Tx,
  id: string,
  r: { resultat: string; tenantId?: string | null; documentId?: string | null },
) {
  await tx`UPDATE stripe_evenement SET resultat = ${r.resultat}, tenant_id = ${r.tenantId ?? null},
    document_id = ${r.documentId ?? null} WHERE id = ${id}`;
}

/** Document déjà émis pour une facture Stripe payée. */
export async function factureStripeEmise(tx: Tx, invoiceId: string): Promise<string | null> {
  const [r] = await tx<{ document_id: string }[]>`
    SELECT document_id FROM stripe_evenement
    WHERE type = 'invoice.paid' AND objet_id = ${invoiceId} AND document_id IS NOT NULL`;
  return r?.document_id ?? null;
}

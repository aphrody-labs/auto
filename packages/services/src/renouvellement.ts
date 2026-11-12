// Rappel avant renouvellement : sept jours avant la fin de la période payée (ou de l'essai), l'entreprise reçoit
// un événement `abonnement.renouvellement_proche` et ses propriétaires un e-mail avec la date, le prix HT et le
// lien pour changer d'offre ou résilier. Aucun renouvellement ne doit surprendre (docs/recon/avis.md).
import { PLANS } from "@auto/billing";
import type { EnvoyeurMail } from "@auto/mail";
import { lireAbonnement, withTenant, type Sql } from "@auto/store";
import { outbox, type Emetteur } from "./evenements";

/** Délai du rappel, en jours avant l'échéance. */
export const DELAI_RAPPEL_JOURS = 7;

const TZ = "Europe/Paris";
const jourParis = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dateLongue = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: TZ, dateStyle: "long" });
const eur = (c: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(c / 100);

/** Jour (AAAA-MM-JJ, Paris) situé `n` jours après `jour`. */
export const jourPlus = (jour: string, n: number) =>
  new Date(Date.parse(`${jour}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface Rappel {
  plan: string;
  periodicite: string;
  echeance: string;
  essai: boolean;
  montantHtCents: number;
}

/**
 * Rappel du jour pour un tenant : null si rien n'arrive à échéance dans exactement `DELAI_RAPPEL_JOURS` jours
 * (formule gratuite, résiliation programmée, abonnement inactif). Appelé une fois par jour et par tenant.
 */
export async function rappelerRenouvellement(
  sql: Sql,
  tenantId: string,
  jour: string,
  o: { envoyeur?: EnvoyeurMail | null; urlApp?: string; publier?: Emetteur } = {},
): Promise<Rappel | null> {
  const publier = o.publier ?? outbox;
  const r = await withTenant(sql, tenantId, async (tx) => {
    const a = await lireAbonnement(tx);
    if (a.plan === "gratuit" || a.annulationFinPeriode) return null;
    const essai = a.statut === "trialing";
    if (!essai && a.statut !== "active") return null;
    const fin = essai ? a.essaiFin : a.periodeFin;
    if (!fin || jourParis(new Date(fin)) !== jourPlus(jour, DELAI_RAPPEL_JOURS)) return null;
    const periodicite = a.periodicite ?? "mensuel";
    const rappel: Rappel = {
      plan: a.plan,
      periodicite,
      echeance: fin,
      essai,
      montantHtCents: PLANS[a.plan].prixHtCents[periodicite],
    };
    await publier(tx, "abonnement.renouvellement_proche", rappel);
    return rappel;
  });
  if (!r || !o.envoyeur) return r;
  // Comptes et rôles : hors RLS (rôle applicatif sans accès à membership), comme le module comptes.
  const proprietaires = await sql<{ email: string }[]>`
    SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
    WHERE m.tenant_id = ${tenantId} AND m.role = 'owner' ORDER BY u.email`;
  if (proprietaires.length)
    await o.envoyeur.envoyer({ a: proprietaires.map((p) => p.email), ...texteRappel(r, o.urlApp) });
  return r;
}

export function texteRappel(r: Rappel, urlApp = "https://auto.aphrody.com") {
  const offre = `${PLANS[r.plan as keyof typeof PLANS].nom} (${r.periodicite})`;
  const date = dateLongue(new Date(r.echeance));
  const prix = `${eur(r.montantHtCents)} HT`;
  const lien = `${urlApp}/app/parametres`;
  return r.essai
    ? {
        sujet: `Votre essai auto se termine le ${date}`,
        texte: `Bonjour,\n\nVotre essai de l'offre ${offre} se termine le ${date}. Sans action de votre part, l'abonnement démarre ce jour-là pour ${prix}.\n\nPour changer d'offre ou ne pas continuer, sans frais : ${lien}\n\nL'équipe auto`,
      }
    : {
        sujet: `Votre abonnement auto sera renouvelé le ${date}`,
        texte: `Bonjour,\n\nVotre abonnement ${offre} sera renouvelé le ${date} pour ${prix}.\n\nPour changer d'offre ou résilier avant cette date, sans frais : ${lien}\n\nL'équipe auto`,
      };
}

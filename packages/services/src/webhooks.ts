// Abonnements webhook par tenant : chaque entreprise reçoit ses propres événements signés (son n8n, son
// outil d'automatisation), en plus de la livraison opérateur. Même format et même signature que l'outbox.
import { ErreurMetier } from "@auto/store";

/** Info de dérivation de la clé du secret de signature : propre au tenant. */
export const infoSecret = (tenantId: string) => `webhook:${tenantId}`;

export const PRIVE = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd]/i,
];

/**
 * URL de destination : https obligatoire et aucune adresse privée en production (pas de requête vers le
 * réseau interne de l'opérateur). En dev, `http://localhost` est admis pour les essais.
 */
export function verifierUrl(brute: string, production = Bun.env.NODE_ENV === "production"): string {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    throw new ErreurMetier("URL invalide");
  }
  const hote = u.hostname.toLowerCase();
  const local = hote === "localhost" || PRIVE.some((r) => r.test(hote));
  if (production && (u.protocol !== "https:" || local || hote.endsWith(".internal")))
    throw new ErreurMetier("URL https publique exigée");
  if (!production && u.protocol !== "https:" && !local)
    throw new ErreurMetier("URL https exigée (http : localhost seulement)");
  if (u.username || u.password) throw new ErreurMetier("identifiants interdits dans l'URL");
  return u.toString();
}

export const TYPE = /^[a-z_]+\.[a-z_]+$/;

// Client Better Auth du front : même origine (/api/auth, relayé vers l'API par le serveur web), cookie de
// session HttpOnly. Plugins alignés sur le serveur (packages/tenancy/src/auth.ts).
import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { ac, roles } from "@auto/tenancy/droits";
import { adminClient, magicLinkClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [
    organizationClient({ ac, roles }),
    twoFactorClient(),
    passkeyClient(),
    apiKeyClient(),
    adminClient(),
    magicLinkClient(),
    // Connexion lancée par un client OAuth (MCP) : la requête signée de /oauth2/authorize est relayée.
    oauthProviderClient(),
  ],
});

/** Message d'erreur Better Auth en français (codes stables, messages anglais du serveur). */
const MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_LINKED:
    "Connectez-vous avec votre méthode habituelle, puis associez ce fournisseur dans Paramètres → Sécurité.",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "Conservez au moins une méthode de connexion avant de dissocier ce compte.",
  INVALID_EMAIL_OR_PASSWORD: "E-mail ou mot de passe incorrect.",
  INVALID_PASSWORD: "Mot de passe incorrect.",
  INVALID_CODE: "Code invalide.",
  INVALID_BACKUP_CODE: "Code de secours invalide.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Trop d'essais : reconnectez-vous.",
  INVALID_TWO_FACTOR_COOKIE: "Délai dépassé : reconnectez-vous.",
  USER_NOT_FOUND: "Aucun compte pour cette adresse.",
  BANNED_USER: "Compte suspendu par l'opérateur.",
  PASSWORD_TOO_SHORT: "Mot de passe : 12 caractères minimum.",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "Cette personne est déjà membre de l'entreprise.",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: "Seul un propriétaire peut nommer un propriétaire.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: "L'entreprise doit garder au moins un propriétaire.",
  INVITATION_NOT_FOUND: "Invitation invalide, expirée ou déjà utilisée.",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: "Cette invitation est destinée à une autre adresse.",
};

export function messageAuth(e: { code?: string; message?: string; status?: number } | null | undefined) {
  if (!e) return "";
  if (e.status === 429) return "Trop de tentatives : réessayez dans une minute.";
  return (e.code && MESSAGES[e.code]) || e.message || "Erreur d'authentification.";
}

/** Retour d'un appel qui poursuit un flux OAuth (consentement, connexion lancée par un client MCP). */
export function suivreRedirection(d: unknown): boolean {
  const r = d as { redirect?: boolean; url?: string } | null;
  if (r?.url && (r.redirect ?? true) && /^https?:\/\//.test(r.url)) {
    location.assign(r.url);
    return true;
  }
  return false;
}

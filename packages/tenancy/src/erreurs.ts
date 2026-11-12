// Erreurs de Better Auth (APIError, codes en anglais) traduites en erreurs métier d'auto.
import { ErreurMetier } from "@auto/store";

const CODES: Record<string, [string, number]> = {
  USER_ALREADY_EXISTS: ["email déjà utilisé", 409],
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: ["email déjà utilisé", 409],
  INVALID_EMAIL_OR_PASSWORD: ["identifiants invalides", 401],
  INVALID_PASSWORD: ["identifiants invalides", 401],
  INVALID_EMAIL: ["email invalide", 422],
  PASSWORD_TOO_SHORT: ["mot de passe : 12 caractères minimum", 422],
  PASSWORD_TOO_LONG: ["mot de passe trop long", 422],
  INVALID_CODE: ["code invalide", 401],
  INVALID_BACKUP_CODE: ["code invalide", 401],
  INVALID_TWO_FACTOR_COOKIE: ["défi expiré ou inconnu", 401],
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: ["trop d'essais : reconnectez-vous", 429],
  TOTP_NOT_ENABLED: ["double authentification inactive", 409],
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: ["déjà membre de l'entreprise", 409],
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: ["seul un owner peut nommer un owner", 403],
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: ["droit « membres » refusé", 403],
  INVITATION_NOT_FOUND: ["invitation invalide, expirée ou déjà utilisée", 410],
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: ["invitation destinée à une autre adresse", 403],
  ORGANIZATION_NOT_FOUND: ["entreprise introuvable", 404],
  MEMBER_NOT_FOUND: ["membre introuvable", 404],
  USER_NOT_MEMBER_OF_ORGANIZATION: ["aucune entreprise accessible", 403],
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: ["aucune entreprise accessible", 403],
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: ["l'entreprise garde au moins un owner", 409],
  INSUFFICIENT_API_KEY_PERMISSIONS: ["droit « parametres » refusé", 403],
  BANNED_USER: ["compte suspendu par l'opérateur", 403],
};

interface ErreurBa {
  name?: string;
  statusCode?: number;
  body?: { code?: string; message?: string };
  message?: string;
}

/** Erreur Better Auth → ErreurMetier ; toute autre erreur est relancée telle quelle. */
export function traduire(e: unknown): never {
  const x = e as ErreurBa;
  if (x?.name === "APIError" || (x && typeof x.statusCode === "number" && x.body)) {
    const code = x.body?.code ?? "";
    const [message, status] = CODES[code] ?? [x.body?.message ?? x.message ?? "erreur d'authentification", 0];
    throw new ErreurMetier(message, code ? [code] : [], status || x.statusCode || 400);
  }
  throw e;
}

export async function ba<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    return traduire(e);
  }
}

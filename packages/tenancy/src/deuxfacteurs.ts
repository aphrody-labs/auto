// Double authentification TOTP par le plugin twoFactor de Better Auth (façades des routes /v1/2fa).
// Le front appelle directement /api/auth/two-factor/* ; ces fonctions servent l'API, le CLI et les tests.
import { ErreurMetier, type Sql } from "@auto/store";
import { authDe } from "./auth";
import { ba } from "./erreurs";
import { auNomDe, lireCookie, type Auth } from "./index";

/** Secret base32 de l'URI otpauth (saisie manuelle dans l'application d'authentification). */
const secretDe = (uri: string) => new URL(uri).searchParams.get("secret") ?? "";

/** Enrôlement (mot de passe exigé) : secret, URI otpauth et codes de secours ; inactif avant confirmation. */
export async function enrolerTotp(sql: Sql, auth: Auth, motDePasse: string) {
  const r = await auNomDe(sql, auth, (headers) =>
    ba(authDe(sql).api.enableTwoFactor({ headers, body: { password: String(motDePasse ?? ""), method: "totp" } })),
  );
  if (r.method !== "totp") throw new ErreurMetier("enrôlement TOTP impossible", [], 500);
  return { secret: secretDe(r.totpURI), uri: r.totpURI, codesSecours: r.backupCodes };
}

/** Session que Better Auth recrée en activant la 2FA : elle n'est jamais remise, on la supprime. */
async function oublierSessions(sql: Sql, cookies: string[]) {
  const nom = (await authDe(sql).$context).authCookies.sessionToken.name;
  const v = lireCookie(cookies, nom);
  if (v) await sql`DELETE FROM session WHERE token = ${decodeURIComponent(v).split(".")[0]!}`;
}

/** Confirmation par un premier code : la 2FA devient active. */
export async function confirmerTotp(sql: Sql, auth: Auth, code: string) {
  const { headers } = await auNomDe(sql, auth, (h) =>
    ba(authDe(sql).api.verifyTOTP({ headers: h, body: { code: String(code ?? "") }, returnHeaders: true })),
  );
  await oublierSessions(sql, headers.getSetCookie());
  return { actif: true };
}

export async function totpActif(sql: Sql, userId: string): Promise<boolean> {
  const [u] = await sql<{ two_factor_enabled: boolean | null }[]>`
    SELECT two_factor_enabled FROM app_user WHERE id = ${userId}`;
  return u?.two_factor_enabled ?? false;
}

/** Désactivation : mot de passe et code (TOTP) exigés. */
export async function desactiverTotp(sql: Sql, auth: Auth, motDePasse: string, code: string) {
  if (!(await totpActif(sql, auth.userId))) throw new ErreurMetier("double authentification inactive", [], 409);
  const api = authDe(sql).api;
  await auNomDe(sql, auth, async (headers) => {
    await ba(api.verifyTOTP({ headers, body: { code: String(code ?? "") } }));
    const { headers: h } = await ba(
      api.disableTwoFactor({ headers, body: { password: String(motDePasse ?? "") }, returnHeaders: true }),
    );
    await oublierSessions(sql, h.getSetCookie());
  });
}

/** Nouveaux codes de secours (les anciens sont invalidés) ; mot de passe exigé. */
export async function regenererCodesSecours(sql: Sql, auth: Auth, motDePasse: string) {
  if (!(await totpActif(sql, auth.userId))) throw new ErreurMetier("double authentification inactive", [], 409);
  const r = await auNomDe(sql, auth, (headers) =>
    ba(authDe(sql).api.generateBackupCodes({ headers, body: { password: String(motDePasse ?? "") } })),
  );
  return { codesSecours: r.backupCodes };
}

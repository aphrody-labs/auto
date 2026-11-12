export type FournisseurCourrier = "google" | "microsoft";
export interface JetonsCourrier {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}
export function configurationCourrier(f: FournisseurCourrier, env: Record<string, string | undefined> = Bun.env) {
  const id = env[`AUTO_${f.toUpperCase()}_CLIENT_ID`],
    secret = env[`AUTO_${f.toUpperCase()}_CLIENT_SECRET`];
  if (!id || !secret) throw new Error("Connexion mail du fournisseur non configurée");
  const origine = new URL(env.AUTO_URL_APP ?? "");
  if (origine.protocol !== "https:" && env.NODE_ENV !== "test") throw new Error("Origine HTTPS requise");
  const base =
    f === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
  const token =
    f === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const scope =
    f === "google"
      ? "https://www.googleapis.com/auth/gmail.readonly"
      : "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read";
  return { id, secret, base, token, scope, redirect: `${origine.origin}/api/auth/callback/${f}` };
}
export async function autorisationCourrier(f: FournisseurCourrier, state: string, verifier: string) {
  const c = configurationCourrier(f),
    u = new URL(c.base);
  const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
  u.search = new URLSearchParams({
    client_id: c.id,
    redirect_uri: c.redirect,
    response_type: "code",
    scope: c.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(f === "google"
      ? { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" }
      : { prompt: "select_account" }),
  }).toString();
  return u.href;
}
export async function echangerCourrier(
  f: FournisseurCourrier,
  params: Record<string, string>,
  transport: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
): Promise<JetonsCourrier> {
  const c = configurationCourrier(f);
  const r = await transport(c.token, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, redirect_uri: c.redirect, ...params }),
  });
  if (!r.ok) throw new Error(`Autorisation mail refusée (${r.status}) : reconnecter le compte`);
  const b = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!b.access_token || !Number.isFinite(b.expires_in) || b.expires_in! <= 0)
    throw new Error("Réponse OAuth mail invalide");
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: Date.now() + b.expires_in! * 1000,
    scope: b.scope,
  };
}
/** Aucun curseur distant ne doit pouvoir exfiltrer le jeton vers une autre origine. */
export function urlGraphCourrier(value: string) {
  const u = new URL(value);
  if (u.origin !== "https://graph.microsoft.com" || u.username || u.password || !u.pathname.startsWith("/v1.0/me/"))
    throw new Error("Curseur Outlook invalide");
  return u.href;
}

// Couche comptes d'auto sur Better Auth (auth.ts) : résolution de l'appelant pour la RLS, inscription avec
// l'entreprise (SIRET), connexion, clés d'API, membres. Les routes /v1 historiques en sont des façades ;
// le front parle directement à Better Auth (/api/auth).
import { sirenValide, siretValide, tvaIntracomFr } from "@auto/domain";
import { ErreurMetier, withTenant, type Sql } from "@auto/store";
import { makeSignature } from "better-auth/crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { authDe, type AuthAuto } from "./auth";
import { emailValide, normaliserEmail } from "./commun";
import { estRole, peut, type Action, type Role } from "./droits";
import { requetePermise, type Segment } from "./segments";
export * from "./segments";
import { ba } from "./erreurs";

export * from "./auth";
export * from "./chiffrement";
export { hash } from "./commun";
export * from "./deuxfacteurs";
export * from "./droits";
export * from "./erreurs";
export * from "./invitations";
export { migrerDeuxFacteurs } from "./legacy";
export * from "./mail";
export { synchroniserOperateurs } from "./operateurs";
export * from "./totp";

export interface Auth {
  segments?: Segment[];
  userId: string;
  tenantId: string;
  role: Role;
}
export function exigerSegments(a: Auth, req: Request) {
  if (!requetePermise(a, new URL(req.url).pathname, req.method))
    throw new ErreurMetier("accès refusé à ce segment", [], 403);
}

export function exiger(auth: Auth, action: Action) {
  if (!peut(auth.role, action)) throw new ErreurMetier(`droit « ${action} » refusé pour le rôle ${auth.role}`, [], 403);
}

export const bearer = (jeton: string) => new Headers({ authorization: `Bearer ${jeton}` });

/** Rôle relu à chaque requête ; entreprise suspendue ou compte banni : aucun accès. */
export async function resoudre(sql: Sql, userId: string, tenantId: string | null | undefined): Promise<Auth | null> {
  if (!tenantId) return null;
  const [r] = await sql<{ role: string }[]>`
    SELECT m.role FROM membership m
    JOIN tenant t ON t.id = m.tenant_id AND t.suspendu_at IS NULL
    JOIN app_user u ON u.id = m.user_id
      AND (u.banned IS NOT TRUE OR (u.ban_expires IS NOT NULL AND u.ban_expires < now()))
    WHERE m.user_id = ${userId}::uuid AND m.tenant_id = ${tenantId}::uuid`;
  if (!r || !estRole(r.role)) return null;
  const [restriction] = await withTenant(
    sql,
    tenantId,
    (tx) => tx<{ segments: Segment[] }[]>`SELECT segments FROM membre_segments WHERE user_id=${userId}`,
  );
  return { userId, tenantId, role: r.role, ...(restriction ? { segments: restriction.segments } : {}) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Clé d'API (`auto_…`) : entreprise = référence de la clé, auteur = metadata.userId. */
async function parCle(sql: Sql, auth: AuthAuto, cle: string): Promise<Auth | null> {
  const r = await auth.api.verifyApiKey({ body: { key: cle } }).catch(() => null);
  if (!r?.valid || !r.key) return null;
  const userId = (r.key.metadata as { userId?: string } | null)?.userId;
  return userId && UUID.test(userId) ? resoudre(sql, userId, r.key.referenceId) : null;
}

const jwks = new WeakMap<AuthAuto, { jeu: ReturnType<typeof createLocalJWKSet>; lu: number }>();

/**
 * Jeton d'accès OAuth (JWT signé par le plugin jwt, émis aux clients MCP) : émetteur Better Auth, audience
 * = la ressource /mcp, entreprise = revendication `auto_tenant` (entreprise active lors du consentement).
 */
export async function verifierJetonOAuth(auth: AuthAuto, jeton: string) {
  const c = await auth.$context;
  let j = jwks.get(auth);
  if (!j || Date.now() - j.lu > 300_000) {
    const cles = (await auth.api.getJwks()) as JSONWebKeySet;
    jwks.set(auth, (j = { jeu: createLocalJWKSet(cles), lu: Date.now() }));
  }
  const origine = new URL(c.baseURL).origin;
  const { payload } = await jwtVerify(jeton, j.jeu, { issuer: c.baseURL, audience: `${origine}/mcp` });
  return payload;
}

async function parOAuth(sql: Sql, auth: AuthAuto, jeton: string): Promise<Auth | null> {
  const p = await verifierJetonOAuth(auth, jeton).catch(() => null);
  return p?.sub ? resoudre(sql, p.sub, p.auto_tenant as string | undefined) : null;
}

/**
 * Appelant d'une requête : session Better Auth (cookie, ou `Authorization: Bearer <jeton de session>`),
 * clé d'API (`Bearer auto_…` ou `x-api-key`), ou jeton d'accès OAuth d'un client MCP. Le tenant de la
 * session est son entreprise active ; il alimente withTenant et la RLS (`app.tenant`).
 */
export async function authentifierRequete(sql: Sql, headers: Headers, auth = authDe(sql)): Promise<Auth | null> {
  const jeton = headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  const cle = headers.get("x-api-key") ?? (jeton?.startsWith("auto_") ? jeton : null);
  if (cle) return parCle(sql, auth, cle);
  if (jeton && JWT.test(jeton)) return parOAuth(sql, auth, jeton);
  // Une résolution interne ne peut pas transmettre Set-Cookie au navigateur : laisser le renouvellement
  // au endpoint public Better Auth, appelé par le front, plutôt que prolonger uniquement la base.
  const s = await auth.api.getSession({ headers, query: { disableRefresh: true } }).catch(() => null);
  if (!s) return null;
  return resoudre(sql, s.user.id, (s.session as { activeOrganizationId?: string | null }).activeOrganizationId);
}

const parRequete = new WeakMap<Request, Promise<Auth | null>>();

/** Appelant d'une requête HTTP, résolu une seule fois par requête (quotas puis route). */
export function appelant(sql: Sql, req: Request): Promise<Auth | null> {
  let p = parRequete.get(req);
  if (!p) parRequete.set(req, (p = authentifierRequete(sql, req.headers)));
  return p;
}

/** Cookie de session signé (nom et valeur) d'un jeton de session : bancs de test, captures. */
export async function cookieSession(sql: Sql, token: string) {
  const c = await authDe(sql).$context;
  return {
    name: c.authCookies.sessionToken.name,
    value: encodeURIComponent(`${token}.${await makeSignature(token, c.secret)}`),
  };
}

/** Contrat historique : un jeton (session, clé d'API ou jeton OAuth) → `{ userId, tenantId, role }`. */
export function authentifier(sql: Sql, token: string | null | undefined): Promise<Auth | null> {
  if (!token) return Promise.resolve(null);
  return authentifierRequete(sql, bearer(token));
}

/**
 * Exécute un appel Better Auth au nom d'un membre authentifié par n'importe quel moyen (clé d'API,
 * OAuth) : session éphémère sur son entreprise, supprimée aussitôt après.
 */
export async function auNomDe<T>(sql: Sql, a: Auth, fn: (h: Headers) => Promise<T>): Promise<T> {
  const c = await authDe(sql).$context;
  const s = await c.internalAdapter.createSession(a.userId, true, { activeOrganizationId: a.tenantId });
  try {
    return await fn(bearer(s.token));
  } finally {
    await c.internalAdapter.deleteSession(s.token);
  }
}

export interface Inscription {
  email: string;
  motDePasse: string;
  nom?: string;
  entreprise: { nom: string; siret: string; adresse: string; franchiseTva?: boolean };
}

export interface Session {
  userId: string;
  tenantId: string;
  /** Jeton de session Better Auth (`Authorization: Bearer`). */
  session: string;
  /** En-têtes Set-Cookie à retransmettre au navigateur. */
  cookies?: string[];
}

const cookiesDe = (h: Headers | undefined) => h?.getSetCookie() ?? [];

/** Crée l'entreprise (tenant) de l'utilisateur, qui en devient owner. */
export async function creerEntreprise(sql: Sql, userId: string, e: Inscription["entreprise"]) {
  const erreurs: string[] = [];
  if (!siretValide(e?.siret ?? "")) erreurs.push("siret invalide");
  if (!e?.adresse?.trim()) erreurs.push("adresse manquante");
  if (!e?.nom?.trim()) erreurs.push("nom d'entreprise manquant");
  if (erreurs.length) throw new ErreurMetier("entreprise invalide", erreurs);
  const siret = e.siret.replace(/\s/g, "");
  const siren = siret.slice(0, 9);
  const franchise = e.franchiseTva ?? false;
  const org = await ba(
    authDe(sql).api.createOrganization({
      body: {
        userId,
        name: e.nom.trim(),
        slug: `${siren}-${crypto.randomUUID().slice(0, 8)}`,
        siren,
        siret,
        adresse: e.adresse.trim(),
        tvaIntracom: franchise ? undefined : tvaIntracomFr(siren),
        franchiseTva: franchise,
        keepCurrentActiveOrganization: true,
      },
    }),
  );
  if (!org) throw new ErreurMetier("création de l'entreprise impossible", [], 500);
  return org.id;
}

/** Inscription : utilisateur (Better Auth), entreprise et adhésion owner ; renvoie une session. */
export async function inscrire(sql: Sql, i: Inscription): Promise<Session> {
  const email = normaliserEmail(i?.email ?? "");
  const erreurs: string[] = [];
  if (!emailValide(email)) erreurs.push("email invalide");
  if (String(i?.motDePasse ?? "").length < 12) erreurs.push("mot de passe : 12 caractères minimum");
  if (!siretValide(i?.entreprise?.siret ?? "")) erreurs.push("siret invalide");
  if (!i?.entreprise?.adresse?.trim()) erreurs.push("adresse manquante");
  if (!i?.entreprise?.nom?.trim()) erreurs.push("nom d'entreprise manquant");
  if (erreurs.length) throw new ErreurMetier("inscription invalide", erreurs);
  const auth = authDe(sql);
  const [deja] = await sql`SELECT 1 FROM app_user WHERE email = ${email}`;
  if (deja) throw new ErreurMetier("email déjà utilisé", [], 409);
  const { headers, response } = await ba(
    auth.api.signUpEmail({
      body: { email, password: i.motDePasse, name: i.nom?.trim() || email.split("@")[0]! },
      returnHeaders: true,
    }),
  );
  const userId = response.user.id;
  let tenantId: string;
  try {
    tenantId = await creerEntreprise(sql, userId, i.entreprise);
  } catch (e) {
    await sql`DELETE FROM app_user WHERE id = ${userId}`;
    throw e;
  }
  const token = response.token!;
  await sql`UPDATE session SET active_organization_id = ${tenantId} WHERE token = ${token}`;
  return { userId, tenantId, session: token, cookies: cookiesDe(headers) };
}

export type Connexion =
  | Session
  /** 2FA active : la session s'obtient avec `defi` et un code (`validerDeuxFacteurs`). */
  | { deuxFacteurs: true; defi: string; cookies?: string[] };

/** Valeur d'un cookie dans des en-têtes Set-Cookie. */
export function lireCookie(cookies: string[], nom: string) {
  for (const c of cookies) {
    const [kv] = c.split(";");
    const i = kv!.indexOf("=");
    if (kv!.slice(0, i).trim() === nom) return kv!.slice(i + 1);
  }
  return null;
}

async function nomCookie(sql: Sql, nom: string) {
  return (await authDe(sql).$context).createAuthCookie(nom).name;
}

/** Choisit l'entreprise active d'une session (membre exigé) ; sinon garde celle par défaut. */
async function activer(sql: Sql, token: string, userId: string, tenantId?: string): Promise<string> {
  if (tenantId) {
    if (!(await resoudre(sql, userId, tenantId))) throw new ErreurMetier("aucune entreprise accessible", [], 403);
    await sql`UPDATE session SET active_organization_id = ${tenantId} WHERE token = ${token}`;
    return tenantId;
  }
  const [s] = await sql<{ active_organization_id: string | null }[]>`
    SELECT active_organization_id FROM session WHERE token = ${token}`;
  if (!s?.active_organization_id) throw new ErreurMetier("aucune entreprise accessible", [], 403);
  return s.active_organization_id;
}

/**
 * Connexion par email et mot de passe ; `tenantId` choisit l'entreprise si l'utilisateur en a plusieurs.
 * Avec la 2FA, renvoie un défi (cookie signé `two_factor` de Better Auth) au lieu d'une session.
 */
export async function connecter(sql: Sql, email: string, motDePasse: string, tenantId?: string): Promise<Connexion> {
  const { headers, response } = await ba(
    authDe(sql).api.signInEmail({
      body: { email: normaliserEmail(String(email ?? "")), password: String(motDePasse ?? "") },
      returnHeaders: true,
    }),
  );
  const cookies = cookiesDe(headers);
  if ("twoFactorRedirect" in response && response.twoFactorRedirect) {
    const defi = lireCookie(cookies, await nomCookie(sql, "two_factor"));
    if (!defi) throw new ErreurMetier("défi 2FA introuvable", [], 500);
    return { deuxFacteurs: true, defi: tenantId ? `${defi}~${tenantId}` : defi, cookies };
  }
  const r = response as { token: string; user: { id: string } };
  try {
    return {
      userId: r.user.id,
      tenantId: await activer(sql, r.token, r.user.id, tenantId),
      session: r.token,
      cookies,
    };
  } catch (e) {
    await sql`DELETE FROM session WHERE token = ${r.token}`;
    throw e;
  }
}

/** Seconde étape : code TOTP (6 chiffres) ou code de secours, sur le défi de `connecter`. */
export async function validerDeuxFacteurs(sql: Sql, defiBrut: string, code: string): Promise<Session> {
  const [defi, tenantId] = String(defiBrut ?? "").split("~");
  if (!defi) throw new ErreurMetier("défi expiré ou inconnu", [], 401);
  const headers = new Headers({ cookie: `${await nomCookie(sql, "two_factor")}=${defi}` });
  const c = String(code ?? "").trim();
  const auth = authDe(sql);
  const { headers: h, response } = await ba(
    /^\d{6}$/.test(c)
      ? auth.api.verifyTOTP({ headers, body: { code: c }, returnHeaders: true })
      : auth.api.verifyBackupCode({ headers, body: { code: c }, returnHeaders: true }),
  );
  const r = response as { token: string; user: { id: string } };
  return {
    userId: r.user.id,
    tenantId: await activer(sql, r.token, r.user.id, tenantId),
    session: r.token,
    cookies: cookiesDe(h),
  };
}

/** Ré-authentification avant une action irréversible (suppression de l'entreprise). */
export async function verifierMotDePasse(sql: Sql, userId: string, motDePasse: string) {
  const [a] = await sql<{ password: string | null }[]>`
    SELECT password FROM account WHERE user_id = ${userId} AND provider_id = 'credential'`;
  const ok =
    a?.password &&
    (await (await authDe(sql).$context).password.verify({ hash: a.password, password: String(motDePasse ?? "") }));
  if (!ok) throw new ErreurMetier("identifiants invalides", [], 401);
}

export async function deconnecter(sql: Sql, headers: Headers): Promise<string[]> {
  const r = await authDe(sql)
    .api.signOut({ headers, returnHeaders: true })
    .catch(() => null);
  return cookiesDe(r?.headers);
}

/** Clé d'API d'entreprise (agent, CLI, MCP, n8n) : renvoyée une seule fois, seul son hash est conservé. */
export async function creerJetonApi(
  sql: Sql,
  auth: Auth,
  nom: string,
  { expireEnSecondes }: { expireEnSecondes?: number } = {},
): Promise<string> {
  exiger(auth, "parametres");
  const k = await ba(
    authDe(sql).api.createApiKey({
      body: {
        name: String(nom || "api").slice(0, 32),
        organizationId: auth.tenantId,
        userId: auth.userId,
        metadata: { userId: auth.userId },
        ...(expireEnSecondes ? { expiresIn: expireEnSecondes } : {}),
      },
    }),
  );
  return k.key;
}

/**
 * Clé d'API courte de l'auteur d'un workflow (nœuds « Action auto ») : expire seule, supprimée par
 * `revoquer()` à la fin de l'exécution. Droits = rôle actuel de l'auteur.
 */
export async function cleTemporaire(sql: Sql, tenantId: string, userId: string, nom: string, minutes = 15) {
  const cle = `auto_${crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true })}`;
  const empreinte = new Bun.CryptoHasher("sha256").update(cle).digest("base64url");
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO apikey (name, start, reference_id, prefix, key, expires_at, metadata)
    VALUES (${nom.slice(0, 64)}, ${cle.slice(0, 10)}, ${tenantId}, 'auto_', ${empreinte},
      now() + ${`${minutes} minutes`}::interval, ${JSON.stringify({ userId })})
    RETURNING id`;
  return { jeton: cle, revoquer: () => sql`DELETE FROM apikey WHERE id = ${r!.id}`.then(() => undefined) };
}

export interface JetonApi {
  id: string;
  nom: string | null;
  /** Premiers caractères (préfixe compris) des clés créées depuis Better Auth ; null pour les reprises. */
  debut: string | null;
  email: string | null;
  creeLe: string;
  expireLe: string | null;
  dernierUsage: string | null;
}

/** Clés d'API de l'entreprise (jamais le secret). */
export async function listerJetons(sql: Sql, auth: Auth): Promise<JetonApi[]> {
  exiger(auth, "parametres");
  const rows = await sql<
    {
      id: string;
      name: string | null;
      start: string | null;
      email: string | null;
      created_at: Date;
      expires_at: Date | null;
      last_request: Date | null;
    }[]
  >`
    SELECT k.id, k.name, k.start, u.email, k.created_at, k.expires_at, k.last_request
    FROM apikey k LEFT JOIN app_user u ON u.id::text = (k.metadata::jsonb ->> 'userId')
    WHERE k.reference_id = ${auth.tenantId} AND (k.expires_at IS NULL OR k.expires_at > now())
    ORDER BY k.created_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    nom: r.name,
    debut: r.start,
    email: r.email,
    creeLe: r.created_at.toISOString(),
    expireLe: r.expires_at?.toISOString() ?? null,
    dernierUsage: r.last_request?.toISOString() ?? null,
  }));
}

export async function revoquerJeton(sql: Sql, auth: Auth, id: string): Promise<void> {
  exiger(auth, "parametres");
  if (!UUID.test(id)) throw new ErreurMetier("jeton introuvable", [], 404);
  const r = await sql`DELETE FROM apikey WHERE id = ${id} AND reference_id = ${auth.tenantId} RETURNING id`;
  if (!r.length) throw new ErreurMetier("jeton introuvable", [], 404);
}

export interface Membre {
  id: string;
  userId: string;
  email: string;
  nom: string;
  role: Role;
  depuis: string;
}

/** Membres de l'entreprise de l'appelant. */
export async function listerMembres(sql: Sql, auth: Auth): Promise<Membre[]> {
  exiger(auth, "membres");
  return (
    await sql<{ id: string; user_id: string; email: string; name: string; role: Role; created_at: Date }[]>`
      SELECT m.id, m.user_id, u.email, u.name, m.role, m.created_at FROM membership m
      JOIN app_user u ON u.id = m.user_id WHERE m.tenant_id = ${auth.tenantId} ORDER BY u.email`
  ).map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.email,
    nom: r.name,
    role: r.role,
    depuis: r.created_at.toISOString(),
  }));
}

/** Ajoute un utilisateur existant ou change son rôle ; un owner ne peut être nommé que par un owner. */
export async function ajouterMembre(sql: Sql, auth: Auth, email: string, role: Role) {
  exiger(auth, "membres");
  if (!estRole(role)) throw new ErreurMetier("rôle invalide");
  if (role === "owner" && auth.role !== "owner") throw new ErreurMetier("seul un owner peut nommer un owner", [], 403);
  const [u] = await sql<{ id: string }[]>`SELECT id FROM app_user WHERE email = ${normaliserEmail(email ?? "")}`;
  if (!u) throw new ErreurMetier("utilisateur inconnu", [], 404);
  const [m] = await sql<{ id: string }[]>`
    SELECT id FROM membership WHERE tenant_id = ${auth.tenantId} AND user_id = ${u.id}`;
  const api = authDe(sql).api;
  if (m)
    await auNomDe(sql, auth, (headers) =>
      ba(api.updateMemberRole({ headers, body: { memberId: m.id, role, organizationId: auth.tenantId } })),
    );
  else await ba(api.addMember({ body: { userId: u.id, role, organizationId: auth.tenantId } }));
}

/** Retire un membre (le dernier owner reste). */
export async function retirerMembre(sql: Sql, auth: Auth, memberId: string) {
  exiger(auth, "membres");
  if (!UUID.test(memberId)) throw new ErreurMetier("membre introuvable", [], 404);
  await auNomDe(sql, auth, (headers) =>
    ba(authDe(sql).api.removeMember({ headers, body: { memberIdOrEmail: memberId, organizationId: auth.tenantId } })),
  );
}

export interface Entreprise {
  id: string;
  nom: string;
  siren: string;
  siret: string;
  adresse: string;
  tvaIntracom: string | null;
  franchiseTva: boolean;
}

export async function entreprise(sql: Sql, tenantId: string): Promise<Entreprise> {
  const [t] = await sql<
    {
      id: string;
      nom: string;
      siren: string;
      siret: string;
      adresse: string;
      tva_intracom: string | null;
      franchise_tva: boolean;
    }[]
  >`SELECT id, nom, siren, siret, adresse, tva_intracom, franchise_tva FROM tenant WHERE id = ${tenantId}`;
  if (!t) throw new ErreurMetier("entreprise introuvable", [], 404);
  return {
    id: t.id,
    nom: t.nom,
    siren: t.siren,
    siret: t.siret,
    adresse: t.adresse,
    tvaIntracom: t.tva_intracom,
    franchiseTva: t.franchise_tva,
  };
}

/** Entreprises de l'utilisateur (choix d'entreprise). */
export async function entreprisesDe(sql: Sql, userId: string) {
  return (
    await sql<{ id: string; nom: string; siren: string; role: Role; suspendu_at: Date | null }[]>`
      SELECT t.id, t.nom, t.siren, m.role, t.suspendu_at FROM membership m JOIN tenant t ON t.id = m.tenant_id
      WHERE m.user_id = ${userId} ORDER BY m.created_at, t.nom`
  ).map((r) => ({ id: r.id, nom: r.nom, siren: r.siren, role: r.role, suspendue: !!r.suspendu_at }));
}

export interface FicheSirene {
  siren: string;
  nom: string;
  siretSiege: string;
  adresse: string;
  codePostal: string | null;
  commune: string | null;
  /** Code NAF/APE (ex. 62.01Z). */
  naf: string | null;
  natureJuridique: string | null;
  dateCreation: string | null;
  /** Unité légale active (état administratif « A ») ; une entreprise cessée ne s'inscrit pas. */
  active: boolean;
  /** Numéro de TVA calculé depuis le SIREN (clé FR) ; à confirmer par l'entreprise (VIES). */
  tvaIntracom: string;
}

interface ResultatAnnuaire {
  siren: string;
  nom_complet: string;
  nom_raison_sociale?: string | null;
  nature_juridique?: string | null;
  activite_principale?: string | null;
  etat_administratif?: string | null;
  date_creation?: string | null;
  siege: {
    siret: string;
    adresse: string;
    code_postal?: string | null;
    libelle_commune?: string | null;
    activite_principale?: string | null;
  };
}

/**
 * Préremplissage depuis l'annuaire public des entreprises (recherche-entreprises.api.gouv.fr, données
 * Sirene de l'INSEE, sans clé). Accepte un SIREN ou un SIRET ; `null` si l'unité légale est inconnue.
 */
export async function rechercherSiren(identifiant: string, fetcher: typeof fetch = fetch): Promise<FicheSirene | null> {
  const id = String(identifiant ?? "").replace(/\s/g, "");
  const siren = id.length === 14 && siretValide(id) ? id.slice(0, 9) : id;
  if (!sirenValide(siren)) throw new ErreurMetier("siren invalide");
  let res: Response;
  try {
    res = await fetcher(`https://recherche-entreprises.api.gouv.fr/search?q=${siren}&page=1&per_page=1`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ErreurMetier("annuaire injoignable", [], 502);
  }
  if (!res.ok) throw new ErreurMetier(`annuaire indisponible (${res.status})`, [], 502);
  const body = (await res.json()) as { results?: ResultatAnnuaire[] };
  const r = body.results?.find((x) => x.siren === siren);
  if (!r) return null;
  return {
    siren: r.siren,
    nom: r.nom_raison_sociale || r.nom_complet,
    siretSiege: r.siege.siret,
    adresse: r.siege.adresse,
    codePostal: r.siege.code_postal ?? null,
    commune: r.siege.libelle_commune ?? null,
    naf: r.activite_principale ?? r.siege.activite_principale ?? null,
    natureJuridique: r.nature_juridique ?? null,
    dateCreation: r.date_creation ?? null,
    active: (r.etat_administratif ?? "A") === "A",
    tvaIntracom: tvaIntracomFr(r.siren),
  };
}
export * from "./super-admin";
export * from "./reseau-admin";

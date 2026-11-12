// Serveur Better Auth d'auto : comptes, sessions, entreprises (plugin organization = tenant), 2FA,
// passkeys, clés d'API, lien magique, console opérateur (admin), OAuth 2.1 pour les clients MCP.
//
// Base : la base Postgres de l'application par `Bun.SQL` (dialecte Kysely maison, kysely-bun.ts) ; les
// identifiants camelCase de Better Auth deviennent des colonnes snake_case (CamelCasePlugin). Les tables
// historiques sont reprises telles quelles : user = app_user, organization = tenant, member = membership,
// invitation = invitation. Le schéma est versionné dans packages/store/migrations (020_better_auth.sql) :
// aucune migration automatique de Better Auth.
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { journaliser, type Sql } from "@auto/store";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import {
  admin,
  bearer,
  jwt,
  magicLink,
  openAPI,
  organization,
  twoFactor,
  deviceAuthorization,
} from "better-auth/plugins";
import { setSessionCookie } from "better-auth/cookies";
import { CamelCasePlugin, Kysely } from "kysely";
import { sociaux } from "./fournisseurs";
import { cleMaitre } from "./chiffrement";
import { ac, roles } from "./droits";
import { DialecteBunSql } from "./kysely-bun";
import { reprendreDeuxFacteurs } from "./legacy";
import { envoyerMail } from "./mail";
import { synchroniserOperateurs } from "./operateurs";

export const SESSION_JOURS = 30;
export const INVITATION_JOURS = 7;
export const CHEMIN_AUTH = "/api/auth";

/** Piste d'audit du tenant (sans email : l'audit est immuable). */
async function auditer(sql: Sql, tenantId: string, actor: string | null, action: string, ref: string, payload = {}) {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
    await journaliser(tx, actor, action, ref, payload);
  });
}

export interface OptionsAuth {
  /** Origine publique (`BETTER_AUTH_URL`, sinon `AUTO_URL_APP`) : cookies, liens des mails, émetteur OAuth. */
  baseURL?: string;
  /** Secret de signature (`BETTER_AUTH_SECRET`) ; par défaut dérivé de la clé maître d'auto. */
  secret?: string;
  /** Limitation de débit des routes d'authentification ; active par défaut en production. */
  limiteDebit?: boolean;
  env?: Record<string, string | undefined>;
  /** Contrôle du schéma au démarrage (tables et colonnes attendues) ; désactivé pour générer la doc hors base. */
  validerSchema?: boolean;
}

/** Secret Better Auth dérivé de `AUTO_CLE_MAITRE` (HMAC-SHA256) : un seul secret à garder au coffre. */
export function secretDerive(env = Bun.env) {
  return new Bun.CryptoHasher("sha256", cleMaitre(env)).update("auto/better-auth/v1").digest("hex");
}

export function urlPublique(env: Record<string, string | undefined> = Bun.env) {
  return (env.BETTER_AUTH_URL ?? env.AUTO_URL_APP ?? env.AUTO_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Fournisseurs de connexion sociale configurés (affichés par le front). */
export const fournisseursSociaux = (env = Bun.env) => Object.keys(sociaux(env) ?? {});

export function creerAuth(sql: Sql, o: OptionsAuth = {}) {
  const env = o.env ?? Bun.env;
  const baseURL = (o.baseURL ?? urlPublique(env)).replace(/\/+$/, "");
  const prod = env.NODE_ENV === "production";
  const https = baseURL.startsWith("https://");
  const app = `${baseURL}/app`;
  const db = new Kysely({ dialect: new DialecteBunSql(sql), plugins: [new CamelCasePlugin()] });

  return betterAuth({
    appName: "auto",
    baseURL,
    basePath: CHEMIN_AUTH,
    secret: o.secret ?? env.BETTER_AUTH_SECRET ?? secretDerive(env),
    database: { db, type: "postgres", transaction: true },
    // Production : l'origine publique et AUTO_ORIGINES_CONFIANCE. Hors production, toute origine locale
    // (front de développement, bancs de test sur des ports aléatoires).
    trustedOrigins: [
      baseURL,
      ...(env.AUTO_ORIGINES_CONFIANCE?.split(",").map((s) => s.trim()) ?? []),
      ...(prod ? [] : ["http://localhost:*", "http://127.0.0.1:*"]),
    ],
    telemetry: { enabled: false },
    logger: {
      disabled: env.NODE_ENV === "test",
      level: "warn",
      // Une clé invalide est une réponse 401 ordinaire, pas une erreur du serveur.
      log: (niveau, message, ...args) => {
        if (message.includes("Failed to validate API key")) return;
        (niveau === "error" ? console.error : console.warn)(`[auth] ${message}`, ...args);
      },
    },
    advanced: {
      database: { generateId: "uuid", validateSchema: o.validerSchema ?? true },
      cookiePrefix: "auto",
      useSecureCookies: https,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: https },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    user: {
      modelName: "app_user",
      changeEmail: { enabled: true },
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: SESSION_JOURS * 86400,
      updateAge: 86400,
      // Pas de cache de session en cookie : rôle, suspension et révocation s'appliquent à la requête suivante.
      cookieCache: { enabled: false },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      // Hachages historiques `Bun.password` (argon2id) repris tels quels ; les nouveaux aussi.
      password: {
        hash: (mdp) => Bun.password.hash(mdp),
        verify: ({ hash, password }) => Bun.password.verify(password, hash).catch(() => false),
      },
      sendResetPassword: async ({ user, url }) =>
        envoyerMail({
          a: user.email,
          sujet: "Réinitialiser votre mot de passe auto",
          texte: `Pour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n${url}`,
          modele: "reinitialisation",
          donnees: { lien: url },
        }),
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) =>
        envoyerMail({
          a: user.email,
          sujet: "Confirmez votre adresse sur auto",
          texte: `Pour confirmer votre adresse, ouvrez ce lien :\n${url}`,
          modele: "verification",
          donnees: { lien: url },
        }),
    },
    socialProviders: sociaux(env),
    rateLimit: {
      enabled: o.limiteDebit ?? prod,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/sign-in/magic-link": { window: 60, max: 3 },
        "/two-factor/*": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/organization/invite-member": { window: 60, max: 10 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Entreprise active (= tenant de la session) : la première, par ancienneté d'adhésion.
          before: async (s) => {
            if ((s as { activeOrganizationId?: string | null }).activeOrganizationId) return;
            const [m] = await sql<{ tenant_id: string }[]>`
              SELECT tenant_id FROM membership WHERE user_id = ${s.userId} ORDER BY created_at, tenant_id LIMIT 1`;
            return { data: { ...s, activeOrganizationId: m?.tenant_id ?? null } };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => reprendreDeuxFacteurs(ctx, sql)),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/device/token" && ctx.context.newSession) await setSessionCookie(ctx, ctx.context.newSession);
      }),
    },
    plugins: [
      ...(env.AUTO_CONNEXION_APPAREIL === "1"
        ? [
            deviceAuthorization({
              expiresIn: "10m",
              interval: "5s",
              verificationUri: `${baseURL}/app/verification-appareil`,
              validateClient: (client) => client === "auto-native",
              onDeviceAuthRequest: async () => {
                await sql`DELETE FROM device_code WHERE expires_at<now()`;
              },
            }),
          ]
        : []),
      organization({
        ac,
        roles,
        creatorRole: "owner",
        invitationExpiresIn: INVITATION_JOURS * 86400,
        cancelPendingInvitationsOnReInvite: true,
        // Les entreprises se créent par l'inscription (SIRET contrôlé) : /v1/auth/inscription.
        allowUserToCreateOrganization: true,
        sendInvitationEmail: async ({ id, email, role, organization: org }) => {
          const lien = `${app}/invitation?id=${id}`;
          await envoyerMail({
            a: email,
            sujet: `Invitation à rejoindre ${org.name} sur auto`,
            texte: `Vous êtes invité à rejoindre ${org.name} (rôle ${role}).\nLien valable ${INVITATION_JOURS} jours, à usage unique :\n${lien}`,
            modele: "invitation",
            donnees: { entreprise: org.name, role, lien, jeton: id },
          });
        },
        organizationHooks: {
          afterCreateInvitation: async ({ invitation: i, inviter }) =>
            auditer(sql, i.organizationId, inviter.id, "invitation.creer", i.id, { role: i.role }),
          afterAcceptInvitation: async ({ invitation: i, user }) => {
            await sql`UPDATE invitation SET acceptee_at = now(), acceptee_par = ${user.id} WHERE id = ${i.id}`;
            await auditer(sql, i.organizationId, user.id, "invitation.accepter", i.id, { role: i.role });
          },
          afterCancelInvitation: async ({ invitation: i, cancelledBy }) => {
            await sql`UPDATE invitation SET revoquee_at = now() WHERE id = ${i.id} AND acceptee_at IS NULL`;
            await auditer(sql, i.organizationId, cancelledBy.id, "invitation.revoquer", i.id);
          },
          afterAddMember: async () => synchroniserOperateurs(sql),
          afterUpdateMemberRole: async ({ member: m, previousRole }) => {
            await auditer(sql, m.organizationId, null, "membre.role", m.id, { avant: previousRole, apres: m.role });
            await synchroniserOperateurs(sql);
          },
          afterRemoveMember: async ({ member: m }) => {
            await auditer(sql, m.organizationId, null, "membre.retirer", m.id);
            await synchroniserOperateurs(sql);
          },
        },
        schema: {
          organization: {
            modelName: "tenant",
            fields: { name: "nom" },
            additionalFields: {
              siren: { type: "string", required: true, input: true },
              siret: { type: "string", required: true, input: true },
              adresse: { type: "string", required: true, input: true },
              tvaIntracom: { type: "string", required: false, input: true },
              franchiseTva: { type: "boolean", required: false, defaultValue: false, input: true },
            },
          },
          member: { modelName: "membership", fields: { organizationId: "tenantId" } },
          invitation: {
            modelName: "invitation",
            fields: { organizationId: "tenantId", inviterId: "invitePar" },
          },
        },
      }),
      twoFactor({
        issuer: "auto",
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
      }),
      passkey({ rpID: new URL(baseURL).hostname, rpName: "auto", origin: baseURL }),
      apiKey({
        // Clé d'entreprise (référence = tenant) ; l'auteur est gardé dans les métadonnées.
        references: "organization",
        defaultPrefix: "auto_",
        enableMetadata: true,
        // Débit des clés : celui de l'API (quotas du plan), pas la limite par défaut du plugin (10/jour).
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: null, minExpiresIn: 0, maxExpiresIn: 3650 },
      }),
      bearer(),
      admin({ defaultRole: "user", adminRoles: ["admin"], impersonationSessionDuration: 3600 }),
      magicLink({
        expiresIn: 600,
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) =>
          envoyerMail({
            a: email,
            sujet: "Votre lien de connexion à auto",
            texte: `Pour vous connecter, ouvrez ce lien (valable 10 minutes, à usage unique) :\n${url}`,
            modele: "lien-magique",
            donnees: { lien: url },
          }),
      }),
      openAPI({ disableDefaultReference: true }),
      jwt(),
      mcp({
        loginPage: `${app}/connexion`,
        consentPage: `${app}/autorisation`,
        resource: `${baseURL}/mcp`,
        // Claude Code et les autres clients s'inscrivent seuls (RFC 7591) ou par document CIMD.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        postLogin: {
          page: `${app}/autorisation`,
          // Le consentement et le jeton sont liés à l'entreprise active de la session.
          consentReferenceId: ({ session }) =>
            (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? undefined,
          shouldRedirect: ({ session }) => !(session as { activeOrganizationId?: string | null }).activeOrganizationId,
        },
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { auto_tenant: referenceId } : {}),
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });
}

export type AuthAuto = ReturnType<typeof creerAuth>;

const instances = new WeakMap<Sql, AuthAuto>();

/** Instance Better Auth d'une base : créée une fois (ou fournie par `enregistrerAuth`). */
export function authDe(sql: Sql): AuthAuto {
  let a = instances.get(sql);
  if (!a) instances.set(sql, (a = creerAuth(sql)));
  return a;
}

export function enregistrerAuth(sql: Sql, a: AuthAuto) {
  instances.set(sql, a);
  return a;
}

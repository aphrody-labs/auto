// Better Auth 1.7 + RBAC + API keys + MCP OAuth + company isolation on unified SQLite (`001_global.sql`).
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { frVatNumber, validSiren, validSiret } from "@aphrody/auto-domain";
import type { Sql } from "@aphrody/auto-platform";
import { t, type Locale } from "@aphrody/auto-i18n";
import { betterAuth } from "better-auth";
import {
  admin,
  bearer,
  deviceAuthorization,
  jwt,
  magicLink,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { CamelCasePlugin, Kysely } from "kysely";
import { asBool, asJson, nowIso, StoreError, uid } from "../sqlite";
import { PlatformSqliteDialect } from "./kysely-sqlite";
import { ac, can, isRole, roles, segmentAllowed, type Action, type Role, type Segment } from "./permissions";

export * from "./crypto";
export * from "./permissions";
export * from "./totp";

export interface Caller {
  userId: string;
  companyId: string;
  role: Role;
  segments?: Segment[];
}

export interface AuthMailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

let activeMailer: AuthMailer = {
  async send() {},
};

export function setAuthMailer(mailer: AuthMailer): void {
  activeMailer = mailer;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validEmail(raw: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(raw));
}

export interface CreateAuthOptions {
  baseURL?: string;
  secret?: string;
  env?: Record<string, string | undefined>;
}

export function resolvePublicUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.BETTER_AUTH_URL ?? env.AUTO_URL_APP ?? env.AUTO_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function buildSocialProviders(env: Record<string, string | undefined>) {
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.AUTO_GOOGLE_CLIENT_ID && env.AUTO_GOOGLE_CLIENT_SECRET) {
    social.google = { clientId: env.AUTO_GOOGLE_CLIENT_ID, clientSecret: env.AUTO_GOOGLE_CLIENT_SECRET };
  }
  if (env.AUTO_GITHUB_CLIENT_ID && env.AUTO_GITHUB_CLIENT_SECRET) {
    social.github = { clientId: env.AUTO_GITHUB_CLIENT_ID, clientSecret: env.AUTO_GITHUB_CLIENT_SECRET };
  }
  return Object.keys(social).length ? social : undefined;
}

export function configuredSocialProviders(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(buildSocialProviders(env) ?? {});
}

export function createAuth(sql: Sql, opts: CreateAuthOptions = {}) {
  const env = opts.env ?? process.env;
  const baseURL = (opts.baseURL ?? resolvePublicUrl(env)).replace(/\/+$/, "");
  const isProd = env.NODE_ENV === "production";
  const secret =
    opts.secret ?? env.BETTER_AUTH_SECRET ?? env.AUTO_MASTER_KEY ?? "auto-dev-better-auth-secret-32chars!!";

  const db = new Kysely({
    dialect: new PlatformSqliteDialect(sql),
    plugins: [new CamelCasePlugin()],
  });

  return betterAuth({
    appName: "auto",
    baseURL,
    basePath: "/api/auth",
    secret,
    database: { db, type: "sqlite", transaction: false },
    trustedOrigins: (request) => {
      const configured = [
        baseURL,
        ...(env.AUTO_TRUSTED_ORIGINS?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? []),
        ...(isProd ? [] : ["http://localhost:*", "http://127.0.0.1:*"]),
      ];
      if (request) {
        try {
          configured.push(new URL(request.url).origin);
        } catch {}
      }
      return configured;
    },
    telemetry: { enabled: false },
    user: { modelName: "app_user" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    socialProviders: buildSocialProviders(env),
    plugins: [
      bearer(),
      twoFactor({ issuer: "Auto" }),
      passkey({ rpID: new URL(baseURL).hostname, rpName: "Auto" }),
      magicLink({
        async sendMagicLink({ email, url }: { email: string; url: string }) {
          await activeMailer.send({
            to: email,
            subject: "Your Auto sign-in link",
            text: `Open this link to sign in to Auto:\n${url}\n`,
          });
        },
      }),
      organization({
        ac,
        roles,
        schema: {
          organization: { modelName: "company" },
          member: { modelName: "membership", fields: { organizationId: "company_id" } },
          invitation: { modelName: "invitation" },
        },
      }),
      apiKey({ defaultPrefix: "auto_" }),
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
      openAPI(),
      admin({
        defaultRole: "user",
        adminRoles: ["admin", "superadmin"],
        roles: { user: ac.newRole({}), admin: roles.admin, superadmin: roles.owner },
      }),
      deviceAuthorization(),
      mcp({ loginPage: `${baseURL}/app/login`, consentPage: `${baseURL}/app/consent`, resource: `${baseURL}/mcp` }),
    ],
  });
}

export type AutoAuth = ReturnType<typeof createAuth>;

const jwksCache = new WeakMap<object, { keySet: ReturnType<typeof createLocalJWKSet>; readAt: number }>();

export async function verifyMcpAccessToken(auth: AutoAuth, token: string) {
  const ctx = await auth.$context;
  let cached = jwksCache.get(auth);
  if (!cached || Date.now() - cached.readAt > 300_000) {
    const keys = (await auth.api.getJwks()) as JSONWebKeySet;
    cached = { keySet: createLocalJWKSet(keys), readAt: Date.now() };
    jwksCache.set(auth, cached);
  }
  const origin = new URL(ctx.baseURL).origin;
  const { payload } = await jwtVerify(token, cached.keySet, { issuer: ctx.baseURL, audience: `${origin}/mcp` });
  return payload;
}

export async function resolveCaller(
  sql: Sql,
  userId: string,
  companyId: string | null | undefined,
): Promise<Caller | null> {
  if (!companyId) return null;
  const [row] = await sql<{ role: string; segments: string | null }[]>`
    SELECT m.role, m.segments FROM membership m
    JOIN company c ON c.id = m.company_id AND c.suspended_at IS NULL AND c.deleted_at IS NULL
    JOIN app_user u ON u.id = m.user_id AND (u.banned = 0 OR (u.ban_expires IS NOT NULL AND u.ban_expires < ${nowIso()}))
    WHERE m.user_id = ${userId} AND m.company_id = ${companyId}`;
  if (!row || !isRole(row.role)) return null;
  const segments = row.segments ? asJson<Segment[]>(row.segments) : undefined;
  return { userId, companyId, role: row.role, ...(segments?.length ? { segments } : {}) };
}

export function requireAction(caller: Caller, action: Action, locale: Locale = "en"): void {
  if (!can(caller.role, action)) {
    throw new StoreError(t(locale, "Insufficient permissions"), [], 403);
  }
}

export function requireSegment(caller: Caller, req: Request, locale: Locale = "en"): void {
  if (!segmentAllowed(caller.segments, new URL(req.url).pathname, req.method)) {
    throw new StoreError(t(locale, "Access restricted for this workspace segment"), [], 403);
  }
}

export async function authenticateRequest(
  sql: Sql,
  auth: AutoAuth,
  req: Request,
): Promise<{ caller: Caller; authMethod: "session" | "api_key" | "oauth" } | null> {
  const authHeader = req.headers.get("authorization");
  const apiKeyHeader = req.headers.get("x-api-key");
  const rawToken = apiKeyHeader?.trim() || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null);

  if (rawToken?.startsWith("auto_")) {
    const res = await auth.api.verifyApiKey({ body: { key: rawToken } }).catch(() => null);
    if (!res?.valid || !res.key) return null;
    const userId = (res.key.metadata as { userId?: string } | null)?.userId ?? res.key.referenceId;
    const companyId = req.headers.get("x-company-id") ?? res.key.referenceId;
    const caller = await resolveCaller(sql, userId, companyId);
    return caller ? { caller, authMethod: "api_key" } : null;
  }

  if (rawToken && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(rawToken)) {
    const payload = await verifyMcpAccessToken(auth, rawToken).catch(() => null);
    if (payload?.sub) {
      const companyId = req.headers.get("x-company-id") ?? (payload.auto_company as string | undefined);
      const caller = await resolveCaller(sql, payload.sub, companyId);
      if (caller) return { caller, authMethod: "oauth" };
    }
  }

  const sess = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!sess?.user?.id) return null;
  const companyId =
    req.headers.get("x-company-id") ??
    (sess.session as { activeOrganizationId?: string | null }).activeOrganizationId ??
    (await defaultCompanyForUser(sql, sess.user.id));
  const caller = await resolveCaller(sql, sess.user.id, companyId);
  return caller ? { caller, authMethod: "session" } : null;
}

export async function defaultCompanyForUser(sql: Sql, userId: string): Promise<string | null> {
  const [row] = await sql<{ company_id: string }[]>`
    SELECT m.company_id FROM membership m
    JOIN company c ON c.id = m.company_id AND c.deleted_at IS NULL
    WHERE m.user_id = ${userId} ORDER BY m.created_at ASC LIMIT 1`;
  return row?.company_id ?? null;
}

export interface CreateCompanyInput {
  name: string;
  taxId: string;
  address: string;
  vatNumber?: string;
  vatExempt?: boolean;
}

function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "company"}-${uid().slice(0, 6)}`;
}

export async function createCompanyWithOwner(
  sql: Sql,
  ownerUserId: string,
  input: CreateCompanyInput,
  locale: Locale = "en",
): Promise<{ id: string; slug: string; siren: string; siret: string; vatNumber: string | null }> {
  const cleanTax = (input.taxId ?? "").replace(/\s/g, "");
  if (!validSiret(cleanTax) && !validSiren(cleanTax)) {
    throw new StoreError(t(locale, "Invalid tax ID (9-digit SIREN or 14-digit SIRET expected)"), [], 400);
  }
  const siren = cleanTax.slice(0, 9);
  const siret = cleanTax.length === 14 ? cleanTax : `${siren}00001`;
  const vatNumber = input.vatExempt ? null : input.vatNumber?.trim() || frVatNumber(siren);
  const id = uid();
  const slug = slugify(input.name);
  await sql`
    INSERT INTO company (id, name, siren, siret, address, vat_number, vat_exempt, slug)
    VALUES (${id}, ${input.name.trim()}, ${siren}, ${siret}, ${input.address.trim()}, ${vatNumber}, ${input.vatExempt ? 1 : 0}, ${slug})`;
  await sql`
    INSERT INTO membership (id, company_id, user_id, role)
    VALUES (${uid()}, ${id}, ${ownerUserId}, ${"owner"})`;
  await sql`UPDATE session SET active_organization_id = ${id} WHERE user_id = ${ownerUserId} AND active_organization_id IS NULL`;
  return { id, slug, siren, siret, vatNumber };
}

export async function listUserCompanies(sql: Sql, userId: string) {
  const rows = await sql<
    {
      id: string;
      name: string;
      siren: string;
      siret: string;
      address: string;
      vat_number: string | null;
      vat_exempt: number;
      plan: string;
      role: Role;
      suspended_at: string | null;
    }[]
  >`
    SELECT c.id, c.name, c.siren, c.siret, c.address, c.vat_number, c.vat_exempt, c.plan, m.role, c.suspended_at
    FROM membership m
    JOIN company c ON c.id = m.company_id AND c.deleted_at IS NULL
    WHERE m.user_id = ${userId}
    ORDER BY c.created_at ASC`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    siren: r.siren,
    siret: r.siret,
    address: r.address,
    vatNumber: r.vat_number ?? undefined,
    vatExempt: asBool(r.vat_exempt),
    plan: r.plan,
    role: r.role,
    suspended: Boolean(r.suspended_at),
  }));
}

export async function syncBootstrapAdmins(sql: Sql, emailsRaw = process.env.AUTO_ADMIN_EMAILS ?? ""): Promise<number> {
  const emails = emailsRaw
    .split(",")
    .map(normalizeEmail)
    .filter((e) => e && validEmail(e));
  if (!emails.length) return 0;
  let promoted = 0;
  for (const email of emails) {
    const [u] = await sql<
      { id: string; role: string | null }[]
    >`SELECT id, role FROM app_user WHERE lower(email) = ${email}`;
    if (u && u.role !== "superadmin") {
      await sql`UPDATE app_user SET role = ${"superadmin"} WHERE id = ${u.id}`;
      promoted++;
    }
  }
  return promoted;
}

export async function recordOperatorAudit(
  sql: Sql,
  actorUserId: string,
  action: string,
  targetCompanyId: string | null,
  reason: string | null = null,
): Promise<void> {
  await sql`
    INSERT INTO operator_audit (actor_user_id, target_company_id, action, reason)
    VALUES (${actorUserId}, ${targetCompanyId}, ${action}, ${reason})`;
}

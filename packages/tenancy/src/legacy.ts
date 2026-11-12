// Reprise de la double authentification de l'ancienne couche comptes (avant Better Auth).
//
// Better Auth dérive la clé HMAC du TOTP des octets UTF-8 d'un secret texte : les anciens secrets
// (20 octets aléatoires, chiffrés par la clé maître) ne s'y expriment pas. La migration écrit donc dans
// `two_factor.secret` le texte `legacy:<base32>` (chiffré par Better Auth), et ce crochet, avant
// `/two-factor/verify-totp`, vérifie le code sur l'ancien secret puis le remplace par le code que Better
// Auth attend pour ce texte. Les applications d'authentification déjà enrôlées continuent de servir.
//
// Codes de secours : seul leur SHA-256 était gardé. La migration place dans Better Auth un code sentinelle
// `legacy-<16 premiers caractères du hash>` par code non utilisé ; le crochet, avant
// `/two-factor/verify-backup-code`, reconnaît l'ancien code et le remplace par sa sentinelle.
import type { Sql } from "@auto/store";
import { createOTP } from "@better-auth/utils/otp";
import { getSessionFromCtx } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { AuthAuto } from "./auth";
import { dechiffrer } from "./chiffrement";
import { hash } from "./commun";
import { base32, depuisBase32, verifierTotp } from "./totp";

const PREFIXE = "legacy:";

// Contexte d'un point d'accès Better Auth, réduit à ce que le crochet lit.
interface Ctx {
  path?: string;
  body?: Record<string, unknown>;
  context: {
    secret: string;
    secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"];
    createAuthCookie: (nom: string) => { name: string };
    internalAdapter: { findVerificationValue: (id: string) => Promise<{ value: string } | null> };
    adapter: {
      findOne: <T>(q: { model: string; where: { field: string; value: string }[] }) => Promise<T | null>;
    };
  };
  getSignedCookie: (nom: string, secret: string) => Promise<string | null>;
}

/** Utilisateur de la session, sinon du défi 2FA en cours (cookie signé `two_factor`), comme Better Auth. */
async function utilisateur(ctx: Ctx): Promise<string | null> {
  const s = await getSessionFromCtx(ctx as never).catch(() => null);
  if (s) return s.user.id;
  const c = await ctx.getSignedCookie(ctx.context.createAuthCookie("two_factor").name, ctx.context.secret);
  return c ? ((await ctx.context.internalAdapter.findVerificationValue(c))?.value ?? null) : null;
}

export async function reprendreDeuxFacteurs(c: unknown, sql: Sql) {
  const ctx = c as Ctx;
  const totpVoulu = ctx.path === "/two-factor/verify-totp";
  if (!totpVoulu && ctx.path !== "/two-factor/verify-backup-code") return;
  const code = String(ctx.body?.code ?? "");
  const userId = await utilisateur(ctx);
  if (!userId) return;
  if (totpVoulu) {
    const tf = await ctx.context.adapter.findOne<{ secret: string }>({
      model: "twoFactor",
      where: [{ field: "userId", value: userId }],
    });
    if (!tf) return;
    const secret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: tf.secret });
    if (!secret.startsWith(PREFIXE)) return;
    if ((await verifierTotp(depuisBase32(secret.slice(PREFIXE.length)), code)) === null) return;
    return { context: { ...ctx, body: { ...ctx.body, code: await createOTP(secret).totp() } } };
  }
  const propre = code.trim().toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z2-7]{10}$/.test(propre)) return;
  const h = hash(propre);
  const r = await sql`UPDATE code_secours SET utilise_at = now()
    WHERE user_id = ${userId} AND hash = ${h} AND utilise_at IS NULL RETURNING user_id`;
  if (!r.length) return;
  return { context: { ...ctx, body: { ...ctx.body, code: sentinelle(h) } } };
}

const sentinelle = (h: string) => `legacy-${h.slice(0, 16)}`;

/**
 * Migration idempotente des secrets TOTP actifs et des codes de secours non utilisés vers `two_factor`.
 * Lancée au démarrage de l'API (après les migrations SQL) et par `bun scripts/migrer-auth.ts`.
 */
export async function migrerDeuxFacteurs(sql: Sql, auth: AuthAuto): Promise<number> {
  const { secretConfig } = await auth.$context;
  const aMigrer = await sql<{ id: string; totp_secret: Uint8Array }[]>`
    SELECT u.id, u.totp_secret FROM app_user u
    WHERE u.totp_actif AND u.totp_secret IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id)`;
  for (const u of aMigrer) {
    const brut = await dechiffrer(`totp:${u.id}`, new Uint8Array(u.totp_secret));
    const codes = await sql<{ hash: string }[]>`
      SELECT hash FROM code_secours WHERE user_id = ${u.id} AND utilise_at IS NULL`;
    const secret = await symmetricEncrypt({ key: secretConfig, data: `${PREFIXE}${base32(brut)}` });
    const secours = await symmetricEncrypt({
      key: secretConfig,
      data: JSON.stringify(codes.map((c) => sentinelle(c.hash))),
    });
    await sql.begin(async (tx) => {
      await tx`INSERT INTO two_factor (id, user_id, secret, backup_codes, verified)
        VALUES (gen_random_uuid(), ${u.id}, ${secret}, ${secours}, true) ON CONFLICT DO NOTHING`;
      await tx`UPDATE app_user SET two_factor_enabled = true WHERE id = ${u.id}`;
    });
  }
  return aMigrer.length;
}

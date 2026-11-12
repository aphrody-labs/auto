import type { Sql } from "@auto/store";
import type { AuthAuto } from "./auth";
import { ipAdministration } from "./reseau-admin";
export const estSuperAdmin = (email: string, verifie: boolean, role?: string | null) =>
  verifie &&
  role === "admin" &&
  (Bun.env.AUTO_SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(email.toLowerCase());
export async function humainSuperAdmin(ba: AuthAuto, req: Request) {
  if (!ipAdministration(req).autorise) return null;
  const s = await ba.api.getSession({ headers: req.headers, query: { disableRefresh: true } });
  return s && estSuperAdmin(s.user.email, s.user.emailVerified, (s.user as { role?: string | null }).role) ? s : null;
}
export async function agentAdministrateur(sql: Sql, req: Request) {
  const token = req.headers.get("authorization")?.match(/^Bearer (auto_agent_[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return null;
  const empreinte = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  const [a] =
    await sql`SELECT a.id,a.proprietaire_id,u.email,u.email_verified,u.role FROM agent_admin a JOIN app_user u ON u.id=a.proprietaire_id WHERE a.empreinte=${empreinte} AND a.actif AND a.expire_at>now() AND NOT coalesce(u.banned,false)`;
  if (!a || !estSuperAdmin(a.email, a.email_verified, a.role)) return null;
  await sql`UPDATE agent_admin SET dernier_acces=now() WHERE id=${a.id}`;
  return { id: String(a.id), proprietaireId: String(a.proprietaire_id) };
}

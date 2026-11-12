import type { Sql } from "@auto/store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Console opérateur (plugin admin) : rôle global `admin` pour les owner et admin du tenant opérateur
 * (`AUTO_TENANT_OPERATEUR`), retiré aux autres. Lancée au démarrage de l'API.
 */
export async function synchroniserOperateurs(sql: Sql, operateur = Bun.env.AUTO_TENANT_OPERATEUR) {
  const superAdmins = (Bun.env.AUTO_SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if ((!operateur || !UUID.test(operateur)) && !superAdmins.length) return;
  const tenant = operateur && UUID.test(operateur) ? operateur : null;
  const administrateurs = JSON.stringify(superAdmins);
  await sql`UPDATE app_user u SET role = CASE WHEN (u.email_verified AND lower(u.email) IN (SELECT jsonb_array_elements_text(${administrateurs}::text::jsonb))) OR EXISTS (
      SELECT 1 FROM membership m WHERE m.user_id = u.id AND m.tenant_id = ${tenant}::uuid AND m.role IN ('owner', 'admin')
    ) THEN 'admin' ELSE 'user' END
    WHERE u.role IS DISTINCT FROM (CASE WHEN (u.email_verified AND lower(u.email) IN (SELECT jsonb_array_elements_text(${administrateurs}::text::jsonb))) OR EXISTS (
      SELECT 1 FROM membership m WHERE m.user_id = u.id AND m.tenant_id = ${tenant}::uuid AND m.role IN ('owner', 'admin')
    ) THEN 'admin' ELSE 'user' END)`;
}

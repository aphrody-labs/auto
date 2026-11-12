import { humainSuperAdmin, ipAdministration } from "@auto/tenancy";
import { ErreurMetier } from "@auto/store";
import type { Module, Chemins } from "../modules";
import type { BunRequest } from "bun";
export const routes: Module = ({ sql, ba, pub }) => {
  const humain = <R extends Request>(fn: (req: R, user: string) => Promise<Response>) =>
    pub(async (req: R) => {
      if (req.method !== "GET" && !req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return Response.json({ erreur: "JSON requis" }, { status: 415 });
      const s = await humainSuperAdmin(ba, req);
      if (!s) return Response.json({ erreur: "Super-administrateur humain requis" }, { status: 403 });
      return fn(req, s.user.id);
    });
  return {
    "/v1/admin/moi": {
      GET: humain(async (req, user) =>
        Response.json({ userId: user, role: "super_admin", agentsNominatifs: true, reseau: ipAdministration(req) }),
      ),
    },
    "/v1/admin/agents": {
      GET: humain(async (_req, user) =>
        Response.json(
          await sql`SELECT id,nom,actif,expire_at,dernier_acces,created_at FROM agent_admin WHERE proprietaire_id=${user} ORDER BY created_at DESC`,
        ),
      ),
      POST: humain(async (req, user) => {
        const b = (await req.json()) as { nom?: string };
        if (typeof b.nom !== "string" || !b.nom.trim() || b.nom.length > 100)
          throw new ErreurMetier("Nom de l’agent requis");
        const token =
            "auto_agent_" +
            crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true }),
          empreinte = new Bun.CryptoHasher("sha256").update(token).digest("hex");
        const [a] =
          await sql`INSERT INTO agent_admin(proprietaire_id,nom,empreinte,expire_at) VALUES(${user},${b.nom.trim()},${empreinte},now()+interval '365 days') RETURNING id,nom,expire_at`;
        return Response.json({ ...a, token }, { status: 201, headers: { "cache-control": "private, no-store" } });
      }),
    },
    "/v1/admin/agents/:id": {
      DELETE: humain(async (req: BunRequest<"/v1/admin/agents/:id">, user) => {
        if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new ErreurMetier("Identifiant invalide");
        const r =
          await sql`UPDATE agent_admin SET actif=false WHERE id=${req.params.id} AND proprietaire_id=${user} RETURNING id`;
        return new Response(null, { status: r.length ? 204 : 404 });
      }),
    },
  };
};
const op = (summary: string) => ({
  summary,
  responses: { 200: { description: "Super-administrateur humain authentifié" }, 403: { description: "Accès refusé" } },
});
export const openapi: Chemins = {
  "/v1/admin/moi": { get: op("Mon accès super-administrateur") },
  "/v1/admin/agents": { get: op("Mes accès agents"), post: op("Créer un accès agent nominatif") },
  "/v1/admin/agents/{id}": { delete: op("Révoquer un agent") },
};

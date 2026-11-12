// Aide aux tests : API de test sur une base jetable, deux tenants avec chacun un jeton API.
import { testDb } from "@auto/store";
import { creerApp } from "@auto/api/app";

export async function apiDeTest() {
  const { sql, drop } = await testDb();
  const server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });

  async function appel(path: string, token?: string, body?: unknown) {
    const res = await fetch(new URL(path, server.url), {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  async function tenant(email: string, nom: string) {
    const i = await appel("/v1/auth/inscription", undefined, {
      email,
      motDePasse: "un mot de passe long",
      entreprise: { nom, siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
    });
    const { jeton } = await appel("/v1/jetons", i.session, { nom: "agent" });
    return { tenantId: i.tenantId as string, jeton: jeton as string };
  }

  return {
    url: server.url.toString().replace(/\/$/, ""),
    appel,
    tenant,
    async fermer() {
      await server.stop(true);
      await drop();
    },
  };
}

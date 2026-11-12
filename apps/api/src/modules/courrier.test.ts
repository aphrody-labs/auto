import { beforeAll, afterAll, expect, test } from "bun:test";
import { testDb, type Sql, avecCourrier, stockerCourrier, type CompteCourrier } from "@auto/store";
import { synchroniserOperateurs } from "@auto/tenancy";
import { creerApp } from "../app";
let sql: Sql,
  drop: () => Promise<void>,
  server: ReturnType<typeof Bun.serve>,
  a: { id: string; cookie: string },
  b: { id: string; cookie: string },
  message: string,
  compte: string;
const avant = Bun.env.AUTO_SUPER_ADMIN_EMAILS;
async function appeler(path: string, cookie = "", method = "GET", body?: unknown) {
  const r = await fetch(new URL(path, server.url), {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({
    port: 0,
    routes: creerApp(sql, undefined, {
      auth: { secret: "secret-test-courrier-personnel-0123456789", limiteDebit: false },
    }),
    fetch: () => new Response("404", { status: 404 }),
  });
  const creer = async (email: string) => {
    const r = await fetch(new URL("/api/auth/sign-up/email", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "mot-de-passe-long-courrier", name: "Boîte privée" }),
    });
    const b = await r.json();
    if (!r.ok) throw Error(JSON.stringify(b));
    return {
      id: b.user.id as string,
      cookie: r.headers
        .getSetCookie()
        .map((x) => x.split(";")[0])
        .join("; "),
    };
  };
  a = await creer("proprietaire-courrier@example.test");
  b = await creer("autre-courrier@example.test");
  const c = await avecCourrier(
    sql,
    a.id,
    a.id,
    async (tx) =>
      (
        await tx<
          CompteCourrier[]
        >`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret) VALUES(${a.id},'google','personnel@example.test',${new Uint8Array([1, 2, 3])}) RETURNING *`
      )[0]!,
  );
  compte = c.id;
  message = await avecCourrier(sql, a.id, a.id, (tx) =>
    stockerCourrier(tx, c, {
      distantId: "test-1",
      expediteur: "contact@example.test",
      destinataires: ["personnel@example.test"],
      sujet: "Privé",
      texte: "Uniquement pour le propriétaire",
      date: new Date().toISOString(),
      lu: false,
    }),
  );
}, 30000);
afterAll(async () => {
  if (avant === undefined) delete Bun.env.AUTO_SUPER_ADMIN_EMAILS;
  else Bun.env.AUTO_SUPER_ADMIN_EMAILS = avant;
  await server?.stop(true);
  await drop?.();
});
test("Messagerie personnelle sans entreprise : session obligatoire et isolation des comptes, messages et mutations", async () => {
  expect((await appeler("/v1/courrier/comptes")).status).toBe(401);
  expect((await appeler("/v1/courrier/comptes", a.cookie)).body.comptes.length).toBe(1);
  expect((await appeler("/v1/courrier/comptes", b.cookie)).body.comptes.length).toBe(0);
  expect((await appeler("/v1/courrier/messages", a.cookie)).body.messages.length).toBe(1);
  expect((await appeler(`/v1/courrier/messages/${message}`, b.cookie)).status).toBe(404);
  expect((await appeler(`/v1/courrier/messages/${message}`, b.cookie, "PATCH", { lu: true })).status).toBe(404);
  expect((await appeler(`/v1/courrier/comptes/${compte}`, b.cookie, "DELETE")).status).toBe(404);
  expect((await appeler(`/v1/courrier/messages/${message}`, a.cookie, "PATCH", { lu: true })).status).toBe(200);
  expect((await appeler("/v1/courrier/messages", a.cookie)).body.messages[0].lu).toBe(true);
  expect((await appeler("/v1/courrier/comptes/aphrody", b.cookie, "POST", {})).status).toBe(403);
  expect((await appeler("/v1/courrier/oauth/google/retour?state=inconnu&code=factice", a.cookie)).status).toBe(409);
});
test("Super-admin vérifié et agent nominatif : administration autorisée, mails privés et création agents refusés au jeton", async () => {
  Bun.env.AUTO_SUPER_ADMIN_EMAILS = "proprietaire-courrier@example.test";
  await synchroniserOperateurs(sql);
  expect((await sql`SELECT role FROM app_user WHERE id=${a.id}`)[0]!.role).not.toBe("admin");
  await sql`UPDATE app_user SET email_verified=true WHERE id=${a.id}`;
  await synchroniserOperateurs(sql);
  expect((await sql`SELECT role FROM app_user WHERE id=${a.id}`)[0]!.role).toBe("admin");
  expect((await appeler("/v1/admin/moi", b.cookie)).status).toBe(403);
  const creation = await appeler("/v1/admin/agents", a.cookie, "POST", { nom: "Codex recette" });
  expect(creation.status).toBe(201);
  expect(creation.body.token).toStartWith("auto_agent_");
  const requete = async (path: string) => {
    const r = await fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${creation.body.token}` } });
    return r.status;
  };
  expect(await requete("/v1/admin/tenants")).toBe(200);
  expect(await requete("/v1/courrier/messages")).toBe(401);
  expect(await requete("/v1/admin/agents")).toBe(403);
  const [stocke] = await sql`SELECT empreinte FROM agent_admin WHERE id=${creation.body.id}`;
  expect(stocke!.empreinte).not.toContain("auto_agent_");
  expect((await appeler(`/v1/admin/agents/${creation.body.id}`, a.cookie, "DELETE")).status).toBe(204);
  expect(await requete("/v1/admin/tenants")).toBe(401);
});

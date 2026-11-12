import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  delete Bun.env.AUTO_TENANT_OPERATEUR;
  await server.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(new URL(path, server.url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

const inscrire = async (email: string, nom: string) =>
  (
    await api("/v1/auth/inscription", undefined, {
      email,
      motDePasse: "un mot de passe long",
      entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Paris" },
    })
  ).body as { session: string; tenantId: string };

test("restriction réseau admin : le rôle opérateur historique ne contourne pas la liste IP", async () => {
  const avant = {
    ips: Bun.env.AUTO_ADMIN_IPS,
    source: Bun.env.AUTO_ADMIN_IP_SOURCE,
    operateur: Bun.env.AUTO_TENANT_OPERATEUR,
  };
  const o = await inscrire("operateur-reseau@exemple.fr", "Opérateur réseau");
  try {
    Bun.env.AUTO_TENANT_OPERATEUR = o.tenantId;
    Bun.env.AUTO_ADMIN_IPS = "192.0.2.1";
    Bun.env.AUTO_ADMIN_IP_SOURCE = "cloudflare-tunnel";
    const req = (headers: Record<string, string>, token = o.session) =>
      fetch(new URL("/v1/admin/tenants", server.url), {
        headers: { ...headers, ...(token ? { authorization: "Bearer " + token } : {}) },
      });
    expect((await req({ "x-forwarded-for": "192.0.2.1" })).status).toBe(403);
    expect((await req({ "cf-connecting-ip": "192.0.2.2" })).status).toBe(403);
    expect((await req({ "cf-connecting-ip": "192.0.2.1" })).status).toBe(200);
    expect((await req({ "cf-connecting-ip": "192.0.2.1" }, "")).status).toBe(401);
  } finally {
    for (const [k, v] of Object.entries({
      AUTO_ADMIN_IPS: avant.ips,
      AUTO_ADMIN_IP_SOURCE: avant.source,
      AUTO_TENANT_OPERATEUR: avant.operateur,
    })) {
      if (v === undefined) delete Bun.env[k];
      else Bun.env[k] = v;
    }
  }
});

test("membres et jetons : liste sans secret, révocation", async () => {
  const a = await inscrire("membres@exemple.fr", "Membres");
  expect((await api("/v1/membres", a.session)).body).toEqual([
    {
      id: expect.any(String),
      userId: expect.any(String),
      email: "membres@exemple.fr",
      nom: "membres",
      role: "owner",
      depuis: expect.any(String),
    },
  ]);
  const j = (await api("/v1/jetons", a.session, { nom: "agent" })).body.jeton as string;
  const liste = (await api("/v1/jetons", a.session)).body;
  expect(liste).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      nom: "agent",
      debut: expect.stringMatching(/^auto_/),
      email: "membres@exemple.fr",
      creeLe: expect.any(String),
      expireLe: null,
      dernierUsage: null,
    },
  ]);
  expect(JSON.stringify(liste)).not.toContain(j);
  expect((await api("/v1/membres", j)).status).toBe(200);
  expect((await api(`/v1/jetons/${liste[0].id}`, a.session, undefined, "DELETE")).status).toBe(204);
  expect((await api("/v1/membres", j)).status).toBe(401);
  expect((await api("/v1/jetons/00000000-0000-0000-0000-000000000000", a.session, undefined, "DELETE")).status).toBe(
    404,
  );
});

test("console opérateur : réservée, transverse, suspension tracée et levée", async () => {
  const o = await inscrire("operateur@exemple.fr", "Opérateur");
  const a = await inscrire("client-a@exemple.fr", "Client A");
  Bun.env.AUTO_TENANT_OPERATEUR = o.tenantId;

  expect((await api("/v1/admin/tenants", a.session)).status).toBe(403);
  const tenants = (await api("/v1/admin/tenants", o.session)).body;
  expect(tenants.map((t: { nom: string }) => t.nom)).toContain("Client A");
  expect(tenants.find((t: { id: string }) => t.id === a.tenantId)).toMatchObject({ plan: "gratuit", suspendu: null });

  const fiche = (await api(`/v1/admin/tenants/${a.tenantId}`, o.session)).body;
  expect(fiche.membres).toEqual([{ email: "client-a@exemple.fr", role: "owner" }]);
  expect(fiche.audit.ok).toBe(true);
  expect((await api("/v1/admin/tenants/00000000-0000-0000-0000-000000000000", o.session)).status).toBe(404);

  expect((await api(`/v1/admin/tenants/${a.tenantId}/suspension`, o.session, { suspendu: true })).status).toBe(422);
  expect(
    (await api(`/v1/admin/tenants/${o.tenantId}/suspension`, o.session, { suspendu: true, motif: "x" })).status,
  ).toBe(409);
  expect(
    (await api(`/v1/admin/tenants/${a.tenantId}/suspension`, o.session, { suspendu: true, motif: "impayé" })).status,
  ).toBe(204);
  expect((await api("/v1/documents", a.session)).status).toBe(401);
  expect(
    (await api("/v1/admin/tenants", o.session)).body.find((t: { id: string }) => t.id === a.tenantId).suspendu,
  ).toMatchObject({ motif: "impayé" });
  expect((await api(`/v1/admin/tenants/${a.tenantId}/suspension`, o.session, { suspendu: false })).status).toBe(204);
  expect((await api("/v1/documents", a.session)).status).toBe(200);

  const u = (await api("/v1/admin/utilisateurs?email=client-a@exemple.fr", o.session)).body;
  expect(u.adhesions).toEqual([{ tenantId: a.tenantId, nom: "Client A", role: "owner" }]);
  expect((await api("/v1/admin/utilisateurs?email=personne@exemple.fr", o.session)).status).toBe(404);
  expect((await api("/v1/admin/stripe/evenements", o.session)).body).toEqual([]);
  expect(Array.isArray((await api("/v1/admin/evenements?statut=echec", o.session)).body)).toBe(true);
  const audits = (await api("/v1/admin/audit", o.session)).body;
  expect(audits.every((x: { ok: boolean }) => x.ok)).toBe(true);
  expect(audits.find((x: { tenantId: string }) => x.tenantId === a.tenantId).entrees).toBeGreaterThanOrEqual(2);
});

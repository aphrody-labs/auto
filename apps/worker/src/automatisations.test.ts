import { afterAll, beforeAll, expect, test } from "bun:test";
import { creerApp } from "@auto/api/app";
import { outbox } from "@auto/services";
import { testDb, type Sql } from "@auto/store";
import { automatisations, estDue, planifierAutomatisations } from "./automatisations";
import { creerWorker } from "./worker";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let recepteur: ReturnType<typeof Bun.serve>;
const recus: unknown[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql, outbox), fetch: () => new Response("404", { status: 404 }) });
  Bun.env.AUTO_API_URL = server.url.origin;
  recepteur = Bun.serve({ port: 0, fetch: async (req) => (recus.push(await req.json()), Response.json({ ok: true })) });
});

afterAll(async () => {
  await server.stop(true);
  await recepteur.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown) {
  const res = await fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("cron dû selon le fuseau du workflow", () => {
  const huitHeuresParis = new Date("2026-10-26T07:00:00Z"); // lundi, heure d'hiver
  expect(estDue("0 8 * * 1", huitHeuresParis, "Europe/Paris")).toBe(true);
  expect(estDue("0 8 * * 1", huitHeuresParis, "UTC")).toBe(false);
  expect(estDue("*/15 * * * *", new Date("2026-10-26T07:15:00Z"), "UTC")).toBe(true);
  expect(estDue("pas un cron", huitHeuresParis, "UTC")).toBe(false);
});

test("workflow planifié : enfilé une fois par minute due, exécuté par le worker", async () => {
  const a = await api("/v1/auth/inscription", undefined, {
    email: `${crypto.randomUUID()}@exemple.fr`,
    motDePasse: "un mot de passe long",
    entreprise: { nom: "Atelier", siret: "73282932000074", adresse: "1 rue A, Paris" },
  });
  const session = a.body.session as string;
  const w = await api("/v1/automatisations", session, {
    nom: "Chaque quart d'heure",
    actif: true,
    definition: {
      noeuds: [
        { id: "cron", type: "declencheur.planifie", nom: "Cron", parametres: { cron: "*/15 * * * *", fuseau: "UTC" } },
        {
          id: "http",
          type: "reseau.http",
          nom: "Appel",
          parametres: { methode: "POST", url: recepteur.url.href, corps: { minute: "{{ $json.minute }}" } },
        },
      ],
      connexions: [{ de: "cron", vers: "http" }],
    },
  });
  expect(w.status).toBe(201);
  const minute = new Date("2026-10-26T07:15:00Z");
  expect(await planifierAutomatisations(sql, minute)).toBe(1);
  expect(await planifierAutomatisations(sql, minute)).toBe(1); // même clé : un seul job
  expect(await planifierAutomatisations(sql, new Date("2026-10-26T07:16:00Z"))).toBe(0);
  const worker = creerWorker(sql, automatisations(sql), { delai: () => 0 });
  expect(await worker.vider()).toBe(1);
  expect(recus).toEqual([{ minute: minute.toISOString() }]);
  const e = await api(`/v1/automatisations/${w.body.id}/executions`, session);
  expect(e.body).toMatchObject([{ statut: "succes", origine: "planifie:2026-10-26T07:15" }]);
});

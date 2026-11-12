import { afterAll, beforeAll, expect, test } from "bun:test";
import { bacMock } from "@auto/pa";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "@auto/api/app";
import { tenantsConnectes } from "@auto/services/pa";
import { tachesPlanifiees } from "./planification";

// Clé maître de test : chiffrement des identifiants de la PA.
Bun.env.AUTO_CLE_MAITRE ??= "cle-maitre-de-test-pour-la-synchro-pa";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(new URL(path, server.url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return r.json() as Promise<any>;
}

const inscrire = (email: string, nom: string) =>
  api("/v1/auth/inscription", undefined, {
    email,
    motDePasse: "un mot de passe long",
    entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Paris" },
  });

test("tâche PA : seuls les tenants connectés sont relevés, le statut relevé atteint le document", async () => {
  const a = await inscrire("synchro-a@exemple.fr", "Alpha");
  const b = await inscrire("synchro-b@exemple.fr", "Beta");
  const mandat = { signataire: "Alice Martin", qualite: "gérante", date: "2026-10-22" };
  await api("/v1/pa", a.session, { plateforme: "mock", mandat }, "PUT");
  expect(await tenantsConnectes(sql)).toEqual([a.tenantId]);

  const d = await api("/v1/documents", a.session, {
    type: "facture",
    date: "2026-10-22",
    client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 50000, tva: 200 }],
    datePrestation: "2026-10-15",
    echeance: "2026-11-21",
  });
  await api(`/v1/documents/${d.id}/emettre`, a.session, {});
  const dep = await api("/v1/pa/depots", a.session, { documentId: d.id });
  bacMock.avancer(a.tenantId, dep.idPa, "encaissee", "2026-10-30T09:00:00.000Z");

  const t = tachesPlanifiees(sql);
  await t["pa.tenant"]!.executer(
    { id: "j", type: "pa.tenant", tenantId: a.tenantId, payload: {}, cle: null } as never,
    new AbortController().signal,
  );
  expect((await api(`/v1/documents/${d.id}`, a.session)).statut).toBe("paye");
  expect((await api(`/v1/documents`, b.session)).length).toBe(0);
});

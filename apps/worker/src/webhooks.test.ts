import { afterAll, beforeAll, expect, test } from "bun:test";
import { creerApp } from "@auto/api/app";
import { signer, outbox } from "@auto/services";
import { testDb, type Sql } from "@auto/store";
import { abonnementsTenants } from "./expediteur";
import { creerWorker } from "./worker";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
const recus: { tenant: string; corps: string; signature: string | null }[] = [];
let recepteur: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql, outbox), fetch: () => new Response("404", { status: 404 }) });
  recepteur = Bun.serve({
    port: 0,
    routes: {
      "/:tenant": {
        POST: async (req) => {
          recus.push({
            tenant: req.params.tenant,
            corps: await req.text(),
            signature: req.headers.get("x-auto-signature"),
          });
          return new Response("ok");
        },
      },
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await recepteur.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(new URL(path, server.url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: r.status === 204 ? null : ((await r.json()) as any) };
}

const inscrire = async (email: string, nom: string) =>
  (
    await api("/v1/auth/inscription", undefined, {
      email,
      motDePasse: "un mot de passe long",
      entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Paris" },
    })
  ).body;

test("abonnements par tenant : filtrés par type, signés avec le secret de l'abonnement, isolés", async () => {
  const a = await inscrire("wh-a@exemple.fr", "Alpha");
  const b = await inscrire("wh-b@exemple.fr", "Beta");
  expect((await api("/v1/webhooks", a.session, { url: "http://exemple.fr/x" })).status).toBe(422);
  expect((await api("/v1/webhooks", a.session, { url: `${recepteur.url}a`, types: ["Mauvais"] })).status).toBe(422);
  const wa = await api("/v1/webhooks", a.session, { url: `${recepteur.url}a`, types: ["paiement.enregistre"] });
  expect(wa.status).toBe(201);
  const wb = await api("/v1/webhooks", b.session, { url: `${recepteur.url}b` });
  expect((await api("/v1/webhooks", a.session)).body).toHaveLength(1);
  expect((await api("/v1/webhooks", a.session)).body[0].secret).toBeUndefined();

  const d = (
    await api("/v1/documents", a.session, {
      type: "facture",
      date: "2026-10-22",
      client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
      lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
      datePrestation: "2026-10-15",
      echeance: "2026-11-21",
    })
  ).body;
  await api(`/v1/documents/${d.id}/emettre`, a.session, {});
  await api(`/v1/documents/${d.id}/paiements`, a.session, { date: "2026-10-23", montantCents: 5000, mode: "virement" });

  const w = creerWorker(sql, abonnementsTenants(sql));
  expect(await w.vider()).toBe(1);
  expect(recus).toHaveLength(1);
  const [r] = recus;
  expect(r!.tenant).toBe("a");
  expect(JSON.parse(r!.corps)).toMatchObject({ type: "paiement.enregistre", tenantId: a.tenantId });
  expect(r!.signature).toBe(signer(wa.body.secret, r!.corps));
  expect(r!.signature).not.toBe(signer(wb.body.secret, r!.corps));

  // Abonnement supprimé : plus de livraison ; B ne peut pas supprimer celui de A.
  expect((await api(`/v1/webhooks/${wa.body.id}`, b.session, undefined, "DELETE")).status).toBe(404);
  expect((await api(`/v1/webhooks/${wa.body.id}`, a.session, undefined, "DELETE")).status).toBe(204);
  await api(`/v1/documents/${d.id}/paiements`, a.session, { date: "2026-10-24", montantCents: 1000, mode: "virement" });
  expect(await w.vider()).toBe(0);
});

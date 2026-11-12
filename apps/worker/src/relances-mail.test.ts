import { afterAll, beforeAll, expect, test } from "bun:test";
import { creerApp } from "@auto/api/app";
import { outbox } from "@auto/services";
import { texteRelance } from "@auto/services/mail";
import { boiteJetable, greenmailDisponible } from "@auto/mail/greenmail";
import { avecWorker, majAbonnement, testDb, withTenant, type Sql } from "@auto/store";
import { relancer } from "./planification";

Bun.env.AUTO_CLE_MAITRE ??= "cle maitre de test, 32 caracteres au moins";
Bun.env.AUTO_MAIL_DEV = "1";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql, outbox), fetch: () => new Response("404", { status: 404 }) });
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
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

test("texte des relances : trois paliers, montant et mentions légales", () => {
  const r = { numero: "F-2026-0007", echeance: "2026-09-30", joursRetard: 31, niveau: 2 as const, resteCents: 123456 };
  const t = texteRelance(r, "Alpha");
  expect(t.sujet).toBe("Deuxième relance : facture F-2026-0007 — Alpha");
  expect(t.message).toContain("30/09/2026");
  expect(t.message).toContain("40 €");
  expect(texteRelance({ ...r, niveau: 1 }, "Alpha").message).not.toContain("40 €");
  expect(texteRelance({ ...r, niveau: 3 }, "Alpha").sujet).toStartWith("Dernière relance avant mise en demeure");
});

test.skipIf(!greenmailDisponible)("relance J+7 envoyée depuis la boîte de l'entreprise", async () => {
  const v = (
    await api("/v1/auth/inscription", undefined, {
      email: `relance-${crypto.randomUUID()}@exemple.fr`,
      motDePasse: "un mot de passe long",
      entreprise: { nom: "Alpha", siret: "73282932000074", adresse: "1 rue A, Paris" },
    })
  ).body as { session: string; tenantId: string };
  await withTenant(sql, v.tenantId, (tx) => majAbonnement(tx, { plan: "pro", statut: "active" }));
  const b = boiteJetable("relance", true);
  const boite = await api(
    "/v1/mail/boite",
    v.session,
    {
      adresse: b.adresse,
      motDePasse: b.identifiants.motDePasse,
      imap: { hote: b.imap.hote, port: b.imap.port, securite: b.imap.securite },
      smtp: { hote: b.smtp.hote, port: b.smtp.port, securite: b.smtp.securite },
      certificatNonVerifie: true,
    },
    "PUT",
  );
  expect(boite.status).toBe(200);
  const client = boiteJetable("client", true);
  const d = (
    await api("/v1/documents", v.session, {
      type: "facture",
      date: "2026-09-01",
      client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon", email: client.adresse },
      lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 100000, tva: 200 }],
      datePrestation: "2026-08-31",
      echeance: "2026-10-01",
    })
  ).body;
  await api(`/v1/documents/${d.id}/emettre`, v.session, {});

  expect(await relancer(sql, v.tenantId, "2026-10-09")).toBe(1);
  expect((await api(`/v1/documents/${d.id}`, v.session)).body.statut).toBe("envoye");
  const [e] = await avecWorker(
    sql,
    (tx) =>
      tx<
        { corps: string }[]
      >`SELECT corps FROM evenement WHERE type = 'relance.a_envoyer' AND tenant_id = ${v.tenantId}`,
  );
  expect(JSON.parse(e!.corps).data).toMatchObject({ niveau: 1, envoyeParMail: true });
  // Rejouée le même jour : rien de plus.
  expect(await relancer(sql, v.tenantId, "2026-10-09")).toBe(0);
});

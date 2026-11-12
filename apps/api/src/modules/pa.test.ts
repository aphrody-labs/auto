import { afterAll, beforeAll, expect, test } from "bun:test";
import { bacMock, type EvenementPa } from "@auto/pa";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "../app";
import type { Emetteur } from "@auto/services";

Bun.env.AUTO_CLE_MAITRE ??= "cle maitre de test, 32 caracteres au moins";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
const evenements: { type: string; tenantId: string; data: any }[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const publier: Emetteur = async (tx, type, data) => {
    const [r] = await tx<{ t: string }[]>`SELECT current_setting('app.tenant', true) AS t`;
    evenements.push({ type, tenantId: r!.t, data });
    return { id: crypto.randomUUID() };
  };
  server = Bun.serve({ port: 0, routes: creerApp(sql, publier), fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

async function api(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(new URL(path, server.url), {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Webhook signé par la PA simulée. */
async function webhook(tenantId: string, secret: string, evs: EvenementPa[]) {
  const w = bacMock.webhook(secret, evs);
  const res = await fetch(new URL(`/v1/pa/webhook/${tenantId}`, server.url), {
    method: "POST",
    headers: w.entetes,
    body: w.corps,
  });
  return { status: res.status, body: await res.json() };
}

const inscription = (email: string, nom: string) => ({
  email,
  motDePasse: "un mot de passe long",
  entreprise: { nom, siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
});

const facture = {
  type: "facture",
  date: "2026-10-22",
  client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [{ designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tva: 200 }],
  datePrestation: "2026-10-15",
  echeance: "2026-11-21",
};

const mandat = { signataire: "Alice Martin", qualite: "gérante", date: "2026-10-22" };

test("PA mock : émission → dépôt → déposée → webhook encaissée ; réception ; isolation", async () => {
  const a = (await api("/v1/auth/inscription", undefined, { body: inscription("pa-a@exemple.fr", "Alpha") })).body;
  const b = (await api("/v1/auth/inscription", undefined, { body: inscription("pa-b@exemple.fr", "Beta") })).body;
  const ta: string = a.tenantId;
  const tb: string = b.tenantId;

  // Connexion : mandat exigé, identifiants chiffrés au repos.
  expect((await api("/v1/pa", a.session)).status).toBe(404);
  expect((await api("/v1/pa", a.session, { method: "PUT", body: { plateforme: "mock" } })).status).toBe(422);
  expect((await api("/v1/pa", a.session, { method: "PUT", body: { plateforme: "inconnue", mandat } })).status).toBe(
    422,
  );
  expect(
    (await api("/v1/pa", a.session, { method: "PUT", body: { plateforme: "b2brouter", identifiants: {}, mandat } }))
      .status,
  ).toBe(422);
  const ca = await api("/v1/pa", a.session, { method: "PUT", body: { plateforme: "mock", mandat } });
  expect(ca.status).toBe(200);
  expect(ca.body.mandatReference).toBe("MOCK-MANDAT-732829320-2026-10-22");
  expect(ca.body.webhook).toBe(`/v1/pa/webhook/${ta}`);
  const secretA: string = ca.body.secretWebhook;
  const [brut] = await sql`SELECT identifiants FROM pa_connexion WHERE tenant_id = ${ta}`;
  expect(Buffer.from(brut.identifiants).toString("latin1")).not.toContain(secretA);
  expect((await api("/v1/pa", a.session)).body).toMatchObject({ plateforme: "mock", mandat: { siren: "732829320" } });

  // Facture émise puis déposée : l'exemplaire Factur-X figé part à la PA.
  const d = (await api("/v1/documents", a.session, { body: facture })).body;
  expect((await api("/v1/pa/depots", a.session, { body: { documentId: d.id } })).status).toBe(409); // brouillon
  expect((await api(`/v1/documents/${d.id}/emettre`, a.session, { body: {} })).status).toBe(200);
  const dep = await api("/v1/pa/depots", a.session, { body: { documentId: d.id } });
  expect(dep.status).toBe(201);
  expect(dep.body).toMatchObject({ documentId: d.id, numero: "F-2026-0001", plateforme: "mock", statut: "deposee" });
  expect(dep.body.idPa).toMatch(/^MOCK-\d{6}$/);
  const [fx] = await sql`SELECT sha256 FROM fichier WHERE document_id = ${d.id}`;
  expect(dep.body.sha256).toBe(fx.sha256);
  expect((await api(`/v1/documents/${d.id}`, a.session)).body.statut).toBe("depose");
  expect((await api("/v1/pa/depots", a.session, { body: { documentId: d.id } })).status).toBe(409); // déjà déposée

  // Webhook encaissée : signature vérifiée, statut et document mis à jour, événement publié, rejeu sans effet.
  const ev = bacMock.avancer(ta, dep.body.idPa, "encaissee", new Date(Date.now() + 60_000).toISOString());
  expect((await webhook(ta, "mauvais secret", [ev])).status).toBe(401);
  expect(await webhook(ta, secretA, [ev])).toEqual({ status: 200, body: { traites: 1 } });
  expect(await webhook(ta, secretA, [ev])).toEqual({ status: 200, body: { traites: 0 } });
  const suivi = (await api(`/v1/pa/depots/${dep.body.id}`, a.session)).body;
  expect(suivi.statut).toBe("encaissee");
  expect(
    suivi.statuts.map((s: { statut: string; code: number; source: string }) => [s.statut, s.code, s.source]),
  ).toEqual([
    ["deposee", 200, "depot"],
    ["encaissee", 212, "webhook"],
  ]);
  expect((await api(`/v1/documents/${d.id}`, a.session)).body.statut).toBe("paye");
  const statutsPa = evenements.filter((e) => e.type === "pa.statut" && e.tenantId === ta);
  expect(statutsPa.map((e) => e.data.statut)).toEqual(["deposee", "encaissee"]);

  // Isolation : B ne voit ni la connexion, ni les dépôts, ni les documents de A.
  expect((await api("/v1/pa", b.session)).status).toBe(404);
  expect((await api("/v1/pa/depots", b.session)).body).toEqual([]);
  expect((await api(`/v1/pa/depots/${dep.body.id}`, b.session)).status).toBe(404);
  expect((await api("/v1/pa/depots", b.session, { body: { documentId: d.id } })).status).toBe(404);
  const cb = await api("/v1/pa", b.session, { method: "PUT", body: { plateforme: "mock", mandat } });
  const secretB: string = cb.body.secretWebhook;
  expect(secretB).not.toBe(secretA);
  // Secret de B sur l'URL de A : refusé ; événement de A rejoué chez B : aucun dépôt de B concerné.
  expect((await webhook(ta, secretB, [ev])).status).toBe(401);
  expect((await webhook(tb, secretB, [ev])).body).toEqual({ traites: 0 });
  expect((await webhook("00000000-0000-0000-0000-000000000000", secretA, [ev])).status).toBe(404);

  // Réception : B reçoit le Factur-X émis par A, XML extrait, événement facture.recue.
  const pdfA = new Uint8Array(
    await (
      await fetch(new URL(`/v1/documents/${d.id}/pdf`, server.url), {
        headers: { authorization: `Bearer ${a.session}` },
      })
    ).arrayBuffer(),
  );
  const entrante = bacMock.livrer(tb, pdfA, "2026-10-23T08:00:00.000Z");
  expect((await webhook(tb, secretB, [entrante])).body).toEqual({ traites: 1 });
  const recues = (await api("/v1/pa/recues", b.session)).body;
  expect(recues).toHaveLength(1);
  expect(recues[0]).toMatchObject({ idPa: entrante.idPa, numero: "F-2026-0001", emetteur: "Alpha", ttcCents: 216000 });
  const detail = (await api(`/v1/pa/recues/${recues[0].id}`, b.session)).body;
  expect(detail.xml).toContain("<ram:GrandTotalAmount>2160.00</ram:GrandTotalAmount>");
  const pdfB = await fetch(new URL(`/v1/pa/recues/${recues[0].id}/pdf`, server.url), {
    headers: { authorization: `Bearer ${b.session}` },
  });
  expect(new Uint8Array(await pdfB.arrayBuffer())).toEqual(pdfA);
  expect(evenements.some((e) => e.type === "facture.recue" && e.tenantId === tb)).toBe(true);
  // La facture reçue par la PA est aussi passée à l'ingestion, chez B seulement.
  expect((await api("/v1/factures-recues", b.session)).body).toMatchObject([{ canal: "pa" }]);
  expect((await api("/v1/factures-recues", a.session)).body).toEqual([]);
  expect((await api("/v1/pa/recues", a.session)).body).toEqual([]);
  expect((await api(`/v1/pa/recues/${recues[0].id}`, a.session)).status).toBe(404);

  // Synchronisation : nouvelle facture entrante relevée sans webhook, l'ancienne n'est pas dupliquée.
  bacMock.livrer(tb, pdfA, "2026-10-24T08:00:00.000Z");
  expect((await api("/v1/pa/synchroniser", b.session, { body: {} })).body).toEqual({ statuts: 0, recues: 1 });
  expect((await api("/v1/pa/synchroniser", b.session, { body: {} })).body).toEqual({ statuts: 0, recues: 0 });

  // Annuaire et e-reporting.
  expect((await api("/v1/pa/annuaire/732829320", a.session)).body).toEqual({ siren: "732829320", plateforme: "mock" });
  expect((await api("/v1/pa/annuaire/123456789", a.session)).status).toBe(404);
  const er = await api("/v1/pa/ereporting", a.session, {
    body: { nature: "b2c", periode: "2026-10", lignes: [{ tva: 200, htCents: 10000, tvaCents: 2000 }] },
  });
  expect(er.status).toBe(201);
  expect(er.body).toMatchObject({ nature: "b2c", periode: "2026-10", statut: "deposee" });
  expect(
    (await api("/v1/pa/ereporting", a.session, { body: { nature: "b2c", periode: "2026-13", lignes: [] } })).status,
  ).toBe(422);
  expect((await api("/v1/pa/ereporting", b.session)).body).toEqual([]);

  // Statut posé par le vendeur, piste d'audit intacte, déconnexion.
  expect((await api(`/v1/pa/depots/${dep.body.id}/statut`, a.session, { body: { statut: "deposee" } })).status).toBe(
    422,
  );
  expect((await api("/v1/audit/verification", a.session)).body.ok).toBe(true);
  expect((await api("/v1/pa", a.session, { method: "DELETE" })).status).toBe(204);
  expect((await api("/v1/pa", a.session)).status).toBe(404);
  expect((await api("/v1/pa/synchroniser", a.session, { body: {} })).status).toBe(409);
});

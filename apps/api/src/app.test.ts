import { afterAll, beforeAll, expect, test } from "bun:test";
import { listerEvenements, testDb, withTenant, type Sql } from "@auto/store";
import { verifierPdfA } from "@auto/native";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  // Origine publique HTTPS : cookies `Secure` et préfixe `__Secure-`, comme en production.
  server = Bun.serve({
    port: 0,
    routes: creerApp(sql, undefined, { auth: { baseURL: "https://auto.test" } }),
    fetch: () => new Response("404", { status: 404 }),
  });
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

async function brut(path: string, token: string) {
  const res = await fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, octets: new Uint8Array(await res.arrayBuffer()) };
}

const inscription = (email: string, nom: string) => ({
  email,
  motDePasse: "un mot de passe long",
  entreprise: { nom, siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
});

const brouillon = {
  type: "facture",
  date: "2026-10-22",
  client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [{ designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tva: 200 }],
  datePrestation: "2026-10-15",
  echeance: "2026-11-21",
};

test("parcours complet, isolation, rôles, jetons", async () => {
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("a@exemple.fr", "Alpha") });
  expect(a.status).toBe(201);
  const b = await api("/v1/auth/inscription", undefined, { body: inscription("b@exemple.fr", "Beta") });
  expect((await api("/v1/auth/inscription", undefined, { body: inscription("a@exemple.fr", "X") })).status).toBe(409);

  expect((await api("/v1/documents")).status).toBe(401);

  const moi = await api("/v1/moi", a.body.session);
  expect(moi.body.role).toBe("owner");
  expect(moi.body.entreprise.tvaIntracom).toBe("FR44732829320");

  // Brouillon : l'émetteur est imposé par le serveur.
  const d = await api("/v1/documents", a.body.session, {
    body: { ...brouillon, emetteur: { nom: "Usurpateur", siret: "0", adresse: "?" } },
  });
  expect(d.status).toBe(201);
  expect(d.body.data.emetteur.nom).toBe("Alpha");
  expect(d.body.data.penalitesRetard).toBeTruthy();
  expect(d.body.totaux.ttcCents).toBe(216000);
  const apercu = await brut(`/v1/documents/${d.body.id}/pdf`, a.body.session);
  expect(new TextDecoder().decode(apercu.octets.subarray(0, 5))).toBe("%PDF-");
  expect(apercu.headers.get("etag")).toBeNull();

  const e = await api(`/v1/documents/${d.body.id}/emettre`, a.body.session, { body: {} });
  expect(e.status).toBe(200);
  expect(e.body.numero).toBe("F-2026-0001");

  // Exemplaire figé : Factur-X conforme PDF/A-3b, XML EN 16931, stable (ETag = SHA-256).
  const pdf = await brut(`/v1/documents/${d.body.id}/pdf`, a.body.session);
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(verifierPdfA(pdf.octets)).toEqual([]);
  const etag = pdf.headers.get("etag");
  expect((await brut(`/v1/documents/${d.body.id}/pdf`, a.body.session)).headers.get("etag")).toBe(etag);
  const xml = await brut(`/v1/documents/${d.body.id}/xml`, a.body.session);
  expect(new TextDecoder().decode(xml.octets)).toContain("<ram:ID>F-2026-0001</ram:ID>");
  expect((await api(`/v1/documents/${d.body.id}`, a.body.session, { method: "PUT", body: brouillon })).status).toBe(
    404,
  );
  expect((await api(`/v1/documents/${d.body.id}/emettre`, a.body.session, { body: {} })).status).toBe(409);

  // Isolation : B ne voit ni ne modifie le document de A.
  expect((await api(`/v1/documents/${d.body.id}`, b.body.session)).status).toBe(404);
  expect((await brut(`/v1/documents/${d.body.id}/pdf`, b.body.session)).status).toBe(404);
  expect((await brut(`/v1/documents/${d.body.id}/xml`, b.body.session)).status).toBe(404);
  expect((await api("/v1/documents", b.body.session)).body).toEqual([]);
  expect((await api(`/v1/documents/${d.body.id}/statut`, b.body.session, { body: { statut: "paye" } })).status).toBe(
    404,
  );

  // Rôle lecture : écriture refusée.
  await api("/v1/auth/inscription", undefined, { body: inscription("c@exemple.fr", "Gamma") });
  expect((await api("/v1/membres", a.body.session, { body: { email: "c@exemple.fr", role: "lecture" } })).status).toBe(
    204,
  );
  const c = await api("/v1/auth/connexion", undefined, {
    body: { email: "c@exemple.fr", motDePasse: "un mot de passe long", tenantId: a.body.tenantId },
  });
  expect((await api("/v1/documents", c.body.session)).body).toHaveLength(1);
  expect((await api("/v1/documents", c.body.session, { body: brouillon })).status).toBe(403);

  // Jeton API (agent, CLI) et piste d'audit.
  const j = await api("/v1/jetons", a.body.session, { body: { nom: "agent" } });
  expect(j.body.jeton).toStartWith("auto_");
  const paye = await api(`/v1/documents/${d.body.id}/statut`, j.body.jeton, { body: { statut: "paye" } });
  expect(paye.body.statut).toBe("paye");
  expect((await api("/v1/audit/verification", j.body.jeton)).body.ok).toBe(true);

  // Mauvais mot de passe, déconnexion.
  expect(
    (await api("/v1/auth/connexion", undefined, { body: { email: "a@exemple.fr", motDePasse: "faux" } })).status,
  ).toBe(401);
  await api("/v1/auth/deconnexion", a.body.session, { body: {} });
  expect((await api("/v1/moi", a.body.session)).status).toBe(401);
});

test("client enregistré, remise, paiements, relances", async () => {
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("p@exemple.fr", "Paiements SAS") });
  const t = a.body.session;
  const c = await api("/v1/clients", t, {
    body: { nom: "Dupont SARL", siret: "73282932000074", adresse: "3 rue C, Nantes", email: "compta@dupont.fr" },
  });
  expect(c.status).toBe(201);
  expect((await api("/v1/clients?q=dup", t)).body).toHaveLength(1);
  expect(
    (await api("/v1/produits", t, { body: { designation: "Audit", prixUnitaireHtCents: 50000, tva: 200 } })).status,
  ).toBe(201);

  const d = await api("/v1/documents", t, {
    body: {
      ...brouillon,
      client: undefined,
      clientId: c.body.id,
      date: "2026-09-01",
      echeance: "2026-09-30",
      lignes: [{ designation: "Audit", quantite: 2, prixUnitaireHtCents: 50000, tva: 200, remiseBp: 1000 }],
    },
  });
  expect(d.status).toBe(201);
  expect(d.body.clientId).toBe(c.body.id);
  expect(d.body.data.client.nom).toBe("Dupont SARL");
  expect(d.body.totaux.ttcCents).toBe(108000);
  const e = await api(`/v1/documents/${d.body.id}/emettre`, t, { body: {} });
  expect(e.status).toBe(200);
  const xml = await brut(`/v1/documents/${d.body.id}/xml`, t);
  expect(new TextDecoder().decode(xml.octets)).toContain("<ram:Reason>Remise 10 %</ram:Reason>");

  const r = await api("/v1/relances?date=2026-10-10", t);
  expect(r.body).toEqual([
    expect.objectContaining({ documentId: d.body.id, niveau: 1, joursRetard: 10, resteCents: 108000 }),
  ]);
  expect((await api(`/v1/documents/${d.body.id}/relances`, t, { body: { niveau: 1 } })).status).toBe(204);
  expect((await api("/v1/relances?date=2026-10-10", t)).body).toEqual([]);

  const p = await api(`/v1/documents/${d.body.id}/paiements`, t, {
    body: { date: "2026-10-12", montantCents: 108000, mode: "virement", reference: "VIR 1" },
  });
  expect(p.body.resteCents).toBe(0);
  expect((await api(`/v1/documents/${d.body.id}`, t)).body.statut).toBe("paye");
  expect((await api(`/v1/documents/${d.body.id}/paiements`, t)).body.paiements).toHaveLength(1);

  // Autre entreprise : ni le client ni les paiements ne sont visibles.
  const b = await api("/v1/auth/inscription", undefined, { body: inscription("q@exemple.fr", "Autre") });
  expect((await api(`/v1/clients/${c.body.id}`, b.body.session)).status).toBe(404);
  expect(
    (await api("/v1/documents", b.body.session, { body: { ...brouillon, client: undefined, clientId: c.body.id } }))
      .status,
  ).toBe(404);
  expect((await api(`/v1/documents/${d.body.id}/paiements`, b.body.session)).status).toBe(404);
});

test("employés et absences : droit rh, solde de congés, décision", async () => {
  const o = await api("/v1/auth/inscription", undefined, { body: inscription("rh@exemple.fr", "RH SARL") });
  const autre = await api("/v1/auth/inscription", undefined, { body: inscription("rh2@exemple.fr", "Autre") });
  const emp = await api("/v1/employes", o.body.session, {
    body: {
      nom: "Durand",
      prenom: "Inès",
      poste: "Comptable",
      contrat: "cdi",
      dateEntree: "2024-03-01",
      tempsTravail: 80,
      salaireBrutMensuelCents: 250000,
    },
  });
  expect(emp.status).toBe(201);
  expect((await api("/v1/employes", o.body.session, { body: { nom: "" } })).status).toBe(422);
  expect((await api(`/v1/employes/${emp.body.id}`, autre.body.session)).status).toBe(404);

  const solde = await api(`/v1/employes/${emp.body.id}/conges?au=2026-12-01`, o.body.session);
  expect(solde.body).toMatchObject({ periode: "2026-06-01", acquis: 15, disponible: 15 });
  const abs = await api(`/v1/employes/${emp.body.id}/absences`, o.body.session, {
    body: { type: "conges_payes", debut: "2026-12-21", fin: "2026-12-26" },
  });
  expect(abs.body).toMatchObject({ joursOuvrables: 5, statut: "demandee" });
  expect((await api("/v1/absences?statut=demandee", o.body.session)).body).toHaveLength(1);
  const ok = await api(`/v1/absences/${abs.body.id}/decision`, o.body.session, { body: { statut: "validee" } });
  expect(ok.body.statut).toBe("validee");
  expect((await api(`/v1/absences/${abs.body.id}/decision`, o.body.session, { body: { statut: "x" } })).status).toBe(
    422,
  );

  // Les données RH ne sont pas ouvertes aux rôles comptable et lecture.
  await api("/v1/auth/inscription", undefined, { body: inscription("compta@exemple.fr", "Compta") });
  await api("/v1/membres", o.body.session, { body: { email: "compta@exemple.fr", role: "comptable" } });
  const c = await api("/v1/auth/connexion", undefined, {
    body: { email: "compta@exemple.fr", motDePasse: "un mot de passe long", tenantId: o.body.tenantId },
  });
  expect((await api("/v1/employes", c.body.session)).status).toBe(403);
  expect((await api("/v1/documents", c.body.session)).status).toBe(200);
});

test("cookie de session : attributs, CSRF, déconnexion", async () => {
  const res = await fetch(new URL("/v1/auth/inscription", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inscription("cookie@exemple.fr", "Cookie SAS")),
  });
  const set = res.headers.get("set-cookie")!;
  expect(set).toContain("__Secure-auto.session_token=");
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toMatch(/Secure/i);
  expect(set).toMatch(/SameSite=Lax/i);
  const cookie = set.split(";")[0]!;
  const appel = (method: string, path: string, type?: string) =>
    fetch(new URL(path, server.url), {
      method,
      headers: { cookie, ...(type ? { "content-type": type } : {}) },
      body: method === "GET" ? undefined : "{}",
    });
  expect((await appel("GET", "/v1/moi")).status).toBe(200);
  // Formulaire d'un autre site : refusé avant tout traitement.
  expect((await appel("POST", "/v1/jetons", "text/plain")).status).toBe(415);
  expect((await appel("POST", "/v1/jetons", "application/x-www-form-urlencoded")).status).toBe(415);
  expect((await appel("POST", "/v1/jetons", "application/json")).status).toBe(201);
  const out = await appel("POST", "/v1/auth/deconnexion", "application/json");
  expect(out.status).toBe(204);
  expect(out.headers.get("set-cookie")).toMatch(/auto\.session_token=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  expect((await appel("GET", "/v1/moi")).status).toBe(401);
});

test("événements écrits dans l'outbox avec la transaction métier", async () => {
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("outbox@exemple.fr", "Outbox") });
  const t = a.body.session;
  const d = await api("/v1/documents", t, { body: brouillon });
  const e = await api(`/v1/documents/${d.body.id}/emettre`, t, { body: {} });
  expect(e.status).toBe(200);
  // Deuxième émission refusée : transaction annulée, aucun événement.
  expect((await api(`/v1/documents/${d.body.id}/emettre`, t, { body: {} })).status).toBe(409);
  await api(`/v1/documents/${d.body.id}/statut`, t, { body: { statut: "envoye" } });
  const evts = await withTenant(sql, a.body.tenantId, (tx) => listerEvenements(tx));
  expect(evts.map((x) => x.type).sort()).toEqual(["document.emis", "document.statut"]);
  const emis = JSON.parse(evts.find((x) => x.type === "document.emis")!.corps);
  expect(emis).toMatchObject({ tenantId: a.body.tenantId, data: { id: d.body.id, numero: e.body.numero } });
  expect(evts.every((x) => x.statut === "a_livrer")).toBe(true);
});

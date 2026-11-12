import { afterAll, beforeAll, expect, test } from "bun:test";
import { clientOpenAi } from "@auto/ingest";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "../app";
import { reglages } from "@auto/services/ingest";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let llm: ReturnType<typeof Bun.serve>;
let reponseLlm = "";

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
  llm = Bun.serve({
    port: 0,
    routes: {
      "/v1/chat/completions": () =>
        Response.json({ choices: [{ message: { role: "assistant", content: reponseLlm } }] }),
    },
  });
  reglages.ocr = async () => "FACTURE D-2026-0001 Alpha …";
  reglages.llm = () => clientOpenAi({ url: `${llm.url}v1` });
});

afterAll(async () => {
  await server.stop(true);
  await llm.stop(true);
  await drop();
});

async function api(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(new URL(path, server.url), {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function octets(path: string, token: string) {
  const res = await fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${token}` } });
  return new Uint8Array(await res.arrayBuffer());
}

async function deposer(token: string, contenu: Uint8Array<ArrayBuffer>, nom = "recue.pdf") {
  const res = await fetch(new URL(`/v1/factures-recues?nom=${nom}`, server.url), {
    method: "POST",
    headers: { "content-type": "application/pdf", authorization: `Bearer ${token}` },
    body: contenu,
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
  date: new Date().toISOString().slice(0, 10),
  client: { nom: "Beta SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [{ designation: "Conseil", quantite: 2, prixUnitaireHtCents: 45000, tva: 200 }],
  datePrestation: "2026-10-15",
  echeance: "2099-12-31",
};

test("Factur-X émis par un tenant, reçu par un autre : lu, validé, isolé", async () => {
  const a = (await api("/v1/auth/inscription", "", { body: inscription("fa@exemple.fr", "Alpha") })).body.session;
  const b = (await api("/v1/auth/inscription", "", { body: inscription("fb@exemple.fr", "Beta") })).body.session;

  const d = await api("/v1/documents", a, { body: facture });
  const e = await api(`/v1/documents/${d.body.id}/emettre`, a, { body: {} });
  expect(e.status).toBe(200);
  const fx = await octets(`/v1/documents/${d.body.id}/pdf`, a);

  const r = await deposer(b, fx, "F-2026-0001.pdf");
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({
    canal: "api",
    source: "facturx",
    statut: "validee",
    anomalies: [],
    fournisseur: "Alpha",
    siren: "732829320",
    numero: e.body.numero,
    ttcCents: 108000,
    doublon: false,
  });
  expect(r.body.facture.lignes).toEqual([
    { designation: "Conseil", quantite: 2, prixUnitaireHtCents: 45000, tauxTva: 200, htCents: 90000 },
  ]);

  // Même fichier : pas de doublon.
  const bis = await deposer(b, fx);
  expect(bis.status).toBe(200);
  expect(bis.body).toMatchObject({ id: r.body.id, doublon: true });
  expect(await octets(`/v1/factures-recues/${r.body.id}/fichier`, b)).toEqual(fx);

  // Isolation : A ne voit pas les factures reçues par B ; le même fichier déposé chez A est une autre ligne.
  expect((await api("/v1/factures-recues", a)).body).toEqual([]);
  expect((await api(`/v1/factures-recues/${r.body.id}`, a)).status).toBe(404);
  expect((await api(`/v1/factures-recues/${r.body.id}/fichier`, a)).status).toBe(404);
  expect((await api(`/v1/factures-recues/${r.body.id}/decision`, a, { body: { statut: "rejetee" } })).status).toBe(404);
  const chezA = await deposer(a, fx);
  expect(chezA.status).toBe(201);
  expect(chezA.body.id).not.toBe(r.body.id);
  expect((await api("/v1/factures-recues?statut=validee", b)).body).toHaveLength(1);
  expect((await api("/v1/factures-recues/pas-un-uuid", b)).status).toBe(404);
});

test("PDF sans XML : OCR + LLM, file à vérifier, correction puis validation manuelle", async () => {
  const t = (await api("/v1/auth/inscription", "", { body: inscription("fc@exemple.fr", "Gamma") })).body.session;
  const devis = await api("/v1/documents", t, { body: { ...facture, type: "devis" } });
  await api(`/v1/documents/${devis.body.id}/emettre`, t, { body: {} });
  const pdf = await octets(`/v1/documents/${devis.body.id}/pdf`, t);

  const extraite = {
    type: "facture",
    numero: "D-2026-0001",
    date: facture.date,
    echeance: null,
    datePrestation: null,
    devise: "EUR",
    fournisseur: { nom: "Gamma", siren: "732829320", siret: null, tvaIntracom: null, adresse: null },
    acheteur: null,
    lignes: [{ designation: "Conseil", quantite: 2, prixUnitaireHtCents: 45000, tauxTva: 200, htCents: 90000 }],
    totaux: { htCents: 90000, tvaCents: 18000, ttcCents: 100000 },
  };
  reponseLlm = JSON.stringify(extraite);
  const r = await deposer(t, pdf);
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ source: "ocr", statut: "a_verifier", ttcCents: 100000 });
  expect(r.body.anomalies[0]).toContain("HT + TVA ≠ TTC");
  expect(r.body.facture.echeance).toBeUndefined();
  expect((await api("/v1/factures-recues?statut=a_verifier", t)).body).toHaveLength(1);

  const corrigee = { ...r.body.facture, totaux: { htCents: 90000, tvaCents: 18000, ttcCents: 108000 } };
  const v = await api(`/v1/factures-recues/${r.body.id}/decision`, t, {
    body: { statut: "validee", facture: corrigee },
  });
  expect(v.status).toBe(200);
  expect(v.body).toMatchObject({ statut: "validee", anomalies: [], ttcCents: 108000 });
  expect(v.body.decideAt).toBeTruthy();

  const rej = await api(`/v1/factures-recues/${r.body.id}/decision`, t, {
    body: { statut: "rejetee", motif: "doublon papier" },
  });
  expect(rej.body).toMatchObject({ statut: "rejetee", motif: "doublon papier" });
  expect((await api(`/v1/factures-recues/${r.body.id}/decision`, t, { body: { statut: "validee" } })).status).toBe(409);
  expect((await api("/v1/audit/verification", t)).body.ok).toBe(true);

  // Type de contenu refusé.
  const res = await fetch(new URL("/v1/factures-recues", server.url), {
    method: "POST",
    headers: { "content-type": "image/png", authorization: `Bearer ${t}` },
    body: "x",
  });
  expect(res.status).toBe(415);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { signerLien, verifierLien } from "@auto/services/devis-public";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
const evenements: { type: string; data: unknown }[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  const routes = creerApp(sql, async (_tx, type, data) => {
    evenements.push({ type, data });
    return { id: crypto.randomUUID() };
  });
  server = Bun.serve({ port: 0, routes, fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown) {
  const res = await fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, body: type.includes("json") ? await res.json() : await res.bytes() };
}

const devis = {
  type: "devis",
  date: "2026-10-22",
  validiteJours: 30,
  client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [{ designation: "Conseil", quantite: 2, prixUnitaireHtCents: 45000, tva: 200 }],
};

async function devisEmis() {
  const a = await api("/v1/auth/inscription", undefined, {
    email: `vendeur-${crypto.randomUUID()}@exemple.fr`,
    motDePasse: "un mot de passe long",
    entreprise: { nom: "Atelier Morel", siret: "73282932000074", adresse: "1 rue A, Paris" },
  });
  const d = await api("/v1/documents", a.body.session, devis);
  return { session: a.body.session as string, id: d.body.id as string };
}

test("lien public : consultation, PDF figé, acceptation unique, signataire journalisé", async () => {
  const { session, id } = await devisEmis();
  expect((await api(`/v1/documents/${id}/lien-public`, session, {})).status).toBe(409); // brouillon
  await api(`/v1/documents/${id}/emettre`, session, {});
  const l = await api(`/v1/documents/${id}/lien-public`, session, {});
  expect(l.status).toBe(201);
  expect(l.body.url).toEndWith(`/devis/${l.body.jeton}`);

  const v = await api(`/v1/public/devis/${l.body.jeton}`);
  expect(v.body).toMatchObject({
    emetteur: "Atelier Morel",
    client: "Client SAS",
    statut: "emis",
    decidable: true,
    totaux: { htCents: 90000, tvaCents: 18000, ttcCents: 108000 },
  });
  expect(JSON.stringify(v.body)).not.toContain(id);
  const pdf = await api(`/v1/public/devis/${l.body.jeton}/pdf`);
  expect(pdf.type).toBe("application/pdf");
  expect(new TextDecoder().decode((pdf.body as Uint8Array).subarray(0, 5))).toBe("%PDF-");

  expect((await api(`/v1/public/devis/${l.body.jeton}/decision`, undefined, { decision: "accepte" })).status).toBe(422);
  const ok = await api(`/v1/public/devis/${l.body.jeton}/decision`, undefined, {
    decision: "accepte",
    nom: "Claire Dupont",
  });
  expect(ok.body).toMatchObject({ statut: "accepte", decidable: false });
  expect(evenements.at(-1)).toMatchObject({
    type: "document.statut",
    data: { id, statut: "accepte", canal: "lien", signataire: "Claire Dupont" },
  });
  const again = await api(`/v1/public/devis/${l.body.jeton}/decision`, undefined, {
    decision: "refuse",
    nom: "Claire Dupont",
  });
  expect(again.status).toBe(409);
  expect((await api(`/v1/documents/${id}`, session)).body.statut).toBe("accepte");
});

test("jetons falsifiés, expirés ou d'une autre clé : refusés", async () => {
  const { session, id } = await devisEmis();
  await api(`/v1/documents/${id}/emettre`, session, {});
  const { jeton } = (await api(`/v1/documents/${id}/lien-public`, session, {})).body;
  const [charge, sig] = jeton.split(".");
  const autre = Uint8Array.fromBase64(charge, { alphabet: "base64url" });
  autre[autre.length - 2]! ^= 1;
  for (const faux of [
    `${autre.toBase64({ alphabet: "base64url", omitPadding: true })}.${sig}`,
    `${charge}.${sig.slice(0, -2)}AA`,
    "n-importe-quoi",
    `${charge}.${sig}.x`,
  ])
    expect((await api(`/v1/public/devis/${faux}`)).status).toBe(404);

  const expire = await signerLien({ t: "t", d: id, e: Date.now() - 1 });
  expect(await verifierLien(expire)).toBeNull();
  const autreCle = await signerLien({ t: "t", d: id, e: Date.now() + 1000 }, new TextEncoder().encode("x".repeat(40)));
  expect(await verifierLien(autreCle)).toBeNull();
});

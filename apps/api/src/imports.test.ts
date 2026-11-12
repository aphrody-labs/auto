import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { lireTableur } from "@auto/native";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let jeton: string;

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
  const r = await api("/v1/auth/inscription", {
    email: "import@exemple.fr",
    motDePasse: "un mot de passe long",
    entreprise: { nom: "Import SAS", siret: "73282932000074", adresse: "1 rue A, Paris" },
  });
  jeton = r.body.session;
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

async function api(path: string, body?: unknown) {
  const res = await fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer()),
  };
}

const b64 = (s: string) => new TextEncoder().encode(s).toBase64();

test("import guidé de clients et de produits depuis un CSV", async () => {
  const csv =
    "Raison sociale;SIRET;Adresse;E-mail\nDupont SARL;73282932000074;2 rue B, Lyon;d@x.fr\n;;;\nSans adresse;;;\n";
  const ap = await api("/v1/imports/apercu", { fichier: b64(csv) });
  expect(ap.status).toBe(200);
  expect(ap.body.correspondance.clients).toEqual({ nom: 0, siret: 1, adresse: 2, email: 3 });
  const imp = await api("/v1/imports/clients", { fichier: b64(csv), correspondance: ap.body.correspondance.clients });
  expect(imp.body).toEqual({
    crees: 1,
    ignores: 0,
    erreurs: [{ ligne: 4, message: "client : nom et adresse obligatoires" }],
  });
  const encore = await api("/v1/imports/clients", {
    fichier: b64(csv),
    correspondance: ap.body.correspondance.clients,
  });
  expect(encore.body.ignores).toBe(1);

  const prod = "Désignation;Prix HT;TVA\nConseil;850,00;20 %\nLivre;12.5;5,5\nErreur;abc;20\n";
  const corr = (await api("/v1/imports/apercu", { fichier: b64(prod) })).body.correspondance.produits;
  const p = await api("/v1/imports/produits", { fichier: b64(prod), correspondance: corr });
  expect(p.body.crees).toBe(2);
  expect(p.body.erreurs).toEqual([{ ligne: 4, message: "prix HT illisible" }]);
  const liste = (await api("/v1/produits")).body as { designation: string; prixUnitaireHtCents: number; tva: number }[];
  expect(liste.map((x) => [x.designation, x.prixUnitaireHtCents, x.tva])).toEqual([
    ["Conseil", 85000, 200],
    ["Livre", 1250, 55],
  ]);
});

test("exports : journal des ventes, créances et FEC équilibré", async () => {
  const d = await api("/v1/documents", {
    type: "facture",
    date: "2026-10-01",
    client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Dév", quantite: 2, prixUnitaireHtCents: 50000, tva: 200 }],
    datePrestation: "2026-09-30",
    echeance: "2026-10-31",
  });
  const f = await api(`/v1/documents/${d.body.id}/emettre`, {});
  expect(f.status).toBe(200);
  await api(`/v1/documents/${d.body.id}/paiements`, { date: "2026-10-15", montantCents: 20000, mode: "virement" });

  const ventes = await api("/v1/exports/ventes.xlsx?annee=2026");
  expect(ventes.headers.get("content-disposition")).toContain("journal-ventes-2026-01-01-2026-12-31.xlsx");
  const v = lireTableur(ventes.body as Uint8Array);
  expect(v.feuilles[0]!.lignes[1]!.slice(1)).toEqual([f.body.numero, "facture", "Client SAS", 1000, 200, 1200]);

  const c = lireTableur((await api("/v1/exports/creances.xlsx?au=2026-11-10")).body as Uint8Array);
  expect(c.feuilles[0]!.lignes[1]!.slice(4)).toEqual([1200, 1000, 10]);

  const fecRep = await api("/v1/exports/fec?annee=2026");
  expect(fecRep.headers.get("content-disposition")).toContain("732829320FEC20261231.txt");
  const texte = new TextDecoder("latin1").decode(fecRep.body as Uint8Array);
  const rangs = texte
    .slice(0, -2)
    .split("\r\n")
    .map((r) => r.split("\t"));
  expect(rangs).toHaveLength(1 + 3 + 2);
  const solde = rangs
    .slice(1)
    .reduce((s, r) => s + Number(r[11]!.replace(",", ".")) - Number(r[12]!.replace(",", ".")), 0);
  expect(Math.abs(solde)).toBeLessThan(1e-9);
  expect((await api("/v1/exports/fec?du=2026-12-01&au=2026-01-01")).status).toBe(422);
});

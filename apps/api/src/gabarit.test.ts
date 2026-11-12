import { afterAll, beforeAll, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { testDb, type Sql } from "@auto/store";
import { verifierPdfA } from "@auto/native";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let jeton = "";

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
  jeton = (
    await api("POST", "/v1/auth/inscription", {
      email: "gabarit@exemple.fr",
      motDePasse: "un mot de passe long",
      entreprise: { nom: "Gabarit SAS", siret: "73282932000074", adresse: "1 rue A, Paris" },
    })
  ).json.session;
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, server.url), {
    method,
    headers: { "content-type": "application/json", ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const octets = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    octets,
    json: type.includes("json") ? JSON.parse(new TextDecoder().decode(octets)) : null,
  };
}

/** PNG RVBA minimal (largeur × hauteur, une couleur) construit à la main. */
function png(largeur: number, hauteur: number, rvba: [number, number, number, number]): Uint8Array {
  const morceau = (type: string, data: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(t, 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, largeur);
  v.setUint32(4, hauteur);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const brut = new Uint8Array(hauteur * (1 + largeur * 4));
  for (let y = 0; y < hauteur; y++) for (let x = 0; x < largeur; x++) brut.set(rvba, y * (1 + largeur * 4) + 1 + x * 4);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    morceau("IHDR", ihdr),
    // Flux zlib (en-tête 78) exigé par PNG : Bun.deflateSync de ce runtime ignore windowBits et produit du deflate brut.
    morceau("IDAT", deflateSync(brut)),
    morceau("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

const contient = (octets: Uint8Array, motif: string) => new TextDecoder("latin1").decode(octets).includes(motif);

test("gabarit : logo converti en JPEG, couleur, pied de page, Factur-X toujours PDF/A-3b", async () => {
  expect((await api("GET", "/v1/parametres/gabarit")).json).toEqual({ couleur: null, piedDePage: null, logo: null });
  expect((await api("PUT", "/v1/parametres/gabarit", { couleur: "vert" })).status).toBe(422);
  expect(
    (await api("PUT", "/v1/parametres/gabarit", { couleur: "#0F6B5C", piedDePage: "SAS au capital de 10 000 €" }))
      .status,
  ).toBe(204);
  const logo = await api("PUT", "/v1/parametres/gabarit/logo", {
    image: png(1200, 400, [15, 107, 92, 255]).toBase64(),
  });
  expect(logo.json).toEqual({ largeur: 600, hauteur: 200 });
  const jpeg = await api("GET", "/v1/parametres/gabarit/logo");
  expect([...jpeg.octets.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  expect((await api("PUT", "/v1/parametres/gabarit/logo", { image: "AAAA" })).status).toBe(422);

  const d = await api("POST", "/v1/documents", {
    type: "facture",
    date: "2026-10-22",
    client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 100000, tva: 200 }],
    datePrestation: "2026-10-15",
    echeance: "2026-11-21",
  });
  expect(d.json.data.gabarit).toBeUndefined();
  const brouillon = await api("GET", `/v1/documents/${d.json.id}/pdf`);
  expect(contient(brouillon.octets, "/DCTDecode")).toBe(true);

  expect((await api("POST", `/v1/documents/${d.json.id}/emettre`, {})).status).toBe(200);
  const fx = await api("GET", `/v1/documents/${d.json.id}/pdf`);
  expect(contient(fx.octets, "/DCTDecode")).toBe(true);
  expect(verifierPdfA(fx.octets)).toEqual([]);
});

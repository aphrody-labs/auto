import { beforeAll, afterAll, test, expect, spyOn } from "bun:test";
import { testDb, withTenant, type Sql } from "@auto/store";
import { creerDocx } from "@auto/native";
import { creerApp } from "../app";
import { synchroniserSource } from "@auto/services/sources-fichiers";
import * as sourcesService from "@auto/services/sources-fichiers";
import { reglages } from "@auto/services/ingest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
let sql: Sql,
  drop: () => Promise<void>,
  server: ReturnType<typeof Bun.serve>,
  A: any,
  B: any,
  cookie: string,
  dossier: string;
const origine = "https://auto.import.test",
  ancien = Bun.env.AUTO_DOSSIERS_RACINES;
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({
    port: 0,
    routes: creerApp(sql, undefined, { auth: { baseURL: origine } }),
    fetch: () => new Response("", { status: 404 }),
  });
  for (const email of ["import-a@example.test", "import-b@example.test"]) {
    const r = await fetch(new URL("/v1/auth/inscription", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        motDePasse: "un mot de passe très long",
        entreprise: { nom: "QA imports", siret: "73282932000074", adresse: "1 rue A" },
      }),
    });
    if (!A) {
      cookie = r.headers
        .getSetCookie()
        .find((c) => c.includes("session_token="))!
        .split(";")[0]!;
      A = await r.json();
    } else B = await r.json();
  }
  dossier = await mkdtemp(join(tmpdir(), "auto-imports-massifs-"));
  Bun.env.AUTO_DOSSIERS_RACINES = JSON.stringify({ partage: { tenantId: A.tenantId, chemin: dossier } });
});
afterAll(async () => {
  if (ancien === undefined) delete Bun.env.AUTO_DOSSIERS_RACINES;
  else Bun.env.AUTO_DOSSIERS_RACINES = ancien;
  await server?.stop(true);
  await drop?.();
  if (dossier && relative(resolve(tmpdir()), resolve(dossier)).startsWith("auto-imports-massifs-"))
    await rm(dossier, { recursive: true, force: true });
});
function form(
  nom = "controle.txt",
  chemin = "Dossier/" + nom,
  segment = "fournisseurs",
  cible = "index",
  bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode("Contenu de controle"),
) {
  const f = new FormData();
  f.set("fichier", new File([bytes], nom));
  f.set("cheminRelatif", chemin);
  f.set("segment", segment);
  f.set("cible", cible);
  return f;
}
async function poster(f: FormData, headers: Record<string, string> = {}) {
  return fetch(new URL("/v1/imports-fichiers", server.url), {
    method: "POST",
    headers: { authorization: "Bearer " + A.session, "x-auto-import": "1", origin: origine, ...headers },
    body: f,
  });
}
async function get(path: string, token = A.session) {
  const r = await fetch(new URL(path, server.url), { headers: { authorization: "Bearer " + token } });
  return { statut: r.status, body: (await r.json()) as any };
}
test("multipart : originaux immuables, chemin conservé, reprise dédupliquée et concurrence atomique", async () => {
  const r = await poster(form());
  expect(r.status).toBe(201);
  const d: any = await r.json();
  expect(d).toMatchObject({
    nom: "controle.txt",
    cheminRelatif: "Dossier/controle.txt",
    segment: "fournisseurs",
    doublon: false,
  });
  const rep = await poster(form());
  expect(await rep.json()).toMatchObject({ id: d.id, fichierId: d.fichierId, doublon: true });
  const fichier = await fetch(new URL("/v1/fichiers-indexes/" + d.id + "/fichier", server.url), {
    headers: { authorization: "Bearer " + A.session },
  });
  expect(await fichier.text()).toBe("Contenu de controle");
  expect((await get("/v1/fichiers-indexes", B.session)).body).toHaveLength(0);
  expect(
    (
      await fetch(new URL("/v1/fichiers-indexes/" + d.id + "/fichier", server.url), {
        headers: { authorization: "Bearer " + B.session },
      })
    ).status,
  ).toBe(404);
  const doublons = await Promise.all([poster(form("concurrent.txt")), poster(form("concurrent.txt"))]);
  expect(doublons.map((r) => r.status)).toEqual([201, 201]);
  const corps = await Promise.all(doublons.map((r) => r.json() as Promise<any>));
  expect(corps.map((d) => d.doublon).sort()).toEqual([false, true]);
  expect(corps[0].id).toBe(corps[1].id);
  expect((await get("/v1/sources-fichiers")).body).toHaveLength(0);
});
test("multipart : CSRF étroit, Bearer sans Origin, traversée/SSRF/tailles et extractions hors segment refusées", async () => {
  const sansOrigin = await fetch(new URL("/v1/imports-fichiers", server.url), {
    method: "POST",
    headers: { authorization: "Bearer " + A.session, "x-auto-import": "1" },
    body: form("cli.txt"),
  });
  expect(sansOrigin.status).toBe(201);
  for (const headers of [{ origin: "https://evil.test" }, { "x-auto-import": "0" }] as Record<string, string>[])
    expect((await poster(form(), headers)).status).toBe(403);
  expect(
    (
      await fetch(new URL("/v1/imports-fichiers", server.url), {
        method: "POST",
        headers: { cookie, "x-auto-import": "1" },
        body: form(),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(new URL("/v1/imports-fichiers", server.url), {
        method: "POST",
        headers: { cookie, origin: origine },
        body: form(),
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await fetch(new URL("/v1/imports-fichiers", server.url), {
        method: "POST",
        headers: { cookie, origin: origine, "x-auto-import": "1" },
        body: form("cookie.txt"),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await fetch(new URL("/v1/clients", server.url), {
        method: "POST",
        headers: { cookie, origin: origine, "x-auto-import": "1" },
        body: form(),
      })
    ).status,
  ).toBe(415);
  for (const chemin of [
    "../controle.txt",
    "C:/controle.txt",
    "https://127.0.0.1/controle.txt",
    "//serveur/controle.txt",
  ])
    expect((await poster(form("controle.txt", chemin))).status).toBe(422);
  expect((await poster(form("mauvais.exe"))).status).toBe(422);
  expect((await poster(form("scan.pdf", "scan.pdf", "clients", "devis"))).status).toBe(403);
  const double = form();
  double.append("fichier", new File(["autre"], "autre.txt"));
  expect((await poster(double)).status).toBe(422);
  expect(
    (await poster(form("gros.txt", "gros.txt", "fournisseurs", "index", new Uint8Array(20 * 1024 * 1024 + 1)))).status,
  ).toBe(413);
});

test("reprise : un doublon est retrouvé avant tout OCR ou parsing, et un devis Word garde ses octets", async () => {
  const parse = spyOn(sourcesService, "texteDocument").mockRejectedValue(new Error("parse indisponible"));
  try {
    expect(await (await poster(form())).json()).toMatchObject({ doublon: true });
    expect(parse).not.toHaveBeenCalled();
    expect((await poster(form("nouveau-parse.txt"))).status).toBe(422);
  } finally {
    parse.mockRestore();
  }
  const avantLlm = reglages.llm;
  try {
    reglages.llm = () => null;
    const docx = creerDocx({
      titre: "Devis de contrôle",
      paragraphes: [{ texte: "Devis fournisseur pour le chantier de contrôle, 600 euros TTC." }],
    });
    const r = await poster(form("devis.docx", "Lot/devis.docx", "fournisseurs", "devis", docx));
    expect(r.status).toBe(201);
    const d: any = await r.json();
    expect(d.devisId).toBeTruthy();
    const original = await fetch(new URL("/v1/devis-recus/" + d.devisId + "/fichier", server.url), {
      headers: { authorization: "Bearer " + A.session },
    });
    expect(await original.bytes()).toEqual(docx);
  } finally {
    reglages.llm = avantLlm;
  }
});
test("sources distantes : curseur persistant sur plusieurs relèves, tri par segments, nouveau cycle et remise à zéro", async () => {
  await mkdir(join(dossier, "a"));
  await mkdir(join(dossier, "b"));
  for (const p of ["a/1.txt", "a/2.txt", "a.txt", "b/1.txt", "z.txt"])
    await Bun.write(join(dossier, p), "controle " + p);
  const r = await fetch(new URL("/v1/sources-fichiers", server.url), {
    method: "POST",
    headers: { authorization: "Bearer " + A.session, "content-type": "application/json" },
    body: JSON.stringify({
      nom: "Partage massif",
      racine: "partage",
      sousDossier: "",
      segment: "chantiers",
      traitement: "index",
      actif: true,
    }),
  });
  const s: any = await r.json();
  expect(r.status).toBe(201);
  let nouveaux = 0,
    limites = 0;
  for (let n = 0; n < 10; n++) {
    const b = await synchroniserSource(sql, A.tenantId, s.id, A.userId, undefined, { limite: 2 });
    nouveaux += b.nouveaux;
    expect(b.erreurs).toEqual([]);
    const [stocke] = await withTenant(
      sql,
      A.tenantId,
      (tx) => tx`SELECT curseur FROM source_fichiers WHERE id=${s.id}`,
    );
    expect(stocke!.curseur).toBe(b.curseur);
    if (!b.limiteAtteinte) break;
    limites++;
  }
  expect(nouveaux).toBe(5);
  expect(limites).toBeGreaterThan(1);
  await Bun.write(join(dossier, "000.txt"), "nouveau avant ancien curseur");
  const prochain = await synchroniserSource(sql, A.tenantId, s.id, A.userId, undefined, { limite: 2 });
  expect(prochain.nouveaux).toBe(1);
  expect(prochain.limiteAtteinte).toBe(true);
  const m = await fetch(new URL("/v1/sources-fichiers/" + s.id, server.url), {
    method: "PUT",
    headers: { authorization: "Bearer " + A.session, "content-type": "application/json" },
    body: JSON.stringify({ ...s, nom: "Partage renommé" }),
  });
  expect(m.status).toBe(200);
  expect(((await m.json()) as any).curseur).toBeNull();
});
test("pagination : retrouve les fichiers au-delà des 500, filtre SQL et reste segmentée", async () => {
  const r: any = await (await poster(form("graine.txt", "Archive/graine.txt", "chantiers"))).json();
  await withTenant(sql, A.tenantId, async (tx) => {
    const [f] = await tx`SELECT source_id,empreinte FROM fichier_indexe WHERE id=${r.id}`;
    await tx`INSERT INTO fichier_indexe(source_id,fichier_id,chemin,nom,segment,texte,empreinte) SELECT ${f!.source_id},${r.fichierId},'Archive/'||g||'.txt',g||'.txt','chantiers','ARCHIVE MASSIVE',${f!.empreinte} FROM generate_series(1,505) g`;
  });
  expect((await get("/v1/fichiers-indexes")).body).toHaveLength(500);
  const p1 = (await get("/v1/fichiers-indexes/recherche?q=ARCHIVE%20MASSIVE&page=1")).body;
  expect(p1.fichiers).toHaveLength(100);
  expect(p1.suite).toBe(true);
  const p6 = (await get("/v1/fichiers-indexes/recherche?q=ARCHIVE%20MASSIVE&page=6")).body;
  expect(p6.fichiers).toHaveLength(5);
  expect(p6.suite).toBe(false);
  expect((await get("/v1/fichiers-indexes/recherche?q=ARCHIVE", B.session)).body.fichiers).toEqual([]);
  expect((await get("/v1/fichiers-indexes/recherche?page=0")).statut).toBe(422);
});

test("même entreprise : import, recherche et téléchargement respectent les segments du membre", async () => {
  await sql`INSERT INTO membership(tenant_id,user_id,role) VALUES (${A.tenantId},${B.userId},'comptable')`;
  await sql`UPDATE session SET active_organization_id=${A.tenantId} WHERE token=${B.session}`;
  await sql`INSERT INTO membre_segments(tenant_id,user_id,segments) VALUES (${A.tenantId},${B.userId},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(["clients"])}::text::jsonb)))`;
  expect((await poster(form("refuse.txt"), { authorization: "Bearer " + B.session })).status).toBe(403);
  expect((await get("/v1/fichiers-indexes/recherche?q=ARCHIVE", B.session)).body.fichiers).toEqual([]);
  const acces = await poster(form("autorise.txt", "Clients/autorise.txt", "clients"), {
    authorization: "Bearer " + B.session,
  });
  expect(acces.status).toBe(201);
  expect((await get("/v1/fichiers-indexes/recherche?q=autorise", B.session)).body.fichiers).toHaveLength(1);
  const tous = (await get("/v1/fichiers-indexes")).body;
  const prive = tous.find((f: any) => f.segment !== "clients");
  expect(
    (
      await fetch(new URL("/v1/fichiers-indexes/" + prive.id + "/fichier", server.url), {
        headers: { authorization: "Bearer " + B.session },
      })
    ).status,
  ).toBe(404);
});

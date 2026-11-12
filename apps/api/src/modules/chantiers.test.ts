import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "../app";
import { lireTableur, textePdf } from "@auto/native";
let sql: Sql,
  drop: () => Promise<void>,
  server: ReturnType<typeof Bun.serve>,
  session: string,
  tenantId: string,
  userId: string;
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
  const a = await api("/v1/auth/inscription", "POST", {
    email: "chantier-api@exemple.fr",
    motDePasse: "un mot de passe très long",
    entreprise: { nom: "Test chantier", siret: "73282932000074", adresse: "1 rue A" },
  });
  session = a.body.session;
  tenantId = a.body.tenantId;
  userId = a.body.userId;
});
afterAll(async () => {
  await server?.stop(true);
  if (drop) await drop();
});
async function api(path: string, method = "GET", body?: unknown, token?: string) {
  const r = await fetch(new URL(path, server.url), {
    method,
    headers: {
      "content-type": "application/json",
      ...((token ?? session) ? { authorization: "Bearer " + (token ?? session) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
}
const ligne = { designation: "Prestation", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 };
test("API authentifiée, documents préremplis affectés atomiquement et conservation du rattachement", async () => {
  const client = (await api("/v1/clients", "POST", { nom: "Client", adresse: "2 rue B", siret: "" })).body;
  const c = await api("/v1/chantiers", "POST", {
    nom: "Villa",
    code: "CH-001",
    clientId: client.id,
    budgetHtCents: 100000,
    avancement: 0,
    statut: "en_cours",
  });
  expect(c.status).toBe(201);
  const b = { type: "devis", clientId: client.id, chantierId: c.body.id, lignes: [ligne] };
  const d = await api("/v1/documents", "POST", b);
  expect(d.status).toBe(201);
  expect(d.body.data.client.nom).toBe("Client");
  expect(d.body.data.chantierId).toBeUndefined();
  expect((await api("/v1/documents/" + d.body.id + "/chantier")).body.chantierId).toBe(c.body.id);
  const mod = await api("/v1/documents/" + d.body.id, "PUT", { ...b, chantierId: undefined });
  expect(mod.status).toBe(200);
  expect((await api("/v1/chantiers/" + c.body.id)).body.documents).toHaveLength(1);
  const mauvais = await api("/v1/documents", "POST", { ...b, chantierId: crypto.randomUUID() });
  expect(mauvais.status).toBe(404);
  expect((await api("/v1/documents")).body).toHaveLength(1);
  expect((await api("/v1/fournisseurs", "POST", { nom: "Partenaire" })).status).toBe(201);
  expect((await api("/v1/fournisseurs")).body[0].nom).toBe("Partenaire");
});
test("identifiants invalides et mutations en lecture seule refusés", async () => {
  expect((await api("/v1/chantiers/invalide")).status).toBe(422);
  await sql`UPDATE membership SET role='lecture' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
  expect((await api("/v1/fournisseurs")).status).toBe(200);
  expect((await api("/v1/fournisseurs", "POST", { nom: "Interdit" })).status).toBe(403);
  expect((await api("/v1/pieces-chantier", "POST", {})).status).toBe(403);
  expect((await api("/v1/chantiers", "POST", {})).status).toBe(403);
  await sql`UPDATE membership SET role='owner' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
});

test("cinq onglets Excel, rapport PDF et recherche des archives isolée par entreprise", async () => {
  const c = (await api("/v1/chantiers")).body[0];
  const f = (await api("/v1/fournisseurs")).body[0];
  expect(
    (
      await api("/v1/pieces-chantier", "POST", {
        type: "bon_livraison",
        reference: "BL-ARCHIVE",
        fournisseurId: f.id,
        chantierId: c.id,
        date: "2026-10-24",
        statut: "valide",
        archive: true,
        lignes: [ligne],
      })
    ).status,
  ).toBe(201);
  const recherche = await api("/v1/recherche-gestion?q=BL-ARCHIVE");
  expect(recherche.status).toBe(200);
  expect(recherche.body.resultats).toHaveLength(1);
  expect(recherche.body.resultats[0].archive).toBe(true);
  const getFile = async (path: string) => {
    const r = await fetch(new URL(path, server.url), { headers: { authorization: "Bearer " + session } });
    expect(r.status).toBe(200);
    return new Uint8Array(await r.arrayBuffer());
  };
  const classeur = lireTableur(await getFile("/v1/exports/gestion.xlsx"));
  expect(classeur.feuilles.map((f) => f.nom)).toEqual([
    "Comptabilité fournisseurs",
    "Comptabilité clients",
    "Analytique chantiers",
    "Bons de livraison",
    "Confirmations de commande",
  ]);
  expect(classeur.feuilles[3]!.lignes[1]![0]).toBe("BL-ARCHIVE");
  expect(classeur.feuilles[3]!.lignes[1]![6]).toBe(100);
  expect(textePdf(await getFile("/v1/exports/gestion.pdf")).join("\n")).toContain("Bons de livraison");
  const autre = await api(
    "/v1/auth/inscription",
    "POST",
    {
      email: "chantier-autre@exemple.fr",
      motDePasse: "un mot de passe très long",
      entreprise: { nom: "Autre", siret: "73282932000074", adresse: "Autre adresse" },
    },
    "",
  );
  expect((await api("/v1/recherche-gestion?q=BL-ARCHIVE", "GET", undefined, autre.body.session)).body.total).toBe(0);
});

import { beforeAll, afterAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { creerDocx, rendrePdf, ecrireXlsx, lireTableur } from "@auto/native";
import { authDe, bearer } from "@auto/tenancy";
import { creerApp } from "../app";
let sql: Sql, drop: () => Promise<void>, server: ReturnType<typeof Bun.serve>, A: any, B: any;
async function appel(path: string, token = A?.session, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(new URL(path, server.url), {
    method,
    headers: { ...Object.fromEntries(bearer(token ?? "")), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("", { status: 404 }) });
  for (const email of ["atelier-a@exemple.fr", "atelier-b@exemple.fr"]) {
    const r = await appel("/v1/auth/inscription", "", {
      email,
      motDePasse: "un mot de passe très long",
      entreprise: { nom: email, siret: "73282932000074", adresse: "1 rue A" },
    });
    if (!A) A = r.body;
    else B = r.body;
  }
});
afterAll(async () => {
  await server?.stop(true);
  if (drop) await drop();
});
test("atelier Excel : formules natives, conflit concurrent, versions et restauration", async () => {
  const d = (await appel("/v1/atelier", A.session, { format: "excel", nom: "Chantier.xlsx", segment: "chantiers" }))
    .body;
  expect(d.revision).toBe(1);
  const edite = await appel(`/v1/atelier/${d.id}/operations`, A.session, {
    revision: 1,
    operation: {
      type: "cellules",
      editions: [
        { feuille: "Feuille 1", ligne: 2, colonne: 1, valeur: 2 },
        { feuille: "Feuille 1", ligne: 2, colonne: 2, valeur: 3 },
        { feuille: "Feuille 1", ligne: 2, colonne: 3, formule: "=A2+B2" },
      ],
    },
  });
  expect(edite.status).toBe(200);
  expect(edite.body.revision).toBe(2);
  expect((await appel(`/v1/atelier/${d.id}`)).body.inspection.feuilles[0].apercu[1]).toEqual([2, 3, 5]);
  const x = (n: number) =>
    ecrireXlsx({ feuilles: [{ nom: "Nouvelle", colonnes: [{ titre: "Valeur" }], lignes: [[n]] }] }).toBase64();
  const concurrents = await Promise.all([
    appel(`/v1/atelier/${d.id}/fichier`, A.session, { revision: 2, fichier: x(10) }, "PUT"),
    appel(`/v1/atelier/${d.id}/fichier`, A.session, { revision: 2, fichier: x(20) }, "PUT"),
  ]);
  expect(concurrents.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await appel(`/v1/atelier/${d.id}/versions`)).body.map((r: any) => r.revision)).toEqual([3, 2, 1]);
  expect((await appel(`/v1/atelier/${d.id}/restaurer`, A.session, { revision: 3, version: 2 })).body.revision).toBe(4);
  const original = await fetch(new URL(`/v1/atelier/${d.id}/fichier?revision=1`, server.url), {
    headers: bearer(A.session),
  });
  expect(original.headers.get("etag")).toBe('"1"');
  expect(lireTableur(new Uint8Array(await original.arrayBuffer())).feuilles[0]!.nom).toBe("Feuille 1");
  expect((await appel(`/v1/atelier/${d.id}`, B.session)).status).toBe(404);
  expect((await appel(`/v1/atelier/${d.id}`, A.session, { archive: true }, "PATCH")).body.archive).toBe(true);
  expect((await appel(`/v1/atelier/${d.id}/restaurer`, A.session, { revision: 4, version: 1 })).status).toBe(409);
});
test("atelier Word : remplacement natif, gabarit et export PDF", async () => {
  const original = creerDocx({ titre: "Courrier", paragraphes: [{ texte: "Bonjour Client, chantier {{code}}." }] });
  const r = await appel("/v1/atelier/importer", A.session, {
    nom: "Courrier.docx",
    segment: "clients",
    fichier: original.toBase64(),
  });
  expect(r.status).toBe(201);
  const d = r.body;
  expect(
    (
      await appel(`/v1/atelier/${d.id}/operations`, A.session, {
        revision: 1,
        operation: { type: "remplacer", remplacements: [{ chercher: "Client", remplacer: "Moreau" }] },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await appel(`/v1/atelier/${d.id}/operations`, A.session, {
        revision: 2,
        operation: { type: "champs", valeurs: { code: "CH-001" } },
      })
    ).status,
  ).toBe(200);
  expect((await appel(`/v1/atelier/${d.id}`)).body.inspection.extrait).toContain("Bonjour Moreau, chantier CH-001.");
  const pdf = await fetch(new URL(`/v1/atelier/${d.id}/export.pdf`, server.url), { headers: bearer(A.session) });
  expect(pdf.status).toBe(200);
  expect((await pdf.text()).startsWith("%PDF-")).toBe(true);
});
test("atelier PDF et segments : pièces illisibles refusées, consultations et modifications cloisonnées", async () => {
  const pdf = rendrePdf({
    type: "devis",
    numero: "D-TEST",
    date: "2026-10-25",
    emetteur: { nom: "Atelier", siret: "73282932000074", adresse: "1 rue A" },
    client: { nom: "Client", siret: "", adresse: "2 rue B" },
    lignes: [{ designation: "Travaux", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
  });
  const d = (
    await appel("/v1/atelier/importer", A.session, {
      nom: "Plan.pdf",
      segment: "fournisseurs",
      fichier: pdf.toBase64(),
    })
  ).body;
  expect(d.id).toBeTruthy();
  expect(
    (
      await appel(`/v1/atelier/${d.id}/operations`, A.session, {
        revision: 1,
        operation: { type: "pages", pages: [500] },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await appel("/v1/atelier/importer", A.session, {
        nom: "faux.pdf",
        segment: "clients",
        fichier: new TextEncoder().encode("faux").toBase64(),
      })
    ).status,
  ).toBe(422);
  await sql`INSERT INTO membership(tenant_id,user_id,role) VALUES (${A.tenantId},${B.userId},'comptable')`;
  await authDe(sql).api.setActiveOrganization({ headers: bearer(B.session), body: { organizationId: A.tenantId } });
  await sql`INSERT INTO membre_segments(tenant_id,user_id,segments) VALUES (${A.tenantId},${B.userId},${["clients"]}::text[])`;
  expect((await appel(`/v1/atelier/${d.id}`, B.session)).status).toBe(404);
  expect((await fetch(new URL(`/v1/atelier/${d.id}/fichier`, server.url), { headers: bearer(B.session) })).status).toBe(
    404,
  );
  expect((await appel(`/v1/atelier/${d.id}/versions`, B.session)).status).toBe(404);
  expect((await appel("/v1/atelier", B.session, { format: "word", segment: "fournisseurs" })).status).toBe(403);
  const visible = (await appel("/v1/atelier", B.session)).body;
  expect(visible.every((x: any) => x.segment === "clients")).toBe(true);
  await sql`UPDATE membership SET role='lecture' WHERE tenant_id=${A.tenantId} AND user_id=${B.userId}`;
  expect((await appel("/v1/atelier", B.session, { format: "word", segment: "clients" })).status).toBe(403);
});

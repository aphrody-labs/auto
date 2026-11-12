import { afterAll, beforeAll, expect, test } from "bun:test";
import { EN_TETE_ID, SIGNATURE, signer, type Evenement } from "@auto/services";
import { ajouterEvenement, avecWorker, lireEvenement, testDb, withTenant, type Sql } from "@auto/store";
import { expediteur } from "./expediteur";
import { creerWorker } from "./worker";

const SECRET = "s3cret";
let sql: Sql;
let drop: () => Promise<void>;
let A: string;

/** Récepteur local : réponses programmées (statuts successifs), puis 204. */
function recepteur(port = 0) {
  const recus: { corps: string; signature: string | null; id: string | null }[] = [];
  const reponses: number[] = [];
  const server = Bun.serve({
    port,
    routes: {
      "/hook": {
        POST: async (req) => {
          recus.push({
            corps: await req.text(),
            signature: req.headers.get(SIGNATURE),
            id: req.headers.get(EN_TETE_ID),
          });
          return new Response(null, { status: reponses.shift() ?? 204 });
        },
      },
    },
  });
  return { server, recus, reponses, url: new URL("/hook", server.url).href };
}

const publier = (type: string, data: unknown, maxEssais?: number) =>
  withTenant(sql, A, (tx) => ajouterEvenement(tx, type, data, maxEssais));

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  [{ id: A }] = (await sql`INSERT INTO tenant (nom, siren, siret) VALUES ('A', '732829320', '73282932000074')
    RETURNING id`) as unknown as [{ id: string }];
});

afterAll(() => drop());

// Chaque test part d'une file vide : les jobs des tests précédents sont clos.
const purger = () => avecWorker(sql, (tx) => tx`UPDATE job SET statut = 'fait' WHERE statut <> 'fait'`);

test("livraison signée, marquée livrée, une seule fois", async () => {
  await purger();
  const r = recepteur();
  const w = creerWorker(sql, expediteur(sql, { url: r.url, secret: SECRET }));
  const { id, corps } = await publier("document.emis", { numero: "F-2026-0001" });
  expect(await w.vider()).toBe(1);
  expect(r.recus).toEqual([{ corps, signature: signer(SECRET, corps), id }]);
  expect((JSON.parse(corps) as Evenement).type).toBe("document.emis");
  expect(await lireEvenement(sql, id)).toMatchObject({ statut: "livre", essais: 1 });
  expect(await w.vider()).toBe(0);
  r.server.stop(true);
});

test("récepteur en erreur : nouvel essai, même événement et même signature", async () => {
  await purger();
  const r = recepteur();
  r.reponses.push(500, 502);
  const w = creerWorker(sql, expediteur(sql, { url: r.url, secret: SECRET }), { delai: () => 0 });
  const { id } = await publier("paiement.enregistre", { resteCents: 0 });
  await w.vider();
  expect(r.recus.length).toBe(3);
  expect(new Set(r.recus.map((x) => `${x.id}|${x.signature}|${x.corps}`)).size).toBe(1);
  expect(await lireEvenement(sql, id)).toMatchObject({ statut: "livre", essais: 3, derniereErreur: null });
  r.server.stop(true);
});

test("récepteur arrêté : rien n'est perdu, livraison à son retour", async () => {
  await purger();
  const ancien = recepteur();
  const port = ancien.server.port!;
  ancien.server.stop(true);
  const w = creerWorker(sql, expediteur(sql, { url: ancien.url, secret: SECRET, timeoutMs: 2_000 }), {
    delai: () => 100,
  });
  const { id, corps } = await publier("absence.demandee", { id: "x" });
  expect(await w.vider()).toBe(1);
  const e = await lireEvenement(sql, id);
  expect(e).toMatchObject({ statut: "a_livrer", essais: 1 });
  expect(e?.derniereErreur).toBeTruthy();

  const r = recepteur(port);
  await Bun.sleep(150);
  expect(await w.vider()).toBe(1);
  expect(r.recus.map((x) => x.corps)).toEqual([corps]);
  expect(await lireEvenement(sql, id)).toMatchObject({ statut: "livre", essais: 2 });
  r.server.stop(true);
});

test("essais épuisés : événement en échec, conservé", async () => {
  await purger();
  const r = recepteur();
  r.reponses.push(500, 500, 500);
  const w = creerWorker(sql, expediteur(sql, { url: r.url, secret: SECRET }), { delai: () => 0 });
  const { id } = await publier("absence.decidee", {}, 2);
  await w.vider();
  expect(r.recus.length).toBe(2);
  expect(await lireEvenement(sql, id)).toMatchObject({ statut: "echec", derniereErreur: "HTTP 500" });
  r.server.stop(true);
});

test("boucle en arrière-plan : livre les événements publiés après le démarrage", async () => {
  await purger();
  const r = recepteur();
  const w = creerWorker(sql, expediteur(sql, { url: r.url, secret: SECRET }), { intervalleMs: 20 });
  w.demarrer();
  const { id } = await publier("document.statut", {});
  const fin = Date.now() + 5_000;
  while ((await lireEvenement(sql, id))?.statut !== "livre" && Date.now() < fin) await Bun.sleep(20);
  await w.arreter();
  expect((await lireEvenement(sql, id))?.statut).toBe("livre");
  r.server.stop(true);
});

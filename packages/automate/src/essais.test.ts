// Nouveaux essais par nœud (« Retry On Fail » de n8n) : reprise d'un service momentanément en échec, attente doublée,
// abandon après le dernier essai, aucune reprise d'une erreur de paramètres.
import { expect, test } from "bun:test";
import { executer, importerN8n, valider, type Services } from "./index";

function services(echecs: number) {
  const appels: number[] = [];
  const s: Services = {
    async fetch() {
      appels.push(performance.now());
      if (appels.length <= echecs) return new Response("indisponible", { status: 503 });
      return Response.json({ ok: true });
    },
    async appelerAuto() {
      return { statut: 200, corps: null };
    },
    async envoyerMail() {},
  };
  return { s, appels };
}

const definition = (tentatives: number, parametres: Record<string, unknown> = { url: "https://api.exemple.fr/x" }) =>
  valider({
    noeuds: [
      { id: "d", type: "declencheur.manuel", nom: "D", position: [0, 0], parametres: {} },
      { id: "h", type: "reseau.http", nom: "H", position: [1, 0], parametres, tentatives, delaiEssaiMs: 20 },
    ],
    connexions: [{ de: "d", vers: "h", sortie: 0 }],
  });

const lancer = (def: ReturnType<typeof definition>, s: Services) =>
  executer(def, [], { services: s, workflow: { id: "w", nom: "W" }, executionId: "e" });

test("un service en échec deux fois réussit au troisième essai, attente doublée", async () => {
  const { s, appels } = services(2);
  const r = await lancer(definition(2), s);
  expect(r.statut).toBe("succes");
  expect(appels).toHaveLength(3);
  expect(appels[1]! - appels[0]!).toBeGreaterThanOrEqual(18);
  expect(appels[2]! - appels[1]!).toBeGreaterThanOrEqual(38);
});

test("après le dernier essai, l'erreur du service arrête l'exécution", async () => {
  const { s, appels } = services(10);
  const r = await lancer(definition(1), s);
  expect(r.statut).toBe("erreur");
  expect(r.erreur?.message).toContain("503");
  expect(appels).toHaveLength(2);
});

test("sans nouvel essai, un seul appel", async () => {
  const { s, appels } = services(1);
  expect((await lancer(definition(0), s)).statut).toBe("erreur");
  expect(appels).toHaveLength(1);
});

test("une erreur de paramètres n'est jamais réessayée", async () => {
  const { s, appels } = services(0);
  const r = await lancer(definition(5, { url: "{{ $json.absent }}" }), s);
  expect(r.statut).toBe("erreur");
  expect(appels).toHaveLength(0);
});

test("import n8n : Retry On Fail devient des nouveaux essais", () => {
  const { definition: d } = importerN8n({
    nodes: [
      { name: "Début", type: "n8n-nodes-base.manualTrigger", parameters: {}, position: [0, 0] },
      {
        name: "Appel",
        type: "n8n-nodes-base.httpRequest",
        parameters: { url: "https://api.exemple.fr" },
        position: [200, 0],
        retryOnFail: true,
        maxTries: 4,
        waitBetweenTries: 2000,
      },
      { name: "Sans", type: "n8n-nodes-base.httpRequest", parameters: { url: "https://b.fr" }, position: [400, 0] },
    ],
    connections: {
      Début: { main: [[{ node: "Appel" }]] },
      Appel: { main: [[{ node: "Sans" }]] },
    },
  });
  const parNom = new Map(d.noeuds.map((n) => [n.nom, n]));
  expect([parNom.get("Appel")!.tentatives, parNom.get("Appel")!.delaiEssaiMs]).toEqual([3, 2000]);
  expect(parNom.get("Sans")!.tentatives).toBe(0);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { clientOpenAi, type AppelOutil, type ClientLlm, type Message, type Requete } from "@auto/ingest/llm";
import { executerAgent } from "./agent";
import { ApiAuto } from "./api";
import { apiDeTest } from "./test-api";
import { OUTILS } from "./outils";

let t: Awaited<ReturnType<typeof apiDeTest>>;
let A: { jeton: string };
let B: { jeton: string };
let clientId: string;

beforeAll(async () => {
  t = await apiDeTest();
  A = await t.tenant("agent-a@exemple.fr", "Alpha");
  B = await t.tenant("agent-b@exemple.fr", "Beta");
  clientId = (
    await t.appel("/v1/clients", A.jeton, { nom: "Dupont SARL", siret: "73282932000074", adresse: "3 rue C, Nantes" })
  ).id;
});
afterAll(() => t.fermer());

let n = 0;
const appel = (name: string, args: unknown): AppelOutil => ({
  id: `c${++n}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** LLM factice déterministe : chaque étape décide à partir du dernier résultat d'outil. */
function scripte(
  etapes: ((dernier: unknown, messages: Message[]) => AppelOutil[] | string)[],
): ClientLlm & { requetes: Requete[] } {
  const requetes: Requete[] = [];
  return {
    requetes,
    async completer(r) {
      requetes.push(r);
      const outils = r.messages.filter((m) => m.role === "tool");
      const dernier = outils.length ? JSON.parse(outils.at(-1)!.content) : null;
      const e = etapes[requetes.length - 1];
      if (!e) throw new Error("script épuisé");
      const s = e(dernier, r.messages);
      return typeof s === "string" ? { content: s } : { content: null, tool_calls: s };
    },
  };
}

test("boucle d'agent : chercher le client, facturer, émettre, encaisser", async () => {
  const llm = scripte([
    () => [appel("chercher_client", { q: "dupont" })],
    (clients) => [
      appel("creer_facture", {
        clientId: (clients as { id: string }[])[0]!.id,
        echeance: "2099-12-31",
        datePrestation: "2026-10-15",
        lignes: [{ designation: "Conseil", quantite: 2, prixUnitaireHtCents: 45000, tva: 200 }],
      }),
    ],
    (f) => [appel("emettre_document", { id: (f as { id: string }).id })],
    (e) => [
      appel("enregistrer_paiement", {
        id: (e as { id: string }).id,
        montantCents: (e as { ttcCents: number }).ttcCents,
      }),
    ],
    (_p, messages) => {
      const emis = JSON.parse(messages.filter((m) => m.role === "tool").at(-2)!.content as string);
      return `Facture ${emis.numero} émise et payée.`;
    },
  ]);
  const r = await executerAgent("Facture 2 jours de conseil à 450 € HT à Dupont, émets-la, elle est payée.", {
    llm,
    api: new ApiAuto(t.url, A.jeton),
  });
  expect(r.reponse).toBe("Facture F-2026-0001 émise et payée.");
  expect(r.appels.map((a) => [a.nom, a.ok])).toEqual([
    ["chercher_client", true],
    ["creer_facture", true],
    ["emettre_document", true],
    ["enregistrer_paiement", true],
  ]);
  // Le modèle reçoit le message système et les outils au format OpenAI.
  expect(llm.requetes[0]!.messages[0]!.role).toBe("system");
  expect(llm.requetes[0]!.tools!.map((o) => o.function.name)).toContain("exporter");
  const docs = await t.appel("/v1/documents", A.jeton);
  expect(docs).toEqual([expect.objectContaining({ numero: "F-2026-0001", statut: "paye", clientId })]);
});

test("isolation : le jeton du tenant B ne voit rien du tenant A via l'agent", async () => {
  const [doc] = await t.appel("/v1/documents", A.jeton);
  const llm = scripte([
    () => [
      appel("lire_document", { id: doc.id }),
      appel("lister_documents", {}),
      appel("chercher_document", { q: "dupont" }),
      appel("chercher_client", { q: "dupont" }),
      appel("enregistrer_paiement", { id: doc.id, montantCents: 100 }),
      appel("exporter", { format: "json" }),
    ],
    () => "Rien trouvé.",
  ]);
  const r = await executerAgent("Montre-moi la facture de Dupont", { llm, api: new ApiAuto(t.url, B.jeton) });
  const resultats = r.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  expect(resultats[0]).toMatchObject({ status: 404 });
  expect(resultats.slice(1, 4)).toEqual([[], [], []]);
  expect(resultats[4]).toMatchObject({ status: 404 });
  expect(resultats[5]).toEqual([]);
  expect(r.appels.map((a) => a.ok)).toEqual([false, true, true, true, false, true]);
  // Le paiement n'a pas été enregistré chez A.
  expect((await t.appel(`/v1/documents/${doc.id}/paiements`, A.jeton)).paiements).toHaveLength(1);
});

test("LLM compatible OpenAI (faux serveur HTTP) : tool_calls puis réponse", async () => {
  const corps: { messages: Message[]; tools?: unknown[] }[] = [];
  const llm = Bun.serve({
    port: 0,
    routes: {
      "/v1/chat/completions": {
        POST: async (req) => {
          const b = (await req.json()) as { messages: Message[]; tools?: unknown[] };
          corps.push(b);
          const message =
            corps.length === 1
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [appel("exporter", { format: "csv", type: "facture" })],
                }
              : { role: "assistant", content: "Export prêt." };
          return Response.json({ choices: [{ message }] });
        },
      },
    },
  });
  try {
    const r = await executerAgent("Exporte les factures", {
      llm: clientOpenAi({ url: `${llm.url}v1` }),
      api: new ApiAuto(t.url, A.jeton),
    });
    expect(r.reponse).toBe("Export prêt.");
    const outil = corps[1]!.messages.at(-1)!;
    expect(outil.role).toBe("tool");
    expect((outil as { content: string }).content).toStartWith(
      "numero;type;statut;date;echeance;client;ttcCents;id\nF-2026-0001;facture;paye;",
    );
    expect(corps[0]!.tools).toHaveLength(21);
  } finally {
    await llm.stop(true);
  }
});

test("arguments invalides, outil inconnu, plafond d'étapes", async () => {
  const boucle: ClientLlm = {
    completer: async () => ({
      content: null,
      tool_calls: [
        { id: "x", type: "function", function: { name: "inconnu", arguments: "{}" } },
        { id: "y", type: "function", function: { name: "lister_documents", arguments: "{pas du json" } },
      ],
    }),
  };
  const r = await executerAgent("boucle", { llm: boucle, api: new ApiAuto(t.url, A.jeton), maxEtapes: 2 });
  expect(r.reponse).toContain("maximal");
  expect(r.appels.every((a) => !a.ok)).toBe(true);
});

test("recherche de gestion par agent : mêmes données et isolation que le REST", async () => {
  const outil = OUTILS.find((o) => o.nom === "chercher_piece_gestion")!;
  const a = (await outil.executer(new ApiAuto(t.url, A.jeton), { q: "Dupont" })) as { total: number };
  const b = (await outil.executer(new ApiAuto(t.url, B.jeton), { q: "Dupont" })) as { total: number };
  expect(a.total).toBeGreaterThan(0);
  expect(b.total).toBe(0);
});

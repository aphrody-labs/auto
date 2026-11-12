import { expect, test } from "bun:test";
import { clientApi, ErreurApi } from "@auto/client";
import { retourSur } from "./ecrans/connexion";

interface Appel {
  url: string;
  init: RequestInit;
}

function faux(reponse: (a: Appel) => Response) {
  const appels: Appel[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const a = { url, init };
    appels.push(a);
    return reponse(a);
  }) as unknown as typeof fetch;
  return { appels, f };
}

const entetes = (a: Appel) => a.init.headers as Record<string, string>;

test("mutations en application/json (anti-CSRF), lectures sans corps, cookie même origine", async () => {
  const { appels, f } = faux(() => Response.json({ id: "d1" }, { status: 201 }));
  const api = clientApi({ fetch: f });
  await api.creerDocument({ type: "devis", date: "2026-10-22", lignes: [] });
  await api.documents("facture");
  await api.supprimerDocument("d1");
  const [post, get, del] = appels;
  expect(post!.url).toBe("/v1/documents");
  expect(post!.init.method).toBe("POST");
  expect(entetes(post!)["content-type"]).toBe("application/json");
  expect(JSON.parse(post!.init.body as string)).toMatchObject({ type: "devis" });
  expect(post!.init.credentials).toBe("same-origin");
  expect(get!.url).toBe("/v1/documents?type=facture");
  expect(get!.init.body).toBeUndefined();
  expect(entetes(get!)["content-type"]).toBeUndefined();
  expect(del!.init.method).toBe("DELETE");
  expect(entetes(del!)["content-type"]).toBe("application/json");
});

test("jeton Bearer et base d'URL", async () => {
  const { appels, f } = faux(() => Response.json({}));
  const api = clientApi({ fetch: f, base: "http://api.test", jeton: "tok" });
  await api.moi();
  expect(appels[0]!.url).toBe("http://api.test/v1/moi");
  expect(entetes(appels[0]!).authorization).toBe("Bearer tok");
  expect(api.url("/v1/documents/1/pdf")).toBe("http://api.test/v1/documents/1/pdf");
});

test("erreurs : message et détails de l'API, réseau coupé, réponse non JSON", async () => {
  const api = clientApi({
    fetch: faux(() =>
      Response.json({ erreur: "mentions manquantes", details: ["siret client invalide"] }, { status: 422 }),
    ).f,
  });
  const e = await api.emettre("x").catch((x) => x);
  expect(e).toBeInstanceOf(ErreurApi);
  expect(e).toMatchObject({ message: "mentions manquantes", status: 422, details: ["siret client invalide"] });

  const coupe = clientApi({ fetch: (async () => Promise.reject(new TypeError("réseau"))) as unknown as typeof fetch });
  expect(await coupe.moi().catch((x) => x)).toMatchObject({ status: 0 });

  const html = clientApi({ fetch: faux(() => new Response("<html>", { status: 502 })).f });
  expect(await html.moi().catch((x) => x)).toMatchObject({ message: "Erreur 502", status: 502 });

  const vide = clientApi({ fetch: faux(() => new Response(null, { status: 204 })).f });
  expect(await vide.relancer("d", 1, "mail")).toBeNull();
});

test("requêtes : paramètres vides omis, exports, gabarit", async () => {
  const { appels, f } = faux(() => Response.json([]));
  const api = clientApi({ fetch: f });
  await api.clients("");
  await api.clients("dupont & fils");
  await api.employes(true);
  await api.absences("demandee");
  await api.enregistrerGabarit({ couleur: "#123456", piedDePage: null });
  expect(appels.map((a) => a.url)).toEqual([
    "/v1/clients",
    "/v1/clients?q=dupont+%26+fils",
    "/v1/employes?tous",
    "/v1/absences?statut=demandee",
    "/v1/parametres/gabarit",
  ]);
  expect(appels.at(-1)!.init.method).toBe("PUT");
  expect(api.urlExport("ventes.xlsx", { du: "2026-01-01", au: "2026-12-31" })).toBe(
    "/v1/exports/ventes.xlsx?du=2026-01-01&au=2026-12-31",
  );
  expect(api.urlExport("creances.xlsx", { du: "2026-01-01", au: "2026-06-30" })).toBe(
    "/v1/exports/creances.xlsx?au=2026-06-30",
  );
  expect(api.urlExport("fec")).toBe("/v1/exports/fec");
});

test("retour après connexion : chemins internes seulement", () => {
  expect(retourSur("/app/factures")).toBe("/app/factures");
  expect(retourSur("https://exemple.fr")).toBe("/app");
  expect(retourSur("//exemple.fr/app")).toBe("/app");
  expect(retourSur(null)).toBe("/app");
});

test("automatisations : routes du contrat, essai sans enregistrement, erreurs 422 détaillées", async () => {
  const { appels, f } = faux((a) =>
    a.url === "/v1/automatisations/essai"
      ? Response.json(
          { erreur: "définition invalide", details: ["un et un seul déclencheur par workflow"] },
          { status: 422 },
        )
      : Response.json({ id: "w1" }),
  );
  const api = clientApi({ fetch: f });
  const definition = {
    noeuds: [
      {
        id: "d",
        type: "declencheur.manuel",
        nom: "Lancement",
        parametres: {},
        position: [0, 0] as [number, number],
        desactive: false,
        continuerSurErreur: false,
        tentatives: 0,
        delaiEssaiMs: 1000,
      },
    ],
    connexions: [],
  };
  await api.automatisations();
  await api.creerAutomatisation({ nom: "W", definition });
  await api.modifierAutomatisation("w1", { actif: true });
  await api.executerAutomatisation("w1", { a: 1 });
  await api.executionsAutomatisation("w1");
  await api.execution("x1");
  await api.webhookAutomatisation("w1");
  await api.catalogueAutomatisations();
  await api.modelesAutomatisations();
  await api.importerN8n({ nodes: [], connections: {} });
  await api.creerSecret("slack", "https://hooks");
  await api.supprimerSecret("s1");
  expect(appels.map((a) => `${a.init.method} ${a.url}`)).toEqual([
    "GET /v1/automatisations",
    "POST /v1/automatisations",
    "PUT /v1/automatisations/w1",
    "POST /v1/automatisations/w1/executer",
    "GET /v1/automatisations/w1/executions",
    "GET /v1/executions/x1",
    "GET /v1/automatisations/w1/webhook",
    "GET /v1/automatisations/catalogue",
    "GET /v1/automatisations/modeles",
    "POST /v1/automatisations/importer-n8n",
    "POST /v1/secrets",
    "DELETE /v1/secrets/s1",
  ]);
  expect(JSON.parse(appels[2]!.init.body as string)).toEqual({ actif: true });
  expect(JSON.parse(appels[3]!.init.body as string)).toEqual({ donnees: { a: 1 } });
  expect(JSON.parse(appels[9]!.init.body as string)).toEqual({ workflow: { nodes: [], connections: {} } });
  expect(JSON.parse(appels[10]!.init.body as string)).toEqual({ nom: "slack", valeur: "https://hooks" });
  const e = await api.essaiAutomatisation(definition).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurApi);
  expect(e).toMatchObject({ status: 422, details: ["un et un seul déclencheur par workflow"] });
  expect(JSON.parse(appels.at(-1)!.init.body as string)).toEqual({ definition });
});

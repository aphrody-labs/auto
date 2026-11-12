import { expect, test } from "bun:test";
import { clientApi, ErreurApi } from "./api";

test("connexion PA : absence, enregistrement et déconnexion par l'API", async () => {
  let active = false;
  let indisponible = false;
  let payload: unknown;
  const serveur = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/pa") return new Response(null, { status: 404 });
      if (req.method === "GET")
        return indisponible
          ? Response.json({ erreur: "panne" }, { status: 503 })
          : active
            ? Response.json({ plateforme: "b2brouter", webhook: "/v1/pa/webhook/test" })
            : Response.json({ erreur: "aucune plateforme" }, { status: 404 });
      if (req.method === "PUT") {
        payload = await req.json();
        active = true;
        return Response.json({ plateforme: "b2brouter" });
      }
      if (req.method === "DELETE") {
        active = false;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  });
  try {
    const client = clientApi({ base: serveur.url.origin });
    expect(await client.connexionPa()).toBeNull();
    const config = {
      plateforme: "b2brouter" as const,
      identifiants: { compte: "test", cleApi: "cle-test", secretWebhook: "secret-test" },
      mandat: { signataire: "Test", qualite: "Gérant", date: "2026-01-01", perimetre: ["emission" as const] },
    };
    await client.connecterPa(config);
    expect(payload).toEqual(config);
    expect((await client.connexionPa())?.plateforme).toBe("b2brouter");
    await client.deconnecterPa();
    expect(await client.connexionPa()).toBeNull();
    indisponible = true;
    await expect(client.connexionPa()).rejects.toBeInstanceOf(ErreurApi);
  } finally {
    await serveur.stop(true);
  }
});

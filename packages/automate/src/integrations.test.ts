// Nœuds des services libres auto-hébergeables (ntfy, Gotify, Matrix, Mastodon, Home Assistant, Nextcloud) contre un
// serveur local qui joue chaque API et enregistre les requêtes reçues.
import { afterAll, describe, expect, test } from "bun:test";
import { executer, valider, type Services } from "./index";

interface Recue {
  methode: string;
  chemin: string;
  entetes: Record<string, string>;
  corps: string;
}

const recues: Recue[] = [];
const serveur = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    recues.push({
      methode: req.method,
      chemin: decodeURIComponent(u.pathname),
      entetes: Object.fromEntries(req.headers),
      corps: await req.text(),
    });
    if (u.pathname.startsWith("/api/states/")) return Response.json({ entity_id: "light.salon", state: "on" });
    if (u.pathname === "/api/v1/statuses") return Response.json({ id: "42", url: "https://masto.test/@moi/42" });
    if (u.pathname.startsWith("/remote.php/")) return new Response(null, { status: 201 });
    if (u.pathname.startsWith("/_matrix/")) return Response.json({ event_id: "$evt" });
    if (u.pathname === "/refus") return new Response("non", { status: 403 });
    return Response.json({ id: 7 });
  },
});
afterAll(() => serveur.stop(true));
const URL_ = serveur.url.href.replace(/\/$/, "");

const services: Services = {
  fetch: (url, init) => fetch(url, init),
  async appelerAuto() {
    return { statut: 200, corps: null };
  },
  async envoyerMail() {},
};

async function lancer(type: string, parametres: Record<string, unknown>, entree = [{ json: { n: 1 } }]) {
  recues.length = 0;
  const def = valider({
    noeuds: [
      { id: "d", type: "declencheur.manuel", nom: "D", position: [0, 0], parametres: {} },
      { id: "x", type, nom: "X", position: [1, 0], parametres },
    ],
    connexions: [{ de: "d", vers: "x", sortie: 0 }],
  });
  return executer(def, entree, {
    services,
    workflow: { id: "w", nom: "W" },
    executionId: "e1",
    secrets: { jeton: "s3cret" },
  });
}

describe("services libres auto-hébergés", () => {
  test("ntfy : texte brut, en-têtes de titre, priorité, étiquettes et jeton", async () => {
    const r = await lancer("communication.ntfy", {
      serveur: URL_,
      sujet: "alertes",
      texte: "Facture {{ $json.n }} payée",
      titre: "auto",
      priorite: 4,
      etiquettes: "money",
      jeton: "{{ $secret.jeton }}",
    });
    expect(r.statut).toBe("succes");
    const q = recues[0]!;
    expect([q.methode, q.chemin, q.corps]).toEqual(["POST", "/alertes", "Facture 1 payée"]);
    expect(q.entetes).toMatchObject({ title: "auto", priority: "4", tags: "money", authorization: "Bearer s3cret" });
  });

  test("ntfy : sujet invalide refusé à la validation", async () => {
    await expect(lancer("communication.ntfy", { serveur: URL_, sujet: "a/b", texte: "x" })).rejects.toThrow();
  });

  test("Gotify : message JSON et clé d'application", async () => {
    const r = await lancer("communication.gotify", { serveur: URL_, jeton: "app", texte: "Salut", titre: "T" });
    expect(r.statut).toBe("succes");
    expect(recues[0]!.chemin).toBe("/message");
    expect(recues[0]!.entetes["x-gotify-key"]).toBe("app");
    expect(JSON.parse(recues[0]!.corps)).toEqual({ message: "Salut", priority: 5, title: "T" });
  });

  test("Matrix : PUT idempotent, même transaction pour le même élément", async () => {
    const p = { serveur: URL_, jeton: "tok", salon: "!abc:matrix.test", texte: "Bonjour" };
    await lancer("communication.matrix", p);
    const premiere = recues[0]!;
    await lancer("communication.matrix", p);
    expect(premiere.methode).toBe("PUT");
    expect(premiere.chemin).toStartWith("/_matrix/client/v3/rooms/!abc:matrix.test/send/m.room.message/auto-e1-x-");
    expect(recues[0]!.chemin).toBe(premiere.chemin);
    expect(JSON.parse(premiere.corps)).toEqual({ msgtype: "m.text", body: "Bonjour" });
    expect(premiere.entetes.authorization).toBe("Bearer tok");
  });

  test("Mastodon : statut, visibilité et clé d'idempotence ; identifiant et URL en sortie", async () => {
    const r = await lancer("communication.mastodon", { instance: URL_, jeton: "tok", texte: "Nouveau billet" });
    expect(r.statut).toBe("succes");
    expect(JSON.parse(recues[0]!.corps)).toEqual({ status: "Nouveau billet", visibility: "unlisted" });
    expect(recues[0]!.entetes["idempotency-key"]).toStartWith("auto-e1-x-");
    expect(r.sortie[0]!.json.mastodon).toEqual({ id: "42", url: "https://masto.test/@moi/42" });
  });

  test("Home Assistant : appel de service et lecture d'état", async () => {
    const s = await lancer("reseau.home_assistant", {
      url: URL_,
      jeton: "tok",
      service: "light.turn_on",
      entite: "light.salon",
      donnees: { brightness: 120 },
    });
    expect(s.statut).toBe("succes");
    expect([recues[0]!.methode, recues[0]!.chemin]).toEqual(["POST", "/api/services/light/turn_on"]);
    expect(JSON.parse(recues[0]!.corps)).toEqual({ entity_id: "light.salon", brightness: 120 });

    const e = await lancer("reseau.home_assistant", {
      url: URL_,
      jeton: "tok",
      operation: "etat",
      entite: "light.salon",
    });
    expect([recues[0]!.methode, recues[0]!.chemin]).toEqual(["GET", "/api/states/light.salon"]);
    expect(e.sortie[0]!.json.home_assistant).toEqual({ entity_id: "light.salon", state: "on" });
  });

  test("Nextcloud : dépôt WebDAV du fichier, authentification de base", async () => {
    const r = await lancer("reseau.nextcloud", {
      fichier: { nom: "note.txt", type: "text/plain", base64: Buffer.from("bonjour").toString("base64") },
      serveur: URL_,
      utilisateur: "zoé",
      motDePasse: "app-mdp",
      dossier: "/Documents/auto",
    });
    expect(r.statut).toBe("succes");
    const q = recues[0]!;
    expect([q.methode, q.chemin, q.corps]).toEqual([
      "PUT",
      "/remote.php/dav/files/zoé/Documents/auto/note.txt",
      "bonjour",
    ]);
    expect(q.entetes.authorization).toBe(`Basic ${Buffer.from("zoé:app-mdp").toString("base64")}`);
    expect(r.sortie[0]!.json.nextcloud).toEqual({ chemin: "/Documents/auto/note.txt", octets: 7 });
  });

  test("une erreur HTTP du service arrête l'exécution avec son statut", async () => {
    const r = await lancer("communication.gotify", { serveur: `${URL_}/refus#`, jeton: "x", texte: "y" });
    expect(r.statut).toBe("erreur");
    expect(r.erreur?.message).toContain("HTTP");
  });
});

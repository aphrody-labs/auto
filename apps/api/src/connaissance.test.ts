// Base de connaissances de bout en bout : indexation de deux documents (PDF et Word) par les nœuds, recherche,
// modèle « Répondre aux questions avec vos documents » par webhook, comptes et suppression par l'API, isolation.
// Un faux serveur compatible OpenAI renvoie des embeddings déterministes (sac de mots haché) et une réponse de chat.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MODELES } from "@auto/automate";
import { creerDocx, docxEnPdf } from "@auto/native";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let ia: ReturnType<typeof Bun.serve>;
const DIMENSION = 64;
const lots: number[] = [];

/** Vecteur d'un texte : un compte par mot (sans accents, 4 lettres au moins) haché sur 64 composantes. */
function vecteur(texte: string): number[] {
  const v = Array.from({ length: DIMENSION }, () => 0);
  for (const mot of texte
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/))
    if (mot.length >= 4) v[Number(Bun.hash.xxHash32(mot) % DIMENSION)]! += 1;
  return v;
}

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
  Bun.env.AUTO_API_URL = server.url.origin;
  ia = Bun.serve({
    port: 0,
    routes: {
      "/v1/embeddings": {
        POST: async (req) => {
          if (req.headers.get("authorization") !== "Bearer cle-test")
            return Response.json({ error: "clé" }, { status: 401 });
          const b = (await req.json()) as { model: string; input: string[] };
          lots.push(b.input.length);
          return Response.json({
            model: b.model,
            data: b.input.map((t, index) => ({ object: "embedding", index, embedding: vecteur(t) })).reverse(),
          });
        },
      },
      "/v1/chat/completions": {
        POST: async (req) => {
          const b = (await req.json()) as { messages: { role: string; content: string }[] };
          const extraits = b.messages.at(-1)!.content;
          const reponse = extraits.includes("deux ans")
            ? "La garantie dure deux ans [garantie.pdf]."
            : "Je ne sais pas.";
          return Response.json({ choices: [{ message: { role: "assistant", content: reponse } }] });
        },
      },
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await ia.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown, method?: string) {
  const res = await fetch(new URL(path, server.url), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function entreprise(nom: string) {
  const a = await api("/v1/auth/inscription", undefined, {
    email: `${crypto.randomUUID()}@exemple.fr`,
    motDePasse: "un mot de passe long",
    entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Paris" },
  });
  const session = a.body.session as string;
  expect((await api("/v1/secrets", session, { nom: "embeddings", valeur: "cle-test" })).status).toBe(201);
  return session;
}

const EMBEDDINGS = () => ({ api: `${ia.url.origin}/v1`, modele: "hachage-64", cle: "{{ $secret.embeddings }}" });

const fichier = (nom: string, type: string, octets: Uint8Array) => ({ nom, type, base64: octets.toBase64() });

/** Essai d'un workflow manuel à un nœud (indexer ou rechercher) ; renvoie l'exécution. */
async function essai(session: string, type: string, parametres: object, donnees?: unknown) {
  const definition = {
    noeuds: [
      { id: "debut", type: "declencheur.manuel", nom: "Début", parametres: {} },
      { id: "n", type, nom: "N", parametres: { ...EMBEDDINGS(), ...parametres } },
    ],
    connexions: [{ de: "debut", vers: "n" }],
  };
  return (await api("/v1/automatisations/essai", session, { definition, donnees })).body;
}

const GARANTIE = creerDocx({
  titre: "Conditions de garantie",
  paragraphes: [
    { texte: "Nos appareils sont couverts par une garantie constructeur de deux ans à compter de la livraison." },
    { texte: "La garantie couvre les pièces, la main-d'œuvre et le déplacement du technicien." },
    ...Array.from({ length: 30 }, (_, i) => ({
      texte: `Article ${i + 3}. Le client conserve la facture originale pendant toute la durée de couverture.`,
    })),
  ],
});
const LIVRAISON = creerDocx({
  titre: "Livraison",
  paragraphes: [
    { texte: "Les commandes sont expédiées sous quarante-huit heures par transporteur." },
    { texte: "Les frais de port sont offerts au-delà de cent euros d'achat." },
  ],
});

test("indexer deux documents, rechercher, répondre par le modèle, comptes, suppression, isolation", async () => {
  const a = await entreprise("Atelier Morel");

  // Indexation : un PDF (couche texte lue par pdfcraft) et un document Word (texte lu par wordcraft).
  const pdf = await essai(
    a,
    "ia.indexer",
    { fichier: "{{ $json.f }}", taille: 300 },
    {
      f: fichier("garantie.pdf", "application/pdf", docxEnPdf(GARANTIE)),
    },
  );
  expect(pdf.statut).toBe("succes");
  const [p] = pdf.sortie as { json: Record<string, number | string> }[];
  expect(p!.json).toMatchObject({ base: "documents", source: "garantie.pdf", remplaces: 0 });
  expect(Number(p!.json.morceaux)).toBeGreaterThan(3);
  expect(lots.some((n) => n > 1)).toBe(true);
  const docx = await essai(
    a,
    "ia.indexer",
    { fichier: "{{ $json.f }}" },
    {
      f: fichier("livraison.docx", "application/octet-stream", LIVRAISON),
    },
  );
  expect(docx.statut).toBe("succes");
  expect(docx.sortie[0].json).toMatchObject({ source: "livraison.docx", morceaux: 1 });

  // Recherche : le bon morceau en tête, contexte prêt pour ia.texte.
  const r = await essai(a, "ia.rechercher", { question: "Combien de temps dure la garantie constructeur ?", k: 3 });
  expect(r.statut).toBe("succes");
  const el = r.sortie[0].json as { resultats: { source: string; texte: string; score: number }[]; contexte: string };
  expect(el.resultats).toHaveLength(3);
  expect(el.resultats[0]!.source).toBe("garantie.pdf");
  expect(el.resultats[0]!.texte).toContain("deux ans");
  expect(el.resultats[0]!.score).toBeGreaterThan(el.resultats[2]!.score);
  expect(el.contexte.startsWith("[garantie.pdf, partie ")).toBe(true);
  const port = await essai(a, "ia.rechercher", { question: "Les frais de port de la commande", k: 1 });
  expect(port.sortie[0].json.resultats[0].source).toBe("livraison.docx");
  // La clé d'API (secret) n'apparaît pas dans les étapes.
  expect(JSON.stringify(r.etapes)).not.toContain("cle-test");

  // Modèle « Répondre aux questions avec vos documents » : webhook → recherche → modèle de langage → réponse.
  const modele = MODELES.find((m) => m.id === "questions-documents")!;
  const definition = structuredClone(modele.definition);
  for (const n of definition.noeuds) {
    if (n.type === "ia.rechercher") Object.assign(n.parametres, EMBEDDINGS());
    if (n.type === "ia.texte") n.parametres.url = `${ia.url.origin}/v1`;
  }
  const w = await api("/v1/automatisations", a, { nom: modele.nom, definition, actif: true });
  expect(w.status).toBe(201);
  const { url } = (await api(`/v1/automatisations/${w.body.id}/webhook`, a)).body as { url: string };
  const reponse = await api(new URL(url).pathname, undefined, { question: "Quelle est la durée de la garantie ?" });
  expect(reponse.status).toBe(200);
  expect(reponse.body.reponse).toBe("La garantie dure deux ans [garantie.pdf].");
  expect(reponse.body.sources[0].source).toBe("garantie.pdf");

  // Comptes par base ; réindexer une source la remplace.
  const bases = (await api("/v1/connaissances", a)).body;
  expect(bases).toHaveLength(1);
  expect(bases[0]).toMatchObject({ base: "documents", sources: 2, modele: "hachage-64", dimension: DIMENSION });
  const total = bases[0].morceaux as number;
  const encore = await essai(
    a,
    "ia.indexer",
    { fichier: "{{ $json.f }}" },
    {
      f: fichier("livraison.docx", "application/octet-stream", LIVRAISON),
    },
  );
  expect(encore.sortie[0].json).toMatchObject({ morceaux: 1, remplaces: 1 });
  expect((await api("/v1/connaissances", a)).body[0].morceaux).toBe(total);

  // Un autre modèle d'embeddings sur la même base est refusé.
  const autreModele = await essai(a, "ia.indexer", { texte: "Autre texte", source: "x", modele: "autre" });
  expect(autreModele.statut).toBe("erreur");
  expect(autreModele.erreur).toContain("même modèle");

  // Isolation : la seconde entreprise ne voit ni ne retrouve rien de la première.
  const b = await entreprise("Autre");
  expect((await api("/v1/connaissances", b)).body).toEqual([]);
  const rien = await essai(b, "ia.rechercher", { question: "garantie" });
  expect(rien.statut).toBe("erreur");
  expect(rien.erreur).toContain("vide ou inconnue");
  await essai(b, "ia.indexer", { texte: "Notre garantie maison couvre trois mois seulement.", source: "maison" });
  const chezB = await essai(b, "ia.rechercher", { question: "durée de la garantie", k: 5 });
  expect(chezB.sortie[0].json.resultats.map((x: { source: string }) => x.source)).toEqual(["maison"]);
  expect((await api("/v1/connaissances/documents", b, undefined, "DELETE")).body.morceaux).toBe(1);
  expect((await api("/v1/connaissances", a)).body[0].morceaux).toBe(total);

  // Suppression d'une source puis de la base.
  const s = await api("/v1/connaissances/documents?source=livraison.docx", a, undefined, "DELETE");
  expect(s).toEqual({ status: 200, body: { morceaux: 1 } });
  expect((await api("/v1/connaissances", a)).body[0]).toMatchObject({ sources: 1, morceaux: total - 1 });
  expect((await api("/v1/connaissances/documents", a, undefined, "DELETE")).body.morceaux).toBe(total - 1);
  expect((await api("/v1/connaissances/documents", a, undefined, "DELETE")).status).toBe(404);
  expect((await api("/v1/connaissances/Mauvais%20Nom", a, undefined, "DELETE")).status).toBe(422);
  expect((await api("/v1/connaissances", a)).body).toEqual([]);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { MODELES } from "@auto/automate";
import { creerDocx, nombrePagesPdf, textePdf, texteDocx, verifierSignaturesPdf } from "@auto/native";
import { lancer } from "@auto/services/automatisations";
import { avecWorker, JOB_AUTOMATISATION, testDb, type Sql } from "@auto/store";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let recepteur: ReturnType<typeof Bun.serve>;
const recus: unknown[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({ port: 0, routes: creerApp(sql), fetch: () => new Response("404", { status: 404 }) });
  // Les nœuds « Action auto » rappellent l'API : celle du test.
  Bun.env.AUTO_API_URL = server.url.origin;
  recepteur = Bun.serve({
    port: 0,
    fetch: async (req) => {
      recus.push(await req.json());
      return Response.json({ ok: true });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await recepteur.stop(true);
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

async function entreprise(nom = "Atelier Morel") {
  const a = await api("/v1/auth/inscription", undefined, {
    email: `${crypto.randomUUID()}@exemple.fr`,
    motDePasse: "un mot de passe long",
    entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Paris" },
  });
  return { session: a.body.session as string, tenantId: a.body.tenantId as string };
}

const manuel = (noeuds: object[], connexions: object[] = []) => ({
  noeuds: [{ id: "debut", type: "declencheur.manuel", nom: "Début", parametres: {} }, ...noeuds],
  connexions,
});

test("catalogue, modèles et validation des définitions", async () => {
  const { session } = await entreprise();
  const c = await api("/v1/automatisations/catalogue", session);
  expect(c.body.map((x: { type: string }) => x.type)).toContain("reseau.http");
  expect((await api("/v1/automatisations/modeles", session)).body).toHaveLength(MODELES.length);
  const ko = await api("/v1/automatisations", session, {
    nom: "Cycle",
    definition: manuel(
      [
        { id: "a", type: "donnees.limiter", nom: "a", parametres: { max: 1 } },
        { id: "b", type: "donnees.limiter", nom: "b", parametres: { max: 1 } },
      ],
      [
        { de: "debut", vers: "a" },
        { de: "a", vers: "b" },
        { de: "b", vers: "a" },
      ],
    ),
  });
  expect(ko.status).toBe(422);
  expect(ko.body.details).toContain("le graphe contient un cycle");
});

test("essai, action auto, secrets masqués, exécution consignée, isolation des tenants", async () => {
  const { session, tenantId } = await entreprise();
  await api("/v1/clients", session, { nom: "Zoé Martin", adresse: "3 rue C, Lyon", email: "zoe@exemple.fr" });
  const s = await api("/v1/secrets", session, { nom: "recepteur", valeur: recepteur.url.href });
  expect(s.status).toBe(201);
  expect(s.body).not.toHaveProperty("valeur");

  const definition = manuel(
    [
      { id: "clients", type: "auto.requete", nom: "Clients", parametres: { chemin: "/v1/clients", eclater: true } },
      {
        id: "http",
        type: "reseau.http",
        nom: "Notifier",
        parametres: {
          methode: "POST",
          url: "{{ $secret.recepteur }}",
          corps: { client: "{{ $json.nom }}", cle: "{{ $secret.recepteur }}" },
        },
      },
    ],
    [
      { de: "debut", vers: "clients" },
      { de: "clients", vers: "http" },
    ],
  );
  const essai = await api("/v1/automatisations/essai", session, { definition });
  expect(essai.body.statut).toBe("succes");
  expect(recus.at(-1)).toEqual({ client: "Zoé Martin", cle: recepteur.url.href });
  // La valeur du secret n'apparaît pas dans les étapes renvoyées.
  expect(JSON.stringify(essai.body.etapes)).not.toContain(recepteur.url.href);
  // Le jeton temporaire de l'action auto est révoqué.
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM apikey WHERE name LIKE 'automatisation:%'`;
  expect(n).toBe(0);

  const w = await api("/v1/automatisations", session, { nom: "Notifier les clients", definition });
  expect(w.status).toBe(201);
  expect(w.body.declencheur).toBe("manuel");
  const e = await api(`/v1/automatisations/${w.body.id}/executer`, session, {});
  expect(e.body.statut).toBe("succes");
  const liste = await api(`/v1/automatisations/${w.body.id}/executions`, session);
  expect(liste.body).toHaveLength(1);
  const detail = await api(`/v1/executions/${e.body.id}`, session);
  expect(detail.body.etapes.map((x: { noeud: string }) => x.noeud)).toEqual(["debut", "clients", "http"]);
  expect((await api("/v1/automatisations", session)).body[0].derniereExecution.statut).toBe("succes");

  const autre = await entreprise("Autre");
  expect((await api(`/v1/automatisations/${w.body.id}`, autre.session)).status).toBe(404);
  expect((await api("/v1/automatisations", autre.session)).body).toEqual([]);
  await expect(
    lancer(sql, { tenantId: autre.tenantId, automatisationId: w.body.id, origine: "x", entree: [] }),
  ).rejects.toThrow("introuvable");
  expect(tenantId).not.toBe(autre.tenantId);
});

test("un secret inconnu empêche l'activation", async () => {
  const { session } = await entreprise();
  const r = await api("/v1/automatisations", session, {
    nom: "Slack",
    actif: true,
    definition: MODELES[0]!.definition,
  });
  expect(r.status).toBe(422);
  expect(r.body.details).toEqual(["$secret.slack_ventes"]);
});

test("événement : un workflow actif abonné reçoit un job dans la transaction de l'événement", async () => {
  const { session, tenantId } = await entreprise();
  await api("/v1/secrets", session, { nom: "slack_ventes", valeur: "https://hooks.slack.test/x" });
  const w = await api("/v1/automatisations", session, {
    nom: "Slack",
    actif: true,
    definition: MODELES[0]!.definition,
  });
  expect(w.body.declencheur).toBe("evenement");
  const d = await api("/v1/documents", session, {
    type: "facture",
    echeance: "2026-11-30",
    datePrestation: "2026-10-20",
    client: { nom: "Client SAS", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
  });
  expect((await api(`/v1/documents/${d.body.id}/emettre`, session, {})).status).toBe(200);
  const jobs = await avecWorker(
    sql,
    (tx) => tx<{ payload: { automatisationId: string; origine: string } }[]>`
      SELECT payload FROM job WHERE type = ${JOB_AUTOMATISATION} AND tenant_id = ${tenantId}`,
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.payload.automatisationId).toBe(w.body.id);
  expect(jobs[0]!.payload.origine).toStartWith("evenement:");
});

test("webhook entrant : URL signée, réponse en fin de workflow, jeton falsifié refusé", async () => {
  const { session } = await entreprise();
  const definition = {
    noeuds: [
      { id: "crochet", type: "declencheur.webhook", nom: "Reçu", parametres: { reponse: "fin" } },
      {
        id: "repondre",
        type: "donnees.definir",
        nom: "Répondre",
        parametres: { champs: [{ nom: "salut", valeur: "Bonjour {{ $json.corps.nom }}" }], conserver: false },
      },
    ],
    connexions: [{ de: "crochet", vers: "repondre" }],
  };
  const w = await api("/v1/automatisations", session, { nom: "Crochet", definition });
  const { url } = (await api(`/v1/automatisations/${w.body.id}/webhook`, session)).body as { url: string };
  const chemin = new URL(url).pathname;
  expect((await api(chemin, undefined, { nom: "Zoé" })).status).toBe(409); // inactif
  await api(`/v1/automatisations/${w.body.id}`, session, { actif: true }, "PUT");
  const r = await api(chemin, undefined, { nom: "Zoé" });
  expect(r).toEqual({ status: 200, body: { salut: "Bonjour Zoé" } });
  expect((await api(`${chemin}x`, undefined, {})).status).toBe(404);
});

test("seulement les nouveaux : la mémoire du workflow persiste entre exécutions, pas entre essais", async () => {
  const { session } = await entreprise();
  const definition = manuel(
    [
      { id: "liste", type: "donnees.separer", nom: "Liste", parametres: { champ: "articles" } },
      { id: "nouveaux", type: "donnees.nouveaux", nom: "Nouveaux", parametres: { champ: "id" } },
    ],
    [
      { de: "debut", vers: "liste" },
      { de: "liste", vers: "nouveaux" },
    ],
  );
  const w = await api("/v1/automatisations", session, { nom: "Veille", definition });
  const lot = (ids: number[]) => ({ donnees: { articles: ids.map((id) => ({ id })) } });
  const sorties = async (ids: number[]) =>
    (await api(`/v1/automatisations/${w.body.id}/executer`, session, lot(ids))).body.etapes.at(-1).sorties[0];
  expect(await sorties([1, 2])).toBe(2);
  expect(await sorties([1, 2, 3])).toBe(1);
  expect(await sorties([3])).toBe(0);
  const essai = await api("/v1/automatisations/essai", session, { definition, ...lot([1, 2, 3]) });
  expect(essai.body.etapes.at(-1).sorties[0]).toBe(3);
});

test("tableurs natifs : créer un xlsx depuis les éléments, puis le relire par URL", async () => {
  const { session } = await entreprise();
  const ecrire = manuel(
    [
      { id: "liste", type: "donnees.separer", nom: "Liste", parametres: { champ: "lignes" } },
      {
        id: "xlsx",
        type: "fichier.tableur",
        nom: "Classeur",
        parametres: {
          nom: "clients",
          colonnes: [
            { titre: "Nom", champ: "nom" },
            { titre: "CA", champ: "ca" },
          ],
        },
      },
    ],
    [
      { de: "debut", vers: "liste" },
      { de: "liste", vers: "xlsx" },
    ],
  );
  const e = await api("/v1/automatisations/essai", session, {
    definition: ecrire,
    donnees: {
      lignes: [
        { nom: "Zoé", ca: 1200 },
        { nom: "Marc", ca: 80.5 },
      ],
    },
  });
  expect(e.body.statut).toBe("succes");
  const { fichier } = e.body.sortie[0].json as { fichier: { nom: string; base64: string } };
  expect(fichier.nom).toBe("clients.xlsx");
  const octets = Uint8Array.fromBase64(fichier.base64);
  const fichiers = Bun.serve({ port: 0, fetch: () => new Response(octets) });
  try {
    const lire = manuel(
      [{ id: "lire", type: "fichier.lire_tableur", nom: "Lire", parametres: { url: fichiers.url.href } }],
      [{ de: "debut", vers: "lire" }],
    );
    const r = await api("/v1/automatisations/essai", session, { definition: lire });
    expect(r.body.sortie.map((x: { json: unknown }) => x.json)).toEqual([
      { Nom: "Zoé", CA: 1200 },
      { Nom: "Marc", CA: 80.5 },
    ]);
  } finally {
    await fichiers.stop(true);
  }
});

test("fichiers natifs : deux PDF générés fusionnés, texte extrait, gabarit Word rempli puis relu", async () => {
  const { session } = await entreprise();
  const gabarit = creerDocx({
    titre: "Synthèse pour {{ client }}",
    paragraphes: [{ texte: "{{ texte }}" }, { texte: "Pages : {{ pages }}" }],
  });
  const definition = manuel(
    [
      { id: "liste", type: "donnees.separer", nom: "Liste", parametres: { champ: "clients" } },
      {
        id: "fiche",
        type: "fichier.document",
        nom: "Fiche",
        parametres: {
          titre: "Fiche {{ $json.nom }}",
          paragraphes: [{ texte: "Client {{ $json.nom }} à {{ $json.ville }}" }],
          format: "pdf",
          nom: "fiche {{ $json.nom }}",
        },
      },
      { id: "fusion", type: "fichier.pdf_fusionner", nom: "Fusion", parametres: { nom: "dossier" } },
      {
        id: "page",
        type: "fichier.pdf_pages",
        nom: "Page 2",
        parametres: { fichier: "{{ $json.fichier }}", pages: "2" },
      },
      {
        id: "texte",
        type: "fichier.pdf_texte",
        nom: "Texte",
        parametres: { fichier: "{{ $noeud.fusion.json.fichier }}" },
      },
      {
        id: "synthese",
        type: "fichier.document",
        nom: "Synthèse",
        parametres: {
          gabarit: { nom: "gabarit.docx", type: "application/octet-stream", base64: gabarit.toBase64() },
          champs: [{ nom: "client", valeur: "Atelier Morel" }],
          format: "docx_pdf",
          nom: "synthese",
        },
      },
    ],
    [
      { de: "debut", vers: "liste" },
      { de: "liste", vers: "fiche" },
      { de: "fiche", vers: "fusion" },
      { de: "fusion", vers: "page" },
      { de: "page", vers: "texte" },
      { de: "texte", vers: "synthese" },
    ],
  );
  const e = await api("/v1/automatisations/essai", session, {
    definition,
    donnees: {
      clients: [
        { nom: "Zoé", ville: "Lyon" },
        { nom: "Marc", ville: "Brest" },
      ],
    },
  });
  expect(e.body.statut).toBe("succes");
  const octets = (f: { base64: string }) => Uint8Array.fromBase64(f.base64);
  const etape = (id: string) => e.body.etapes.find((x: { noeud: string }) => x.noeud === id);
  expect(etape("fusion").sorties[0]).toBe(1);
  const { json } = e.body.sortie[0] as { json: Record<string, any> };
  expect(json.manquants).toEqual([]);
  expect(json.fichier.nom).toBe("synthese.docx");
  const docx = texteDocx(octets(json.fichier));
  expect(docx).toContain("Synthèse pour Atelier Morel");
  expect(docx).toContain("Client Zoé à Lyon");
  expect(docx).toContain("Client Marc à Brest");
  expect(docx).toContain("Pages : 2");
  expect(textePdf(octets(json.pdf)).join(" ")).toContain("Client Marc à Brest");
  // Le nœud « Page 2 » a gardé la seule fiche de Marc.
  const garde = (id: string) => id !== "synthese" && id !== "texte";
  const lot = await api("/v1/automatisations/essai", session, {
    definition: {
      noeuds: (definition.noeuds as { id: string }[]).filter((n) => garde(n.id)),
      connexions: (definition.connexions as { vers: string }[]).filter((c) => garde(c.vers)),
    },
    donnees: {
      clients: [
        { nom: "Zoé", ville: "Lyon" },
        { nom: "Marc", ville: "Brest" },
      ],
    },
  });
  const page = octets(lot.body.sortie[0].json.fichier);
  expect(nombrePagesPdf(page)).toBe(1);
  expect(textePdf(page)[0]).toContain("Fiche Marc");
});

test("caviardage, signature PAdES et présentation natifs", async () => {
  const { session } = await entreprise();
  const p12 = await Bun.file(
    new URL("../../../vendor/suite/crates/pdfcraft-sign/tests/data/rsa-aes.p12", import.meta.url),
  ).bytes();
  await api("/v1/secrets", session, { nom: "certificat", valeur: p12.toBase64() });
  await api("/v1/secrets", session, { nom: "certificat_mdp", valeur: "test" });
  const definition = manuel(
    [
      {
        id: "releve",
        type: "fichier.document",
        nom: "Relevé",
        parametres: {
          titre: "Relevé {{ $json.client }}",
          paragraphes: [{ texte: "Client {{ $json.client }}, {{ $json.email }}" }, { texte: "IBAN {{ $json.iban }}" }],
          format: "pdf",
        },
      },
      {
        id: "caviarder",
        type: "fichier.pdf_caviarder",
        nom: "Caviarder",
        parametres: { fichier: "{{ $json.fichier }}", textes: ["{{ $json.client }}"], motifs: ["email", "iban"] },
      },
      {
        id: "signer",
        type: "fichier.pdf_signer",
        nom: "Signer",
        parametres: {
          fichier: "{{ $json.fichier }}",
          certificat: "{{ $secret.certificat }}",
          motDePasse: "{{ $secret.certificat_mdp }}",
          raison: "Conforme",
          visible: true,
        },
      },
      {
        id: "verifier",
        type: "fichier.pdf_verifier_signature",
        nom: "Vérifier",
        parametres: { fichier: "{{ $json.fichier }}" },
      },
    ],
    [
      { de: "debut", vers: "releve" },
      { de: "releve", vers: "caviarder" },
      { de: "caviarder", vers: "signer" },
      { de: "signer", vers: "verifier" },
    ],
  );
  const e = await api("/v1/automatisations/essai", session, {
    definition,
    donnees: { client: "Zoé Martin", email: "zoe@exemple.fr", iban: "FR76 3000 6000 0112 3456 7890 189" },
  });
  expect(e.body.statut).toBe("succes");
  const { json } = e.body.sortie[0] as { json: Record<string, any> };
  expect(json.occurrences).toBe(4);
  expect(json).toMatchObject({ signe: true, intacte: true, valide: false });
  expect(json.signatures[0]).toMatchObject({ statut: "inconnue", signataire: "Test Signer RSA", raison: "Conforme" });
  const pdf = Uint8Array.fromBase64(json.fichier.base64);
  const texte = textePdf(pdf).join(" ");
  expect(texte).toContain("Relevé");
  for (const absent of ["Zoé", "zoe@", "FR76"]) expect(texte).not.toContain(absent);
  expect(verifierSignaturesPdf(pdf)[0]!.modifications).toBe("aucune");
  // Le certificat et son mot de passe ne figurent pas dans les étapes renvoyées.
  expect(JSON.stringify(e.body.etapes)).not.toContain(p12.toBase64().slice(0, 40));

  const p = await api("/v1/automatisations/essai", session, {
    definition: manuel(
      [
        {
          id: "liste",
          type: "donnees.separer",
          nom: "Liste",
          parametres: { champ: "points" },
        },
        {
          id: "deck",
          type: "fichier.presentation",
          nom: "Présentation",
          parametres: { titre: "Bilan", sousTitre: "Atelier Morel", format: "pptx_pdf" },
        },
      ],
      [
        { de: "debut", vers: "liste" },
        { de: "liste", vers: "deck" },
      ],
    ),
    donnees: { points: [{ titre: "Ventes", puces: ["En hausse", "Trois nouveaux clients"] }, { titre: "Suite" }] },
  });
  expect(p.body.statut).toBe("succes");
  const deck = p.body.sortie[0].json;
  expect(deck.diapositives).toBe(3);
  expect(deck.fichier.nom).toBe("presentation.pptx");
  const pages = textePdf(Uint8Array.fromBase64(deck.pdf.base64));
  expect(pages).toHaveLength(3);
  expect(pages[1]).toContain("Trois nouveaux clients");
});

test("import n8n par l'API", async () => {
  const { session } = await entreprise();
  const r = await api("/v1/automatisations/importer-n8n", session, {
    workflow: {
      name: "Depuis n8n",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} },
        { name: "Limit", type: "n8n-nodes-base.limit", parameters: { maxItems: 2 } },
      ],
      connections: { Start: { main: [[{ node: "Limit", type: "main", index: 0 }]] } },
    },
  });
  expect(r.status).toBe(200);
  expect(r.body.avertissements).toEqual([]);
  expect((await api("/v1/automatisations", session, { nom: r.body.nom, definition: r.body.definition })).status).toBe(
    201,
  );
  expect((await api("/v1/automatisations/importer-n8n", session, { workflow: { a: 1 } })).status).toBe(422);
});

test("sous-workflows : résultat repris, appel de soi-même refusé, 3 niveaux au plus", async () => {
  const { session } = await entreprise();
  const creer = async (nom: string, noeuds: object[], connexions: object[]) =>
    (await api("/v1/automatisations", session, { nom, definition: manuel(noeuds, connexions) })).body.id as string;
  const appel = (id: string): [object[], object[]] => [
    [{ id: "sous", type: "auto.workflow", nom: "Sous-workflow", parametres: { workflow: id } }],
    [{ de: "debut", vers: "sous" }],
  ];

  const enfant = await creer(
    "Mise en forme",
    [
      {
        id: "forme",
        type: "donnees.definir",
        nom: "Forme",
        parametres: { champs: [{ nom: "client_maj", valeur: "{{ $json.client | majuscules }}" }] },
      },
    ],
    [{ de: "debut", vers: "forme" }],
  );
  const parent = await creer("Parent", ...appel(enfant));
  const r = await api(`/v1/automatisations/${parent}/executer`, session, { donnees: { client: "zoé" } });
  expect(r.body.statut).toBe("succes");
  expect(r.body.etapes.at(-1).apercu[0].json).toMatchObject({ client: "zoé", client_maj: "ZOÉ" });
  // L'exécution du sous-workflow est consignée de son côté, avec son origine.
  const ex = await api(`/v1/automatisations/${enfant}/executions`, session);
  expect(ex.body[0].origine).toBe(`workflow:${parent}`);

  const boucle = await creer("Boucle", ...appel(enfant));
  await api(`/v1/automatisations/${boucle}`, session, { definition: manuel(...appel(boucle)) }, "PUT");
  const b = await api(`/v1/automatisations/${boucle}/executer`, session, { donnees: {} });
  expect(b.body.statut).toBe("erreur");
  expect(b.body.erreur).toContain("lui-même");

  let suivant = await creer("Niveau 5", [], []);
  for (const n of [4, 3, 2, 1]) suivant = await creer(`Niveau ${n}`, ...appel(suivant));
  const p = await api(`/v1/automatisations/${suivant}/executer`, session, { donnees: {} });
  expect(p.body.statut).toBe("erreur");
  expect(p.body.erreur).toContain("niveaux de sous-workflows");
});

test("versions : contenu précédent conservé, activation seule ignorée, restauration réversible", async () => {
  const { session } = await entreprise();
  const etape = (texte: string) =>
    manuel(
      [{ id: "f", type: "donnees.definir", nom: "F", parametres: { champs: [{ nom: "t", valeur: texte }] } }],
      [{ de: "debut", vers: "f" }],
    );
  const w = (await api("/v1/automatisations", session, { nom: "V1", definition: etape("un") })).body.id as string;
  const versions = async () => (await api(`/v1/automatisations/${w}/versions`, session)).body;
  expect(await versions()).toEqual([]);

  await api(`/v1/automatisations/${w}`, session, { nom: "V2", definition: etape("deux") }, "PUT");
  await api(`/v1/automatisations/${w}`, session, { actif: true }, "PUT");
  const v = await versions();
  expect(v.map((x: { numero: number; nom: string }) => [x.numero, x.nom])).toEqual([[1, "V1"]]);

  const r = await api(`/v1/automatisations/${w}/versions/1/restaurer`, session, {});
  expect(r.status).toBe(200);
  expect(r.body.nom).toBe("V1");
  expect(r.body.actif).toBe(true);
  expect(r.body.definition.noeuds[1].parametres.champs[0].valeur).toBe("un");
  // L'état remplacé (V2) est devenu la version 2 : la restauration se défait.
  expect((await versions()).map((x: { nom: string }) => x.nom)).toEqual(["V2", "V1"]);
  expect((await api(`/v1/automatisations/${w}/versions/9/restaurer`, session, {})).status).toBe(404);

  const autre = await entreprise("Autre");
  expect((await api(`/v1/automatisations/${w}/versions`, autre.session)).body).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import { catalogueJson, executer, MODELES, resoudre, valider, type Services } from "./index";

const services = (reponses: Record<string, unknown> = {}): Services & { appels: unknown[] } => {
  const appels: unknown[] = [];
  return {
    appels,
    async fetch(url, init) {
      appels.push({ url, corps: init.body });
      return Response.json(reponses[url] ?? { ok: true });
    },
    async appelerAuto(methode, chemin, corps) {
      appels.push({ methode, chemin, corps });
      if (chemin === "/v1/relances")
        return {
          statut: 200,
          corps: [
            { numero: "F-1", client: { nom: "A" }, resteCents: 12000, joursRetard: 3 },
            { numero: "F-2", client: { nom: "B" }, resteCents: 5050, joursRetard: 40 },
          ],
        };
      return {
        statut: 200,
        corps: { id: "x", numero: "F-9", data: { client: { nom: "Zoé", email: "z@ex.fr" }, emetteur: { nom: "Moi" } } },
      };
    },
    async envoyerMail(m) {
      appels.push({ mail: m });
    },
  };
};
const opts = (s: Services, secrets = {}) => ({
  services: s,
  workflow: { id: "w", nom: "W" },
  executionId: "e",
  secrets,
});

describe("expressions", () => {
  const p = {
    json: { a: { b: [1, 2] }, nom: " zoé " },
    noeuds: { x: { v: 5 } },
    secrets: { k: "s" },
    execution: { id: "e" },
    workflow: { id: "w", nom: "W" },
    index: 0,
  };
  test("valeur seule typée, texte mêlé, filtres", () => {
    expect(resoudre("{{ $json.a.b }}", p)).toEqual([1, 2]);
    expect(resoudre("n={{ $json.a.b[1] }}", p)).toBe("n=2");
    expect(resoudre("{{ $json.nom | rogner | majuscules }}", p)).toBe("ZOÉ");
    expect(resoudre("{{ $noeud.x.json.v }}-{{ $secret.k }}", p)).toBe("5-s");
    expect(resoudre("{{ $json.absent | defaut:'?' }}", p)).toBe("?");
    expect(resoudre("{{ 1234 | centimes }}", p)).toMatch(/12,34\s€/);
    expect(() => resoudre("{{ process.env }}", p)).toThrow();
    expect(() => resoudre("{{ $json.a | inconnu }}", p)).toThrow("filtre inconnu");
  });
});

describe("validation", () => {
  test("tous les modèles sont valides", () => {
    for (const m of MODELES) expect(() => valider(m.definition)).not.toThrow();
  });
  test("cycle, déclencheur manquant, type inconnu", () => {
    const n = (id: string, type = "donnees.limiter") => ({
      id,
      type,
      nom: id,
      parametres: type === "donnees.limiter" ? { max: 1 } : {},
    });
    expect(() => valider({ noeuds: [n("a"), n("b")], connexions: [] })).toThrow();
    expect(() =>
      valider({
        noeuds: [n("t", "declencheur.manuel"), n("a"), n("b")],
        connexions: [
          { de: "t", vers: "a" },
          { de: "a", vers: "b" },
          { de: "b", vers: "a" },
        ],
      }),
    ).toThrow();
    expect(() => valider({ noeuds: [n("t", "declencheur.manuel"), n("a", "x.y")], connexions: [] })).toThrow();
  });
  test("catalogue en JSON Schema", () => {
    const c = catalogueJson();
    expect(c.length).toBeGreaterThan(15);
    expect(c.find((x) => x.type === "reseau.http")!.parametres).toHaveProperty("properties.url");
  });
});

describe("exécution", () => {
  test("facture émise → Slack, branche faux ignorée", async () => {
    const s = services();
    const evt = {
      id: "1",
      type: "document.emis",
      data: { numero: "F-7", data: { type: "facture", client: { nom: "Zoé" } }, totaux: { ttcCents: 12000 } },
    };
    const r = await executer(
      valider(MODELES[0]!.definition),
      [{ json: evt }],
      opts(s, { slack_ventes: "https://hooks.slack.test/x" }),
    );
    expect(r.statut).toBe("succes");
    expect(r.etapes.map((e) => e.noeud)).toEqual(["declencheur", "facture", "slack"]);
    expect(JSON.parse(String((s.appels[0] as { corps: string }).corps)).text).toMatch(/F-7.*Zoé.*120,00/);
    const devis = await executer(
      valider(MODELES[0]!.definition),
      [{ json: { ...evt, data: { ...evt.data, data: { type: "devis" } } } }],
      opts(s),
    );
    expect(devis.etapes.map((e) => e.noeud)).toEqual(["declencheur", "facture"]);
  });
  test("récapitulatif : éclater, trier, regrouper, mail", async () => {
    const s = services();
    const r = await executer(valider(MODELES[2]!.definition), [], opts(s, { mail_gerant: "g@ex.fr" }));
    expect(r.statut).toBe("succes");
    const mail = (s.appels.find((a) => (a as { mail?: unknown }).mail) as { mail: { texte: string; sujet: string } })
      .mail;
    expect(mail.sujet).toBe("2 factures en retard");
    expect(mail.texte.split("\n")[0]).toStartWith("F-2");
  });
  test("erreur arrête, continuerSurErreur poursuit", async () => {
    const d = {
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        { id: "x", type: "logique.arreter", nom: "x", parametres: { message: "stop" } },
      ],
      connexions: [{ de: "t", vers: "x" }],
    };
    const r = await executer(valider(d), [{ json: {} }], opts(services()));
    expect(r).toMatchObject({ statut: "erreur", erreur: { noeud: "x", message: "stop" } });
    d.noeuds[1] = { ...d.noeuds[1]!, continuerSurErreur: true } as never;
    const r2 = await executer(valider(d), [{ json: { a: 1 } }], opts(services()));
    expect(r2.statut).toBe("succes");
    expect(r2.sortie[0]!.json).toEqual({ a: 1, erreur: "stop" });
  });
  test("aiguillage IA : sortie selon la catégorie", async () => {
    const s = services({
      "http://localhost:11434/v1/chat/completions": {
        choices: [{ message: { content: '{"categorie":"support","resume":"panne"}' } }],
      },
    });
    const r = await executer(
      valider(MODELES[5]!.definition),
      [{ json: { corps: { message: "ça marche pas" } } }],
      opts(s, { slack_support: "https://hooks.slack.test/s", slack_ventes: "https://hooks.slack.test/v" }),
    );
    expect(r.statut).toBe("succes");
    expect(r.etapes.map((e) => e.noeud)).toEqual(["declencheur", "ia", "aiguillage", "support"]);
  });
  test("durée maximale", async () => {
    const d = valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        { id: "w", type: "logique.attendre", nom: "w", parametres: { secondes: 5 } },
      ],
      connexions: [{ de: "t", vers: "w" }],
    });
    const r = await executer(d, [], { ...opts(services()), dureeMaxMs: 50 });
    expect(r.statut).toBe("erreur");
  });
});

describe("web natif", () => {
  test("extraction HTML par sélecteur et flux RSS/Atom", async () => {
    const { extraireHtml, lireFlux } = await import("./noeuds");
    const html = `<html><h1> Prix
   <b>du</b>  jour </h1><a class="p" href="/a">A</a><a class="p" href="/b">B</a></html>`;
    expect(
      extraireHtml(html, [
        { nom: "titre", selecteur: "h1", attribut: "", tous: false },
        { nom: "liens", selecteur: "a.p", attribut: "href", tous: true },
        { nom: "absent", selecteur: "table", attribut: "", tous: false },
      ]),
    ).toEqual({ titre: "Prix du jour", liens: ["/a", "/b"], absent: null });
    expect(lireFlux(`<rss><channel><item><title>Solo</title><link>http://s</link></item></channel></rss>`)).toEqual([
      { titre: "Solo", lien: "http://s", date: "", resume: "", id: "http://s" },
    ]);
    const atom = lireFlux(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="http://a"/><id>1</id><updated>2026-10-23</updated></entry><entry><title>B</title><link rel="alternate" href="http://b"/><id>2</id></entry></feed>`,
    );
    expect(atom.map((x) => x.lien)).toEqual(["http://a", "http://b"]);
  });
});

describe("fichiers PDF et Word", () => {
  test("plages de pages", async () => {
    const { plagesPages } = await import("./noeuds");
    expect(plagesPages("1-3, 5; 8-", 9)).toEqual([1, 2, 3, 5, 8, 9]);
    expect(plagesPages("-2,4", 4)).toEqual([1, 2, 4]);
    expect(plagesPages("3,1", 3)).toEqual([3, 1]);
    expect(() => plagesPages("0", 3)).toThrow(/hors du document/);
    expect(() => plagesPages("2-5", 3)).toThrow(/hors du document/);
    expect(() => plagesPages("a", 3)).toThrow(/invalides/);
  });

  test("nœuds par services injectés : fusion, pages, texte, gabarit", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (o: Uint8Array) => new TextDecoder().decode(o);
    const b64 = (s: string) => enc(s).toBase64();
    const s: Services = {
      ...services(),
      pdf: {
        fusionner: (pdfs) => enc(`%PDF-${pdfs.map((p) => p.nom).join("+")}`),
        pages: (pdf, pages) => enc(`${dec(pdf)}[${pages.join(",")}]`),
        nombrePages: () => 4,
        texte: (pdf) => [dec(pdf), "fin"],
      },
      word: {
        creer: (d) => enc(JSON.stringify(d)),
        champs: () => ["numero", "client.nom", "absent"],
        remplir: (_docx, v) => enc(JSON.stringify(v)),
        enPdf: (docx) => enc(`%PDF-${dec(docx)}`),
      },
    };
    const pdf = (nom: string) => ({ nom, type: "application/pdf", base64: b64(`%PDF-${nom}`) });
    const d = valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        { id: "f", type: "fichier.pdf_fusionner", nom: "f", parametres: { nom: "dossier" } },
        { id: "p", type: "fichier.pdf_pages", nom: "p", parametres: { fichier: "{{ $json.fichier }}", pages: "2-" } },
        { id: "x", type: "fichier.pdf_texte", nom: "x", parametres: { fichier: "{{ $json.fichier }}" } },
        {
          id: "w",
          type: "fichier.document",
          nom: "w",
          parametres: {
            gabarit: { nom: "g.docx", type: "application/octet-stream", base64: b64("PK") },
            champs: [{ nom: "numero", valeur: "{{ $json.pages }}" }],
            format: "docx_pdf",
          },
        },
      ],
      connexions: [
        { de: "t", vers: "f" },
        { de: "f", vers: "p" },
        { de: "p", vers: "x" },
        { de: "x", vers: "w" },
      ],
    });
    const r = await executer(d, [{ json: { fichier: pdf("a.pdf") } }, { json: { fichier: pdf("b.pdf") } }], opts(s));
    expect(r.statut).toBe("succes");
    const [el] = r.sortie as { json: Record<string, any> }[];
    expect(el!.json.texte).toBe("%PDF-a.pdf+b.pdf[2,3,4]\n\nfin");
    expect(el!.json.pages).toBe(2);
    expect(el!.json.manquants).toEqual(["client.nom", "absent"]);
    expect(dec(Uint8Array.fromBase64(el!.json.fichier.base64))).toBe(`{"numero":"2"}`);
    expect(el!.json.fichier.nom).toBe("document.docx");
    expect(el!.json.pdf.type).toBe("application/pdf");
    const sansNatif = await executer(d, [{ json: { fichier: pdf("a.pdf") } }], opts(services()));
    expect(sansNatif.statut).toBe("erreur");
  });
});

describe("caviardage, signature, présentation", () => {
  test("nœuds par services injectés", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (o: Uint8Array) => new TextDecoder().decode(o);
    const appels: unknown[] = [];
    const s: Services = {
      ...services(),
      documents: {
        caviarder: (pdf, o) => {
          appels.push(o);
          return { pdf: enc(`${dec(pdf)}-caviarde`), rapport: { occurrences: 3, pages: [1, 2], par_recherche: [] } };
        },
        signer: (pdf, p12, o) => {
          appels.push({ p12: dec(p12), ...o });
          return enc(`${dec(pdf)}-signe`);
        },
        signatures: (pdf, confiance) => [
          { signee: dec(pdf).endsWith("-signe"), statut: confiance ? "valide" : "inconnue" },
        ],
        presentation: (p) => enc(JSON.stringify(p)),
        presentationEnPdf: (pptx) => enc(`%PDF-${dec(pptx).length}`),
      },
    };
    const d = valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        {
          id: "c",
          type: "fichier.pdf_caviarder",
          nom: "c",
          parametres: {
            fichier: "{{ $json.fichier }}",
            textes: "Zoé Martin\n\n {{ $json.client }} ",
            motifs: ["iban"],
          },
        },
        {
          id: "s",
          type: "fichier.pdf_signer",
          nom: "s",
          parametres: {
            fichier: "{{ $json.fichier }}",
            certificat: "{{ $secret.p12 }}",
            motDePasse: "{{ $secret.mdp }}",
            raison: "Accord",
            visible: true,
            page: 2,
            certifier: "formulaires",
          },
        },
        { id: "v", type: "fichier.pdf_verifier_signature", nom: "v", parametres: { fichier: "{{ $json.fichier }}" } },
      ],
      connexions: [
        { de: "t", vers: "c" },
        { de: "c", vers: "s" },
        { de: "s", vers: "v" },
      ],
    });
    const fichier = { nom: "releve.pdf", type: "application/pdf", base64: enc("%PDF").toBase64() };
    const o = opts(s, { p12: enc("P12").toBase64(), mdp: "secret" });
    const r = await executer(d, [{ json: { fichier, client: "Marc" } }], o);
    expect(r.statut).toBe("succes");
    const [el] = r.sortie as { json: Record<string, any> }[];
    expect(appels[0]).toEqual({
      textes: ["Zoé Martin", "Marc"],
      motifs: ["iban"],
      casse: false,
      mots_entiers: false,
      texte_superpose: "",
    });
    expect(appels[1]).toEqual({
      p12: "P12",
      mot_de_passe: "secret",
      page: 1,
      raison: "Accord",
      rectangle: [36, 36, 236, 96],
      certifier: 2,
    });
    expect(el!.json.fichier.nom).toBe("releve-caviarde-signe.pdf");
    expect(dec(Uint8Array.fromBase64(el!.json.fichier.base64))).toBe("%PDF-caviarde-signe");
    expect(el!.json).toMatchObject({
      occurrences: 3,
      pagesCaviardees: [1, 2],
      signe: true,
      intacte: true,
      valide: false,
    });

    const p = valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        {
          id: "p",
          type: "fichier.presentation",
          nom: "p",
          parametres: { titre: "Bilan", champTitre: "nom", champPuces: "points", format: "pptx_pdf" },
        },
      ],
      connexions: [{ de: "t", vers: "p" }],
    });
    const els = [
      { json: { nom: "Un", points: ["a", { texte: "b", niveau: 9 }, " "] } },
      { json: { nom: "Deux", points: "c\nd", notes: "n" } },
      { json: {} },
    ];
    const rp = await executer(p, els, opts(s));
    expect(rp.statut).toBe("succes");
    const [sortie] = rp.sortie as { json: Record<string, any> }[];
    expect(sortie!.json.diapositives).toBe(3);
    expect(sortie!.json.fichier.nom).toBe("presentation.pptx");
    expect(sortie!.json.pdf.type).toBe("application/pdf");
    expect(JSON.parse(dec(Uint8Array.fromBase64(sortie!.json.fichier.base64)))).toEqual({
      titre: "Bilan",
      sous_titre: "",
      diapositives: [
        { titre: "Un", puces: ["a", { texte: "b", niveau: 4 }], notes: "" },
        { titre: "Deux", puces: ["c", "d"], notes: "n" },
      ],
    });
    const sansNatif = await executer(p, els, opts(services()));
    expect(sansNatif.statut).toBe("erreur");
  });
});

describe("base de connaissances", () => {
  test("indexer un PDF, un texte, rechercher et préparer le contexte", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const indexes: unknown[] = [];
    const recherches: unknown[] = [];
    const s: Services = {
      ...services(),
      pdf: { fusionner: () => enc(""), pages: () => enc(""), nombrePages: () => 1, texte: () => ["page 1", "page 2"] },
      word: { creer: () => enc(""), champs: () => [], remplir: () => enc(""), enPdf: () => enc("") },
      connaissance: {
        async indexer(o) {
          indexes.push(o);
          return { morceaux: 2, remplaces: o.source === "cgv.pdf" ? 1 : 0 };
        },
        async rechercher(o) {
          recherches.push(o);
          return [
            { source: "cgv.pdf", position: 0, texte: "Garantie de deux ans.", score: 0.91 },
            { source: "faq", position: 3, texte: "Retours sous trente jours.", score: 0.72 },
          ];
        },
      },
    };
    const fichier = { nom: "cgv.pdf", type: "application/pdf", base64: enc("%PDF-1.7 cgv").toBase64() };
    const d = valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        {
          id: "i",
          type: "ia.indexer",
          nom: "i",
          parametres: {
            fichier: "{{ $json.fichier }}",
            texte: "{{ $json.texte | defaut:'' }}",
            source: "{{ $json.source | defaut:'' }}",
            cle: "{{ $secret.emb }}",
          },
        },
        {
          id: "r",
          type: "ia.rechercher",
          nom: "r",
          parametres: { question: "Quelle garantie ?", k: 2, scoreMin: 0.5, diversite: 0.7, modele: "bge-m3" },
        },
      ],
      connexions: [
        { de: "t", vers: "i" },
        { de: "i", vers: "r" },
      ],
    });
    const r = await executer(
      d,
      [{ json: { fichier } }, { json: { fichier: null, texte: "# FAQ\n\nRetours sous trente jours.", source: "faq" } }],
      opts(s, { emb: "sk-test" }),
    );
    expect(r.statut).toBe("succes");
    expect(indexes).toEqual([
      {
        base: "documents",
        source: "cgv.pdf",
        texte: "page 1\n\npage 2",
        taille: 1400,
        embeddings: { url: "http://localhost:11434/v1", modele: "nomic-embed-text", cle: "sk-test" },
      },
      {
        base: "documents",
        source: "faq",
        texte: "# FAQ\n\nRetours sous trente jours.",
        taille: 1400,
        embeddings: { url: "http://localhost:11434/v1", modele: "nomic-embed-text", cle: "sk-test" },
      },
    ]);
    expect(recherches[0]).toMatchObject({ base: "documents", question: "Quelle garantie ?", k: 2, scoreMin: 0.5 });
    expect(recherches[0]).toMatchObject({ diversite: 0.7, embeddings: { modele: "bge-m3" } });
    const [el] = r.sortie as { json: Record<string, any> }[];
    expect(el!.json.trouves).toBe(2);
    expect(el!.json.morceaux).toBe(2);
    expect(el!.json.remplaces).toBe(1);
    expect(el!.json.contexte).toBe(
      "[cgv.pdf, partie 1]\nGarantie de deux ans.\n\n---\n\n[faq, partie 4]\nRetours sous trente jours.",
    );

    const vide = valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        { id: "i", type: "ia.indexer", nom: "i", parametres: { texte: "  ", source: "x" } },
      ],
      connexions: [{ de: "t", vers: "i" }],
    });
    expect((await executer(vide, [{ json: {} }], opts(s))).erreur?.message).toMatch(/aucun texte/);
    expect(() =>
      valider({
        noeuds: [
          { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
          { id: "r", type: "ia.rechercher", nom: "r", parametres: { base: "Mauvaise Base", question: "q" } },
        ],
        connexions: [{ de: "t", vers: "r" }],
      }),
    ).toThrow();
    const sans = await executer(d, [{ json: { fichier } }], opts(services()));
    expect(sans.statut).toBe("erreur");
  });
});

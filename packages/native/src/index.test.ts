import { expect, test } from "bun:test";
import {
  caviarderPdf,
  creerPptx,
  decouperTexte,
  plusProches,
  datePdf,
  pptxEnPdf,
  signerPdf,
  verifierSignaturesPdf,
  champsDocx,
  creerDocx,
  docxEnPdf,
  extrairePagesPdf,
  fusionnerPdf,
  remplirDocx,
  textePdf,
  texteDocx,
  dateExcel,
  ecrireXlsx,
  lireTableur,
  ErreurNative,
  extraireXml,
  totalTtcCents,
  facturx,
  rendrePdf,
  verifierPdfA,
  xmlCii,
} from "./index";

const facture = {
  numero: "F-2026-0001",
  type: "facture",
  date: "2026-10-22",
  emetteur: { nom: "Alpha", siret: "73282932000074", adresse: "1 rue A, Paris", tvaIntracom: "FR44732829320" },
  client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [{ designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tva: 200 }],
  datePrestation: "2026-10-15",
  echeance: "2026-11-21",
  penalitesRetard: "3 fois le taux d'intérêt légal",
  escompte: "aucun",
};

test("rendu PDF", () => {
  const pdf = rendrePdf({ ...facture, type: "devis", numero: "" });
  expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
});

test("Factur-X conforme, XML extractible", () => {
  const pdf = facturx(facture, new Date("2026-10-22T10:00:00Z"));
  expect(verifierPdfA(pdf)).toEqual([]);
  const xml = extraireXml(pdf)!;
  expect(xml).toBe(xmlCii(facture));
  expect(xml).toContain("<ram:GrandTotalAmount>2160.00</ram:GrandTotalAmount>");
  expect(extraireXml(rendrePdf(facture))).toBeNull();
});

test("erreurs remontées", () => {
  expect(() => xmlCii({ ...facture, type: "devis" })).toThrow(ErreurNative);
  expect(() => rendrePdf({})).toThrow(/missing field/);
});

test("total TTC lu dans le XML", () => {
  expect(totalTtcCents("<ram:GrandTotalAmount>2160.05</ram:GrandTotalAmount>")).toBe(216005);
  expect(totalTtcCents("<ram:GrandTotalAmount>-12.30</ram:GrandTotalAmount>")).toBe(-1230);
  expect(totalTtcCents("<x/>")).toBeNull();
});

test("tableur : écriture xlsx typée, relecture, csv", () => {
  const xlsx = ecrireXlsx({
    feuilles: [
      {
        nom: "Ventes",
        colonnes: [{ titre: "Date", type: "date" }, { titre: "Client" }, { titre: "TTC", type: "euros" }],
        lignes: [["2026-10-22", "Dupont", 216000]],
      },
    ],
  });
  const l = lireTableur(xlsx);
  expect(l.format).toBe("xlsx");
  expect(l.feuilles[0]!.lignes[1]).toEqual([46317, "Dupont", 2160]);
  expect(dateExcel(46317)).toBe("2026-10-22");
  expect(lireTableur(new TextEncoder().encode("a;b\n1;x\n")).feuilles[0]!.lignes).toEqual([
    ["a", "b"],
    [1, "x"],
  ]);
  expect(() => ecrireXlsx({ feuilles: [] })).toThrow(ErreurNative);
});

test("PDF : fusion, pages, texte", () => {
  const a = rendrePdf({ ...facture, type: "devis", numero: "D-1" });
  const b = docxEnPdf(creerDocx({ titre: "Annexe", paragraphes: [{ texte: "Conditions générales" }] }));
  const f = fusionnerPdf([
    { nom: "devis.pdf", octets: a },
    { nom: "annexe.pdf", octets: b },
  ]);
  const pages = textePdf(f);
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain("D-1");
  expect(pages[1]).toContain("Conditions générales");
  expect(textePdf(extrairePagesPdf(f, [2]))).toEqual([pages[1]!]);
  expect(() => extrairePagesPdf(f, [3])).toThrow(ErreurNative);
  expect(() => textePdf(new TextEncoder().encode("rien"))).toThrow(ErreurNative);
});

test("Word : gabarit, texte, PDF", () => {
  const gabarit = creerDocx({
    titre: "Devis {{ numero }}",
    paragraphes: [{ texte: "Pour {{ client }}, {{ client }}" }, { texte: "Reste {{ autre }}" }],
  });
  expect(new TextDecoder().decode(gabarit.subarray(0, 2))).toBe("PK");
  expect(champsDocx(gabarit)).toEqual(["numero", "client", "autre"]);
  const d = remplirDocx(gabarit, { numero: "D-7", client: "Zoé" });
  expect(texteDocx(d)).toBe("Devis D-7\nPour Zoé, Zoé\nReste {{ autre }}");
  expect(textePdf(docxEnPdf(d))[0]).toContain("Pour Zoé, Zoé");
});

const donneesSignature = (nom: string) =>
  Bun.file(new URL(`../../../vendor/suite/crates/pdfcraft-sign/tests/data/${nom}`, import.meta.url));

test("PDF : caviardage définitif", () => {
  const pdf = docxEnPdf(
    creerDocx({
      titre: "Relevé",
      paragraphes: [
        { texte: "Contact zoe@exemple.fr, IBAN FR76 3000 6000 0112 3456 7890 189" },
        { texte: "Zoé Martin" },
      ],
    }),
  );
  const { pdf: caviarde, rapport } = caviarderPdf(pdf, { textes: ["zoé martin"], motifs: ["email", "iban"] });
  expect(rapport.occurrences).toBe(3);
  expect(rapport.pages).toEqual([1]);
  const texte = textePdf(caviarde).join("\n");
  expect(texte).toContain("Contact");
  for (const absent of ["zoe@", "FR76", "Martin"]) expect(texte).not.toContain(absent);
  expect(caviarderPdf(pdf, { textes: ["absent"] }).rapport.occurrences).toBe(0);
  expect(() => caviarderPdf(pdf, {})).toThrow(ErreurNative);
});

test("PDF : signature PAdES et vérification", async () => {
  const p12 = await donneesSignature("rsa-aes.p12").bytes();
  const pdf = docxEnPdf(creerDocx({ titre: "Contrat", paragraphes: [] }));
  expect(verifierSignaturesPdf(pdf)).toEqual([]);
  const signe = signerPdf(pdf, p12, { mot_de_passe: "test", raison: "Accord" });
  const [s] = verifierSignaturesPdf(signe);
  expect(s).toMatchObject({
    statut: "inconnue",
    signataire: "Test Signer RSA",
    raison: "Accord",
    modifications: "aucune",
  });
  expect(s!.format).toBe("ETSI.CAdES.detached");
  expect(verifierSignaturesPdf(signe, await donneesSignature("rsa.crt.pem").text())[0]!.statut).toBe("valide");
  expect(() => signerPdf(pdf, p12, { mot_de_passe: "faux" })).toThrow(ErreurNative);
  expect(datePdf(new Date("2026-10-23T12:34:56Z"))).toBe("D:20261023123456Z");
});

test("Présentation : PPTX et PDF", () => {
  const pptx = creerPptx({
    titre: "Bilan",
    sous_titre: "Atelier",
    diapositives: [{ titre: "Chiffres", puces: ["CA en hausse", { texte: "services", niveau: 1 }] }],
  });
  expect(new TextDecoder().decode(pptx.subarray(0, 2))).toBe("PK");
  const pages = textePdf(pptxEnPdf(pptx));
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain("Bilan");
  expect(pages[1]).toContain("CA en hausse");
  expect(() => creerPptx({ diapositives: [] })).toThrow(ErreurNative);
});

test("connaissance : découpage prose et Markdown, plus proches voisins", () => {
  const prose = decouperTexte("contrat.pdf", "Le contrat couvre les pièces et la main-d'œuvre. ".repeat(50), 400);
  expect(prose.length).toBeGreaterThan(4);
  expect(prose.map((m) => m.position)).toEqual(prose.map((_, i) => i));
  expect(prose[0]!.titre).toBeNull();
  const md = decouperTexte("guide.md", "# Guide\n\n## Garantie\n\nDeux ans.\n\n## Retours\n\nTrente jours.\n");
  expect(md.find((m) => m.texte.includes("Deux ans"))!.titre).toBe("Guide > Garantie");
  expect(() => decouperTexte("a.txt", "x", 10)).toThrow(ErreurNative);

  const matrice = Float32Array.from([1, 0, 0, 0, 1, 0, 0.6, 0.8, 0]);
  const r = plusProches([0, 2, 0], matrice, 3, 2);
  expect(r.map((x) => x.indice)).toEqual([1, 2]);
  expect(r[0]!.score).toBeCloseTo(1, 5);
  expect(r[1]!.score).toBeCloseTo(0.8, 5);
  expect(plusProches([1, 0, 0], matrice, 3, 3, 0.5)[0]!.indice).toBe(0);
  expect(() => plusProches([1, 0], matrice, 3, 2)).toThrow(ErreurNative);
});

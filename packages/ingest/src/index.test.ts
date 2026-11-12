import { afterAll, beforeAll, expect, test } from "bun:test";
import { avecMentionsParDefaut, type Document } from "@auto/domain";
import { facturx, rendrePdf, xmlCii } from "@auto/native";
import { centimes, clientOpenAi, ingerer, lireCii, texteDuPdf, valider, type FactureRecue } from "./index";

const doc: Document = avecMentionsParDefaut({
  type: "facture",
  date: "2026-10-22",
  echeance: "2026-11-21",
  datePrestation: "2026-10-15",
  emetteur: {
    nom: "Fournisseur & Fils",
    siret: "73282932000074",
    adresse: "1 rue de la Paix, 75002 Paris",
    tvaIntracom: "FR44732829320",
  },
  client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [
    { designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tva: 200 },
    { designation: "Livre", quantite: 2, prixUnitaireHtCents: 1050, tva: 55 },
  ],
});
const numerote = { ...doc, numero: "F-2026-0042" };
const AUJ = "2026-10-22";

// Résultat attendu, identique quelle que soit la voie (Factur-X ou OCR + LLM).
const attendu: FactureRecue = {
  type: "facture",
  numero: "F-2026-0042",
  date: "2026-10-22",
  echeance: "2026-11-21",
  datePrestation: "2026-10-15",
  devise: "EUR",
  fournisseur: {
    nom: "Fournisseur & Fils",
    siren: "732829320",
    tvaIntracom: "FR44732829320",
    adresse: "1 rue de la Paix, 75002 Paris",
  },
  acheteur: { nom: "Client SAS", siren: "732829320" },
  lignes: [
    { designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tauxTva: 200, htCents: 180000 },
    { designation: "Livre", quantite: 2, prixUnitaireHtCents: 1050, tauxTva: 55, htCents: 2100 },
  ],
  totaux: { htCents: 182100, tvaCents: 36116, ttcCents: 218216 },
};

// Faux llama-server : renvoie la réponse programmée et garde les requêtes reçues.
let reponse = "";
const recues: Record<string, unknown>[] = [];
let llm: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  llm = Bun.serve({
    port: 0,
    routes: {
      "/v1/chat/completions": {
        POST: async (req) => {
          recues.push((await req.json()) as Record<string, unknown>);
          return Response.json({ choices: [{ message: { role: "assistant", content: reponse } }] });
        },
      },
    },
  });
});
afterAll(() => llm.stop(true));
const client = () => clientOpenAi({ url: `${llm.url}v1`, modele: "test" });
const enLlm = (f: unknown) => JSON.stringify(f);
const pourSchema = (f: FactureRecue) => ({
  ...f,
  fournisseur: { siret: null, ...f.fournisseur },
});

test("centimes sans erreur binaire", () => {
  expect(centimes("2182.16")).toBe(218216);
  expect(centimes("0.29")).toBe(29);
  expect(centimes("10.505")).toBe(1051);
  expect(centimes("-3.10")).toBe(-310);
});

test("XML CII → JSON normalisé, cohérent", () => {
  const f = lireCii(xmlCii(numerote));
  expect(f).toEqual(attendu);
  expect(valider(f!, AUJ)).toEqual([]);
});

test("Factur-X généré par l'API : lecture directe du XML, validée", async () => {
  const r = await ingerer(facturx(numerote, new Date("2026-10-22T10:00:00Z")), {
    aujourdhui: AUJ,
    ocr: () => Promise.reject(new Error("pas d'OCR pour un Factur-X")),
  });
  expect(r).toEqual({ source: "facturx", statut: "validee", facture: attendu, anomalies: [] });
});

test("PDF sans XML : OCR puis LLM en JSON Schema strict, validé", async () => {
  reponse = enLlm(pourSchema(attendu));
  const r = await ingerer(rendrePdf(numerote), {
    aujourdhui: AUJ,
    llm: client(),
    ocr: async () => "FACTURE F-2026-0042 …",
  });
  expect(r.statut).toBe("validee");
  expect(r.source).toBe("ocr");
  expect(r.facture).toEqual({ ...attendu, fournisseur: { ...attendu.fournisseur } });
  const req = recues.at(-1)!;
  expect(req.cache_prompt).toBe(false);
  expect((req.response_format as { type: string; json_schema: { strict: boolean } }).json_schema.strict).toBe(true);
  expect(JSON.stringify(req.messages)).toContain("FACTURE F-2026-0042");
});

test("LLM incohérent ou hors schéma : file à vérifier", async () => {
  const o = { aujourdhui: AUJ, llm: client(), ocr: async () => "texte" };
  reponse = enLlm(pourSchema({ ...attendu, totaux: { ...attendu.totaux, ttcCents: 999 } }));
  let r = await ingerer(rendrePdf(numerote), o);
  expect(r.statut).toBe("a_verifier");
  expect(r.anomalies[0]).toContain("HT + TVA ≠ TTC");

  reponse = enLlm({ numero: "X" });
  r = await ingerer(rendrePdf(numerote), o);
  expect(r).toMatchObject({ statut: "a_verifier", facture: null });
  expect(r.anomalies[0]).toContain("hors schéma");

  reponse = "désolé";
  expect((await ingerer(rendrePdf(numerote), o)).anomalies).toEqual(["réponse du LLM non JSON"]);
  expect((await ingerer(rendrePdf(numerote), { ...o, llm: null })).anomalies[0]).toContain("AUTO_LLM_URL");
  expect((await ingerer(rendrePdf(numerote), { ...o, ocr: async () => " " })).anomalies[0]).toContain("aucun texte");
  expect((await ingerer(new TextEncoder().encode("bonjour"), o)).anomalies[0]).toContain("format non reconnu");
});

test("contrôles : SIREN, TVA, dates, totaux", () => {
  const f = structuredClone(attendu);
  f.fournisseur.siren = "123456789";
  f.echeance = "2026-10-01";
  f.date = "2026-10-22";
  f.lignes[0]!.htCents = 190000;
  const a = valider(f, AUJ);
  expect(a).toContain("SIREN 123456789 invalide");
  expect(a).toContain("échéance antérieure à la date de facture");
  expect(a.some((x) => x.startsWith("ligne 1"))).toBe(true);
  expect(a.some((x) => x.startsWith("somme des lignes"))).toBe(true);
  expect(
    valider({ ...attendu, fournisseur: { ...attendu.fournisseur, tvaIntracom: "FR00732829320" } }, AUJ)[0],
  ).toContain("discordante");
  expect(valider({ ...attendu, date: "2026-02-30" }, AUJ)).toContain("date 2026-02-30 invalide");
  expect(valider({ ...attendu, date: "2027-01-01" }, AUJ)).toContain("date 2027-01-01 dans le futur");
});

test.skipIf(!Bun.which("pdftotext"))("OCR par défaut : couche texte du PDF (pdftotext)", async () => {
  expect(await texteDuPdf(rendrePdf(numerote))).toContain("F-2026-0042");
});

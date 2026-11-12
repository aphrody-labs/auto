// Code JavaScript embarqué dans le workflow n8n, exécuté avec de fausses données (comme dans n8n : $, $input, this.helpers).
import { expect, test } from "bun:test";

const wf = (await Bun.file(new URL("../workflow/Workflow_n8n_Factures_Fournisseurs.json", import.meta.url)).json()) as {
  nodes: { name: string; parameters: { jsCode?: string } }[];
};
const code = (n: string) => wf.nodes.find((x) => x.name === n)!.parameters.jsCode!;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...a: string[]
) => (...a: unknown[]) => Promise<unknown>;

type Json = Record<string, any>;
const parametres = (p: Json) => () => ({ first: () => ({ json: p }), all: () => [{ json: p }] });
const executer = async (nom: string, p: Json, entree: Json[], helpers: Json = {}) =>
  (await new AsyncFunction("$", "$input", code(nom)).call({ helpers }, parametres(p), {
    first: () => entree[0],
    all: () => entree,
  })) as { json: Json }[];

const WINDOWS = {
  path: String.raw`\\SERVEUR\Scans\A_traiter\2026-10-12_Point-P_F20481.pdf`,
  nomFichier: "2026-10-12_Point-P_F20481.pdf",
  racine: "//SERVEUR/Scans",
  systeme: "windows",
  modele: "claude-sonnet-5-5",
};
const lecture = (input: Json) => ({ content: [{ type: "tool_use", input }] });
const FACTURE = {
  type_document: "facture",
  fournisseur_nom: "Matériaux du Sud",
  fournisseur_siret: "123 456 789 00011",
  numero_facture: "F-20481",
  date_facture: "2026-10-12",
  montant_ht: 1250,
  montant_tva: 250,
  montant_ttc: 1500,
  reference_chantier: "Dupont 2026",
  compte_charge_suggere: "601000",
  confiance: "haute",
};

test("requête Claude : PDF en base64 et outil d'extraction imposé", async () => {
  const [r] = await executer(
    "Préparer la requête Claude",
    WINDOWS,
    [{ binary: { data: { mimeType: "application/pdf" } }, json: {} }],
    {
      getBinaryDataBuffer: async () => Buffer.from("PDFDATA"),
    },
  );
  const b = r!.json.requestBody;
  expect(b.model).toBe("claude-sonnet-5-5");
  expect(b.messages[0].content[0]).toMatchObject({
    type: "document",
    source: { data: Buffer.from("PDFDATA").toString("base64") },
  });
  expect(b.tool_choice.name).toBeString();
});

test("validation : facture cohérente, écart de montants, erreur de l'API", async () => {
  const [ok] = await executer("Valider et normaliser", WINDOWS, [{ json: lecture(FACTURE) }]);
  expect(ok!.json.controle).toBe("OK");
  expect(ok!.json.SIRET).toBe("12345678900011");
  expect(ok!.json.commandeRanger).toBeString();
  const [ecart] = await executer("Valider et normaliser", WINDOWS, [
    { json: lecture({ ...FACTURE, montant_ttc: 1600 }) },
  ]);
  expect(ecart!.json.controle).not.toBe("OK");
  expect(ecart!.json.problemes.length).toBeGreaterThan(0);
  const [erreur] = await executer("Valider et normaliser", WINDOWS, [{ json: { error: { message: "rate limited" } } }]);
  expect(erreur!.json.lectureOk).toBe(false);
});

test("rangement sous Linux : chemin échappé pour le shell", async () => {
  const linux = { ...WINDOWS, systeme: "linux", path: "/data/scans/A_traiter/d'Artagnan.pdf", racine: "/data/scans" };
  const [r] = await executer("Valider et normaliser", linux, [{ json: lecture(FACTURE) }]);
  expect(r!.json.commandeRanger).toContain(`'/data/scans/A_traiter/d'\\''Artagnan.pdf'`);
});

test("récapitulatif quotidien : retards, échéances à 7 jours, factures à vérifier", async () => {
  const serie = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000) + 25569;
  const lignes = [
    {
      "N° facture": "A1",
      Fournisseur: "Élec Plus",
      Statut: "En retard",
      "Reste dû": 5760,
      Échéance: serie - 20,
      "Jours de retard": 20,
    },
    { "N° facture": "B2", Fournisseur: "Loc", Statut: "À payer", "Reste dû": 1104, Échéance: serie + 3 },
    {
      "N° facture": "C3",
      Fournisseur: "Durand",
      Statut: "À payer",
      "Reste dû": 102,
      Échéance: serie + 25,
      "Code fournisseur": "À CRÉER",
      "Contrôle OCR": "À VÉRIFIER",
    },
    { "N° facture": "" },
  ];
  const [r] = await executer(
    "Préparer le récapitulatif",
    WINDOWS,
    lignes.map((json) => ({ json })),
  );
  expect(r!.json.sujet).toBe("Factures fournisseurs : 1 en retard, 1 à payer sous 7 jours");
  expect(r!.json.texte).toContain("Élec Plus | facture A1");
  expect(r!.json.texte).toContain("À VÉRIFIER DANS LE JOURNAL (1)");
});

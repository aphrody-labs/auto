// Ingestion des factures fournisseurs : Factur-X (XML CII lu directement) ou PDF (OCR puis LLM
// contraint par JSON Schema), puis contrôles. Fonctions sans état : aucun cache entre deux appels,
// donc rien ne passe d'un tenant à l'autre.
import { extraireXml } from "@auto/native";
import { lireCii } from "./cii";
import { conforme, SCHEMA, sansNuls, valider, type FactureRecue, type Source } from "./facture";
import type { ClientLlm } from "./llm";
import { ocrParDefaut, type Ocr } from "./ocr";

export * from "./facture";
export * from "./devis";
export { analyserXml, centimes, lireCii } from "./cii";
export * from "./llm";
export * from "./ocr";

export type StatutRecue = "a_verifier" | "validee" | "rejetee";

export interface Resultat {
  source: Source | null;
  statut: Exclude<StatutRecue, "rejetee">;
  facture: FactureRecue | null;
  anomalies: string[];
}

export interface OptionsIngestion {
  ocr?: Ocr;
  /** Sans LLM, un PDF sans XML part directement dans la file « à vérifier ». */
  llm?: ClientLlm | null;
  aujourdhui?: string;
  /** Texte OCR transmis au LLM, tronqué (caractères). */
  maxTexte?: number;
}

const PROMPT = `Tu extrais les données d'une facture fournisseur française à partir de son texte OCR.
Réponds uniquement par un objet JSON conforme au schéma fourni.
- Montants en centimes entiers (12,50 € = 1250) ; taux de TVA en dixièmes de pourcent (20 % = 200, 5,5 % = 55).
- Dates au format AAAA-MM-JJ ; devise en code ISO 4217 (EUR par défaut).
- SIREN : 9 chiffres ; SIRET : 14 chiffres ; sans espaces.
- N'invente rien : null pour un champ absent du texte.`;

const debut = (o: Uint8Array, s: string) => new TextDecoder().decode(o.subarray(0, 64)).trimStart().startsWith(s);

function conclure(source: Source, f: FactureRecue, anomalies: string[], aujourdhui?: string): Resultat {
  const a = [...anomalies, ...valider(f, aujourdhui)];
  return { source, statut: a.length ? "a_verifier" : "validee", facture: f, anomalies: a };
}

/** Extraction par LLM d'un texte OCR, en JSON contraint par SCHEMA puis revérifié. */
export async function extraireParLlm(llm: ClientLlm, texte: string, max = 24_000): Promise<FactureRecue> {
  const r = await llm.completer({
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: texte.slice(0, max) },
    ],
    schema: { nom: "facture_recue", schema: SCHEMA },
  });
  let v: unknown;
  try {
    v = JSON.parse((r.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("réponse du LLM non JSON");
  }
  const ecarts = conforme(SCHEMA, v);
  if (ecarts.length) throw new Error(`réponse du LLM hors schéma : ${ecarts.slice(0, 5).join(" ; ")}`);
  return sansNuls(v as FactureRecue);
}

/** Fichier reçu (PDF Factur-X, PDF simple ou XML CII) → facture normalisée et statut. */
export async function ingerer(fichier: Uint8Array, o: OptionsIngestion = {}): Promise<Resultat> {
  const xml = debut(fichier, "<")
    ? new TextDecoder().decode(fichier)
    : debut(fichier, "%PDF")
      ? extraireXml(fichier)
      : null;
  if (xml) {
    const f = lireCii(xml);
    if (f) return conclure("facturx", f, [], o.aujourdhui);
    if (!debut(fichier, "%PDF"))
      return { source: null, statut: "a_verifier", facture: null, anomalies: ["XML non CII"] };
  }
  if (!debut(fichier, "%PDF"))
    return {
      source: null,
      statut: "a_verifier",
      facture: null,
      anomalies: ["format non reconnu (PDF ou XML CII attendu)"],
    };

  const texte = await (o.ocr ?? ocrParDefaut)(fichier);
  if (!texte.trim())
    return {
      source: "ocr",
      statut: "a_verifier",
      facture: null,
      anomalies: ["aucun texte lisible (OCR indisponible ou vide)"],
    };
  if (!o.llm)
    return { source: "ocr", statut: "a_verifier", facture: null, anomalies: ["LLM non configuré (AUTO_LLM_URL)"] };
  try {
    return conclure("ocr", await extraireParLlm(o.llm, texte, o.maxTexte), [], o.aujourdhui);
  } catch (e) {
    return { source: "ocr", statut: "a_verifier", facture: null, anomalies: [(e as Error).message] };
  }
}

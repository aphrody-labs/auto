import {
  creerDocx,
  ecrireXlsx,
  texteDocx,
  champsDocx,
  nombrePagesPdf,
  textePdf,
  lireTableur,
  modifierXlsx,
  remplacerDocx,
  remplirDocx,
  docxEnPdf,
  extrairePagesPdf,
} from "@auto/native";
import { ErreurMetier, type FormatAtelier, type OperationAtelier } from "@auto/store";
export type { OperationAtelier } from "@auto/store";
export const MIMES_ATELIER = {
  word: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;
const EXTENSIONS = { word: "docx", excel: "xlsx", pdf: "pdf" } as const;
export function nomAtelier(nom: unknown, format?: FormatAtelier) {
  if (
    typeof nom !== "string" ||
    !nom.trim() ||
    nom.length > 200 ||
    [...nom].some((c) => c.charCodeAt(0) < 32 || "/\\".includes(c))
  )
    throw new ErreurMetier("nom de fichier invalide");
  const n = nom.trim();
  if (format && !n.toLowerCase().endsWith("." + EXTENSIONS[format]))
    throw new ErreurMetier("extension incompatible avec ce document");
  return n;
}
export function formatAtelier(nom: string): FormatAtelier {
  const ext = nom.split(".").at(-1)?.toLowerCase();
  if (ext === "docx") return "word";
  if (ext === "xlsx") return "excel";
  if (ext === "pdf") return "pdf";
  throw new ErreurMetier("formats acceptés : DOCX, XLSX et PDF");
}
export function decoderAtelier(base64: unknown) {
  if (typeof base64 !== "string" || base64.length > 28_000_000)
    throw new ErreurMetier("pièce absente ou trop volumineuse", [], 413);
  let b: Uint8Array<ArrayBuffer>;
  try {
    b = Uint8Array.fromBase64(base64);
  } catch {
    throw new ErreurMetier("contenu du fichier invalide");
  }
  if (!b.length || b.length > 20 * 1024 * 1024) throw new ErreurMetier("pièce vide ou supérieure à 20 Mo", [], 413);
  return b;
}
export function inspecterAtelier(contenu: Uint8Array, format: FormatAtelier) {
  try {
    if (!contenu.length || contenu.length > 20 * 1024 * 1024) throw new Error("taille invalide");
    if (format === "word") return { format, champs: champsDocx(contenu), extrait: texteDocx(contenu).slice(0, 4000) };
    if (format === "pdf") {
      const pages = nombrePagesPdf(contenu);
      if (!pages || pages > 500) throw new Error("entre 1 et 500 pages attendues");
      return { format, pages, extrait: textePdf(contenu).join("\n").slice(0, 4000) };
    }
    const c = lireTableur(contenu);
    if (c.format !== "xlsx") throw new Error("classeur XLSX attendu");
    return {
      format,
      feuilles: c.feuilles.map((f) => ({
        nom: f.nom,
        lignes: f.lignes.length,
        apercu: f.lignes.slice(0, 20).map((l) => l.slice(0, 20)),
      })),
      avertissements: c.avertissements,
    };
  } catch (e) {
    throw new ErreurMetier("document illisible ou non pris en charge", [(e as Error).message]);
  }
}
export function nouveauAtelier(format: FormatAtelier) {
  if (format === "word") return creerDocx({ titre: "", paragraphes: [{ texte: "" }] });
  if (format === "excel")
    return ecrireXlsx({
      feuilles: [
        { nom: "Feuille 1", colonnes: [{ titre: "Désignation" }, { titre: "Montant", type: "nombre" }], lignes: [] },
      ],
    });
  throw new ErreurMetier("importez un PDF existant ou exportez un document Word en PDF");
}
export function modifierAtelier(contenu: Uint8Array, format: FormatAtelier, o: OperationAtelier) {
  try {
    if (format === "excel" && o.type === "cellules" && Array.isArray(o.editions))
      return modifierXlsx(contenu, o.editions);
    if (format === "word" && o.type === "remplacer" && Array.isArray(o.remplacements))
      return remplacerDocx(contenu, o.remplacements);
    if (
      format === "word" &&
      o.type === "champs" &&
      o.valeurs &&
      typeof o.valeurs === "object" &&
      !Array.isArray(o.valeurs) &&
      Object.keys(o.valeurs).length <= 200 &&
      Object.values(o.valeurs).every((v) => typeof v === "string" && v.length <= 100_000)
    )
      return remplirDocx(contenu, o.valeurs);
    if (
      format === "pdf" &&
      o.type === "pages" &&
      Array.isArray(o.pages) &&
      o.pages.length &&
      o.pages.length <= 500 &&
      o.pages.every((p) => Number.isSafeInteger(p) && p >= 1)
    )
      return extrairePagesPdf(
        contenu,
        o.pages.map((p) => p - 1),
      );
    throw new Error("opération incompatible avec ce format");
  } catch (e) {
    throw new ErreurMetier("modification refusée", [(e as Error).message]);
  }
}
export function exporterAtelierPdf(contenu: Uint8Array, format: FormatAtelier) {
  if (format === "word") {
    try {
      return docxEnPdf(contenu);
    } catch (e) {
      throw new ErreurMetier("export PDF impossible", [(e as Error).message]);
    }
  }
  if (format === "pdf") return contenu;
  throw new ErreurMetier("exportez le classeur en PDF depuis l’éditeur Excel");
}

// Document Studio service: inspect, create, transform, sign, and convert DOCX, XLSX, PPTX, and PDF files.
import {
  createDocx,
  docxTemplateFields,
  docxText,
  docxToPdf,
  extractPdfPages,
  fillDocxTemplate,
  mergePdfs,
  modifyXlsx,
  pdfPageCount,
  pdfText,
  pptxToPdf,
  readSpreadsheet,
  redactPdf,
  replaceDocx,
  writeXlsx,
  type CellEdit,
  type RedactionPattern,
} from "@aphrody/auto-native";
import { StoreError } from "@aphrody/auto-store";

export const STUDIO_MIMES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
} as const;

export type StudioFormat = keyof typeof STUDIO_MIMES;

export type StudioOperation =
  | { type: "fill_docx"; values: Record<string, string> }
  | { type: "replace_docx"; search: string; replace: string }
  | { type: "docx_to_pdf" }
  | { type: "pptx_to_pdf" }
  | { type: "xlsx_edit"; edits: CellEdit[] }
  | { type: "pdf_extract"; pages: number[] }
  | { type: "pdf_redact"; patterns: RedactionPattern[] };

export function validateStudioFilename(name: string, format?: StudioFormat): string {
  const clean = name.trim();
  if (!clean || clean.length > 200 || [...clean].some((c) => c.charCodeAt(0) < 32 || "/\\".includes(c))) {
    throw new StoreError("Invalid studio filename", [], 400);
  }
  if (format && !clean.toLowerCase().endsWith(`.${format}`)) {
    throw new StoreError(`Filename must end with .${format}`, [], 400);
  }
  return clean;
}

export function detectStudioFormat(filename: string): StudioFormat {
  const ext = filename.split(".").at(-1)?.toLowerCase();
  if (ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf") return ext;
  throw new StoreError("Supported studio formats: docx, xlsx, pptx, pdf", [], 400);
}

export function inspectStudioFile(bytes: Uint8Array, format: StudioFormat) {
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) {
    throw new StoreError("Studio file must be between 1 byte and 20 MiB", [], 400);
  }
  if (format === "docx") {
    return {
      format,
      fields: docxTemplateFields(bytes),
      preview: docxText(bytes).slice(0, 4000),
    };
  }
  if (format === "pdf") {
    return {
      format,
      pages: pdfPageCount(bytes),
      preview: pdfText(bytes).join("\n").slice(0, 4000),
    };
  }
  if (format === "xlsx") {
    const book = readSpreadsheet(bytes);
    return {
      format,
      sheets: book.sheets.map((s) => ({
        name: s.name,
        rows: s.rows.length,
        preview: s.rows.slice(0, 20).map((r) => r.slice(0, 20)),
      })),
      warnings: book.warnings,
    };
  }
  throw new StoreError("PPTX inspection only supports PDF conversion", [], 400);
}

export function createBlankStudioFile(format: "docx" | "xlsx"): Uint8Array<ArrayBuffer> {
  if (format === "docx") {
    return createDocx({ title: "Document", paragraphs: [{ text: "" }] });
  }
  return writeXlsx({
    sheets: [{ name: "Sheet 1", columns: [{ title: "Item" }, { title: "Amount", type: "euros" }], rows: [] }],
  });
}

export function applyStudioOperation(
  bytes: Uint8Array,
  format: StudioFormat,
  op: StudioOperation,
): { bytes: Uint8Array<ArrayBuffer>; format: StudioFormat; mimeType: string; meta?: Record<string, unknown> } {
  if (format === "docx" && op.type === "fill_docx") {
    return { bytes: fillDocxTemplate(bytes, op.values), format: "docx", mimeType: STUDIO_MIMES.docx };
  }
  if (format === "docx" && op.type === "replace_docx") {
    return {
      bytes: replaceDocx(bytes, [{ find: op.search, replace: op.replace }]),
      format: "docx",
      mimeType: STUDIO_MIMES.docx,
    };
  }
  if (format === "docx" && op.type === "docx_to_pdf") {
    return { bytes: docxToPdf(bytes), format: "pdf", mimeType: STUDIO_MIMES.pdf };
  }
  if (format === "pptx" && op.type === "pptx_to_pdf") {
    return { bytes: pptxToPdf(bytes), format: "pdf", mimeType: STUDIO_MIMES.pdf };
  }
  if (format === "xlsx" && op.type === "xlsx_edit") {
    return { bytes: modifyXlsx(bytes, op.edits), format: "xlsx", mimeType: STUDIO_MIMES.xlsx };
  }
  if (format === "pdf" && op.type === "pdf_extract") {
    return { bytes: extractPdfPages(bytes, op.pages), format: "pdf", mimeType: STUDIO_MIMES.pdf };
  }
  if (format === "pdf" && op.type === "pdf_redact") {
    const res = redactPdf(bytes, { patterns: op.patterns });
    return { bytes: res.pdf, format: "pdf", mimeType: STUDIO_MIMES.pdf, meta: { report: res.report } };
  }
  throw new StoreError(`Operation ${op.type} is incompatible with format ${format}`, [], 400);
}

export function mergeStudioPdfs(inputs: { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  return mergePdfs(inputs);
}

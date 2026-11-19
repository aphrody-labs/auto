// Pure WebAssembly bridge to `crates/auto-ffi` (`wasm-bindgen --target web`).
// Supports explicit static `.wasm` import in Cloudflare Workers (`initNative(wasmModule)`)
// and lazy local byte loading in Bun/self-hosted environments (zero top-level `node:fs` import).
import type { Native } from "@aphrody/auto-platform";
import type { Locale } from "@aphrody/auto-platform/i18n";
import * as rawWasm from "../wasm/auto_ffi.js";

export type { Locale };

interface WasmBindings {
  initSync(input: { module: BufferSource | WebAssembly.Module } | BufferSource | WebAssembly.Module): unknown;
  call_wasm?: (op: string, input: Uint8Array | number[]) => Uint8Array;
}

const wasm = rawWasm as unknown as WasmBindings;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class NativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeError";
  }
}

let initialized = false;

/**
 * Initialize the underlying Wasm module synchronously.
 * In Cloudflare Workers, pass the static `.wasm` import: `initNative(wasmModule)`.
 * In Bun, omit the argument to load `wasm/auto_ffi_bg.wasm` from disk.
 */
export function initNative(module?: WebAssembly.Module | BufferSource): void {
  if (initialized) return;
  if (module) {
    wasm.initSync({ module });
    initialized = true;
    return;
  }
  const fs = process.getBuiltinModule?.("node:fs") as { readFileSync(path: URL): Uint8Array } | undefined;
  if (!fs) {
    throw new NativeError("Edge/browser runtimes must initialize native Wasm via initNative(wasmModule)");
  }
  const bytes = fs.readFileSync(new URL("../wasm/auto_ffi_bg.wasm", import.meta.url));
  wasm.initSync({ module: bytes });
  initialized = true;
}

export function isEnglishWasmReady(): boolean {
  try {
    initNative();
    return typeof wasm.call_wasm === "function";
  } catch {
    return false;
  }
}

export function callWasm(op: string, input: Uint8Array): Uint8Array<ArrayBuffer> {
  initNative();
  if (typeof wasm.call_wasm !== "function") {
    throw new NativeError("Loaded Wasm artifact does not export `call_wasm` (awaiting slim crates/auto-ffi build)");
  }
  try {
    const out = wasm.call_wasm(op, input);
    return new Uint8Array(out);
  } catch (err) {
    throw new NativeError(err instanceof Error ? err.message : String(err));
  }
}

/** Platform `Native` port backed by the initialized Wasm module. */
export const wasmNative: Native = {
  async call(op: string, input: Uint8Array): Promise<Uint8Array> {
    return callWasm(op, input);
  },
};

const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

/** Concatenate `u32` little-endian length-prefixed binary frames. */
export function frameParts(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 4 + part.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
}

/** Decode concatenated `u32` little-endian length-prefixed binary frames. */
export function unframeParts(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new NativeError("Truncated frame header");
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.length) throw new NativeError("Truncated frame payload");
    parts.push(bytes.subarray(offset, offset + len));
    offset += len;
  }
  return parts;
}

// Invoicing / Factur-X / PDF/A --------------------------------------------------------------------

/** Render a document (`@aphrody/auto-domain` Document JSON + optional number) to A4 PDF. */
export function renderPdf(doc: unknown, locale?: Locale): Uint8Array<ArrayBuffer> {
  return callWasm("render_pdf", json(locale ? { doc, locale } : doc));
}

/** Generate an EN 16931 Factur-X PDF/A-3b invoice with embedded `factur-x.xml`. */
export function facturx(doc: unknown, date = new Date(), locale?: Locale): Uint8Array<ArrayBuffer> {
  const timestamp = Math.floor(date.getTime() / 1000);
  return callWasm("facturx", json({ doc, timestamp, ...(locale ? { locale } : {}) }));
}

/** Generate EN 16931 CII XML (`factur-x.xml`) for an issued invoice or credit note. */
export function xmlCii(doc: unknown): string {
  return decoder.decode(callWasm("xml_cii", json(doc)));
}

/** Extract embedded Factur-X XML from a PDF, or `null` when absent. */
export function extractXml(pdf: Uint8Array): string | null {
  const xml = decoder.decode(callWasm("extract_xml", pdf));
  return xml || null;
}

/** Verify PDF/A-3b compliance errors (empty array = compliant). */
export function verifyPdfA(pdf: Uint8Array): string[] {
  return JSON.parse(decoder.decode(callWasm("verify_pdfa", pdf))) as string[];
}

/** Parse GrandTotalAmount (BT-112) in cents from a CII XML payload. */
export function parseTotalInclVatCents(xml: string): number | null {
  const match = /<ram:GrandTotalAmount>(-?\d+)\.(\d{2})<\/ram:GrandTotalAmount>/.exec(xml);
  if (!match) return null;
  const whole = Number(match[1]);
  const cents = Number(match[2]);
  const abs = Math.abs(whole) * 100 + cents;
  return match[1]!.startsWith("-") ? -abs : abs;
}

// Spreadsheets ------------------------------------------------------------------------------------

export type CellValue = string | number | boolean | null;

export interface SpreadsheetReadResult {
  format: "xlsx" | "xls" | "xlsb" | "ods" | "csv";
  sheets: { name: string; rows: CellValue[][] }[];
  warnings: string[];
}

export const readSpreadsheet = (bytes: Uint8Array): SpreadsheetReadResult =>
  JSON.parse(decoder.decode(callWasm("read_spreadsheet", bytes))) as SpreadsheetReadResult;

export type ColumnType = "text" | "number" | "euros" | "date" | "percent";

export interface Workbook {
  sheets: {
    name: string;
    columns: { title: string; type?: ColumnType; width?: number }[];
    /** Euros in integer cents, percent in basis points, dates formatted YYYY-MM-DD. */
    rows: CellValue[][];
  }[];
}

export const writeXlsx = (workbook: Workbook): Uint8Array<ArrayBuffer> => callWasm("write_xlsx", json(workbook));

export interface CellEdit {
  sheet: string;
  row: number;
  col: number;
  value?: CellValue;
  formula?: string;
}

/** 1-based cell edits; preserves formatting/other sheets and recalculates dependent formulas. */
export const modifyXlsx = (xlsx: Uint8Array, edits: CellEdit[]): Uint8Array<ArrayBuffer> =>
  callWasm("modify_xlsx", frameParts([json(edits), xlsx]));

/** Convert an Excel 1900-epoch serial date number into `YYYY-MM-DD`. */
export function excelDate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

// PDF & Word documents ----------------------------------------------------------------------------

export const mergePdfs = (pdfs: { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> =>
  callWasm("merge_pdfs", frameParts(pdfs.flatMap((p) => [encoder.encode(p.name), p.bytes])));

/** Extract 1-based pages into a new PDF in the requested order. */
export const extractPdfPages = (pdf: Uint8Array, pages: number[]): Uint8Array<ArrayBuffer> =>
  callWasm("extract_pdf_pages", frameParts([json(pages.map((p) => p - 1)), pdf]));

export const pdfPageCount = (pdf: Uint8Array): number => Number(decoder.decode(callWasm("pdf_page_count", pdf)));

export const pdfText = (pdf: Uint8Array): string[] =>
  (JSON.parse(decoder.decode(callWasm("pdf_text", pdf))) as { pages: string[] }).pages;

export interface SimpleDocx {
  title?: string;
  paragraphs: { text: string; style?: "title" | "heading1" | "heading2" | "heading3"; bold?: boolean }[];
}

export const createDocx = (doc: SimpleDocx): Uint8Array<ArrayBuffer> => callWasm("create_docx", json(doc));

export const readDocx = (docx: Uint8Array): { paragraphs: string[] } =>
  JSON.parse(decoder.decode(callWasm("read_docx", docx))) as { paragraphs: string[] };

export const docxTemplateFields = (docx: Uint8Array): string[] =>
  JSON.parse(decoder.decode(callWasm("template_fields_docx", docx))) as string[];

export const fillDocxTemplate = (docx: Uint8Array, values: Record<string, string>): Uint8Array<ArrayBuffer> =>
  callWasm("fill_template_docx", frameParts([json(values), docx]));

export const replaceDocx = (
  docx: Uint8Array,
  replacements: { find: string; replace: string }[],
): Uint8Array<ArrayBuffer> => callWasm("replace_docx", frameParts([json(replacements), docx]));

export const docxText = (docx: Uint8Array): string => decoder.decode(callWasm("docx_text", docx));

export const docxToPdf = (docx: Uint8Array): Uint8Array<ArrayBuffer> => callWasm("docx_to_pdf", docx);

// PDF redaction, signatures, presentations --------------------------------------------------------

export type RedactionPattern = "iban" | "email" | "phone" | "credit_card" | "date";

export interface RedactionOptions {
  texts?: string[];
  patterns?: RedactionPattern[];
  caseSensitive?: boolean;
  wholeWords?: boolean;
  overlayText?: string;
}

export interface RedactionReport {
  occurrences: number;
  pages: number[];
  byQuery: { query: string; occurrences: number }[];
  glyphs: number;
  images: number;
  paths: number;
  annotations: number;
  fields: number;
}

export function redactPdf(
  pdf: Uint8Array,
  opts: RedactionOptions,
): { pdf: Uint8Array<ArrayBuffer>; report: RedactionReport } {
  const [reportBytes, outPdf] = unframeParts(callWasm("redact_pdf", frameParts([json(opts), pdf])));
  if (!reportBytes || !outPdf) throw new NativeError("Invalid redact_pdf response frame");
  return {
    pdf: new Uint8Array(outPdf),
    report: JSON.parse(decoder.decode(reportBytes)) as RedactionReport,
  };
}

export interface SignatureOptions {
  password: string;
  /** PDF UTC date `D:YYYYMMDDHHmmSSZ`; defaults to now. */
  date?: string;
  reason?: string;
  location?: string;
  contact?: string;
  field?: string;
  /** Zero-based page index. */
  page?: number;
  /** Optional visible rectangle `[x0, y0, x1, y1]` in points (origin bottom-left). */
  rect?: [number, number, number, number];
  certify?: 1 | 2 | 3;
}

export const pdfDate = (d = new Date()): string => `D:${d.toISOString().replace(/\D/g, "").slice(0, 14)}Z`;

export const signPdf = (pdf: Uint8Array, pkcs12: Uint8Array, opts: SignatureOptions): Uint8Array<ArrayBuffer> =>
  callWasm("sign_pdf", frameParts([json({ ...opts, date: opts.date ?? pdfDate() }), pkcs12, pdf]));

export interface VerifiedSignature {
  field: string;
  signed: boolean;
  status: "valid" | "unknown" | "invalid" | "unsigned";
  signer: string | null;
  date: string | null;
  reason: string | null;
  location: string | null;
  format: string | null;
  algorithm: string | null;
  certification: number | null;
  timestamped: boolean;
  modifications: "none" | "allowed" | "forbidden";
  changes: string[];
  fingerprint: string | null;
  details: string[];
}

export const verifyPdfSignatures = (pdf: Uint8Array, trustedCertsPem = ""): VerifiedSignature[] =>
  JSON.parse(
    decoder.decode(callWasm("verify_signatures", frameParts([encoder.encode(trustedCertsPem), pdf]))),
  ) as VerifiedSignature[];

export interface NewPresentation {
  title?: string;
  subtitle?: string;
  slides: { title?: string; bullets?: (string | { text: string; level?: number })[]; notes?: string }[];
}

export const createPptx = (presentation: NewPresentation): Uint8Array<ArrayBuffer> =>
  callWasm("create_pptx", json(presentation));

export const pptxText = (pptx: Uint8Array): string[] =>
  (JSON.parse(decoder.decode(callWasm("pptx_text", pptx))) as { slides: string[] }).slides;

export const pptxToPdf = (pptx: Uint8Array): Uint8Array<ArrayBuffer> => callWasm("pptx_to_pdf", pptx);

// Knowledge base chunking & vector search ---------------------------------------------------------

export interface TextChunk {
  index: number;
  text: string;
  heading: string | null;
  startLine: number;
  endLine: number;
}

export const chunkText = (source: string, text: string, chunkSize?: number): TextChunk[] =>
  JSON.parse(decoder.decode(callWasm("chunk_text", json({ source, text, chunkSize })))) as TextChunk[];

const float32Bytes = (v: Float32Array | number[]) => {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

export const nearestVectors = (
  query: Float32Array | number[],
  matrix: Float32Array,
  dimension: number,
  k: number,
  diversity?: number,
): { index: number; score: number }[] =>
  JSON.parse(
    decoder.decode(
      callWasm(
        "nearest_vectors",
        frameParts([json({ dimension, k, diversity }), float32Bytes(query), float32Bytes(matrix)]),
      ),
    ),
  ) as { index: number; score: number }[];

// Modern Rust Better Auth (`auto-auth` via Wasm/FFI) --------------------------------------------

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
};

const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const authHashPassword = (
  password: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  mode: "argon2id" | "scrypt" = "argon2id",
): string =>
  (
    JSON.parse(decoder.decode(callWasm("auth_hash_password", json({ password, saltB64: toBase64(salt), mode })))) as {
      hash: string;
    }
  ).hash;

export const authVerifyPassword = (password: string, hash: string): boolean =>
  (JSON.parse(decoder.decode(callWasm("auth_verify_password", json({ password, hash })))) as { valid: boolean }).valid;

export interface RustJwtClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  activeOrganizationId?: string;
  role?: string;
  email?: string;
}

export const authSignJwt = (input: {
  masterSecret: string;
  keyLabel?: string;
  claims: RustJwtClaims;
}): { token: string; kid: string } =>
  JSON.parse(decoder.decode(callWasm("auth_sign_jwt", json(input)))) as { token: string; kid: string };

export const authVerifyJwt = (input: {
  masterSecret: string;
  keyLabel?: string;
  token: string;
  expectedIssuer?: string;
  expectedAudience?: string;
  nowUnixSecs?: number;
}): RustJwtClaims =>
  JSON.parse(
    decoder.decode(
      callWasm("auth_verify_jwt", json({ ...input, nowUnixSecs: input.nowUnixSecs ?? Math.floor(Date.now() / 1000) })),
    ),
  ) as RustJwtClaims;

export const authJwks = (input: { masterSecret: string; keyLabel?: string }): { keys: Record<string, string>[] } =>
  JSON.parse(decoder.decode(callWasm("auth_jwks", json(input)))) as { keys: Record<string, string>[] };

export const authSealSecret = (
  masterSecret: string,
  purpose: string,
  plaintext: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12)),
): string =>
  (
    JSON.parse(
      decoder.decode(
        callWasm(
          "auth_seal_secret",
          json({ masterSecret, purpose, plaintextB64: toBase64(plaintext), nonceB64: toBase64(nonce) }),
        ),
      ),
    ) as { token: string }
  ).token;

export const authOpenSecret = (masterSecret: string, purpose: string, token: string): Uint8Array<ArrayBuffer> =>
  fromBase64(
    (
      JSON.parse(decoder.decode(callWasm("auth_open_secret", json({ masterSecret, purpose, token })))) as {
        plaintextB64: string;
      }
    ).plaintextB64,
  );

export const authTotpCode = (
  secretB32: string,
  unixSecs = Math.floor(Date.now() / 1000),
  issuer = "Auto",
  account = "user",
): { code: string; uri: string } =>
  JSON.parse(decoder.decode(callWasm("auth_totp_code", json({ secretB32, unixSecs, issuer, account })))) as {
    code: string;
    uri: string;
  };

export const authTotpVerify = (secretB32: string, code: string, unixSecs = Math.floor(Date.now() / 1000)): boolean =>
  (JSON.parse(decoder.decode(callWasm("auth_totp_verify", json({ secretB32, code, unixSecs })))) as { valid: boolean })
    .valid;

export const authSignToken = (masterSecret: string, purpose: string, payload: unknown): string =>
  (
    JSON.parse(decoder.decode(callWasm("auth_sign_token", json({ masterSecret, purpose, payload })))) as {
      token: string;
    }
  ).token;

export const authVerifyToken = <T = unknown>(masterSecret: string, purpose: string, token: string): T =>
  JSON.parse(decoder.decode(callWasm("auth_verify_token", json({ masterSecret, purpose, token })))) as T;

export const authGenerateApiKey = (
  prefix = "auto_",
  entropy: Uint8Array = crypto.getRandomValues(new Uint8Array(24)),
): { rawKey: string; start: string; prefix: string; sha256B64u: string } =>
  JSON.parse(decoder.decode(callWasm("auth_generate_api_key", json({ prefix, entropyB64: toBase64(entropy) })))) as {
    rawKey: string;
    start: string;
    prefix: string;
    sha256B64u: string;
  };

export const authCanPerform = (role: string, action: string): boolean =>
  (JSON.parse(decoder.decode(callWasm("auth_can_perform", json({ role, action })))) as { allowed: boolean }).allowed;

// Supplier invoice and document ingestion: SHA-256 deduplication, Factur-X CII XML / PDF text
// extraction via @aphrody/auto-native, optional OpenAI/Workers-AI enrichment, and store persistence.
import { extractXml, parseTotalInclVatCents, pdfText } from "@aphrody/auto-native";
import type { Tx } from "@aphrody/auto-platform";
import type { LlmClient } from "@aphrody/auto-platform/llm";
import { reqCompany, saveReceivedInvoice, sha256Hex, storeBlobFile, StoreError } from "@aphrody/auto-store";
import { outbox } from "./events";

export const MAX_INGEST_BYTES = 20 * 1024 * 1024;
export const INGEST_STATUSES = ["review", "validated", "rejected"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export interface IncomingFile {
  bytes: Uint8Array;
  filename?: string;
  mimeType: string;
  channel?: "api" | "mail" | "einvoicing";
  projectId?: string | null;
}

export interface ExtractedInvoiceData {
  number?: string;
  supplierName?: string;
  date?: string;
  totalExclVatCents?: number;
  totalVatCents?: number;
  totalInclVatCents?: number;
  currency?: string;
  sourceKind: "facturx_xml" | "pdf_text" | "raw";
  anomalies: string[];
  rawText?: string;
  xml?: string;
}

function matchTag(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<(?:[\\w-]+:)?${localName}(?:\\s[^>]*)?>([^<]+)<\\/(?:[\\w-]+:)?${localName}>`, "i");
  return re.exec(xml)?.[1]?.trim();
}

function parseCentsFromAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

function parseIsoDateFromCii(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
}

export async function extractInvoiceMetadata(
  bytes: Uint8Array,
  mimeType: string,
  opts: { llm?: LlmClient | null; signal?: AbortSignal } = {},
): Promise<ExtractedInvoiceData> {
  const anomalies: string[] = [];
  let xml: string | null = null;
  const headText = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (mimeType.includes("xml") || headText.startsWith("<?xml") || /^<([\w-]+:)?CrossIndustryInvoice/i.test(headText)) {
    xml = new TextDecoder().decode(bytes);
  } else if (mimeType === "application/pdf" || headText.startsWith("%PDF-")) {
    try {
      xml = extractXml(bytes);
    } catch {
      xml = null;
    }
  }

  if (xml) {
    const number = matchTag(xml, "ID");
    const issueRaw = matchTag(xml, "DateTimeString");
    const supplierBlock =
      /<(?:[\w-]+:)?SellerTradeParty\b[\s\S]*?<\/(?:[\w-]+:)?SellerTradeParty>/i.exec(xml)?.[0] ?? xml;
    const supplierName = matchTag(supplierBlock, "Name");
    const totalExclVatCents = parseCentsFromAmount(matchTag(xml, "TaxBasisTotalAmount"));
    const totalVatCents = parseCentsFromAmount(matchTag(xml, "TaxTotalAmount"));
    let totalInclVatCents: number | undefined;
    try {
      totalInclVatCents = parseTotalInclVatCents(xml) ?? parseCentsFromAmount(matchTag(xml, "GrandTotalAmount"));
    } catch {
      totalInclVatCents = parseCentsFromAmount(matchTag(xml, "GrandTotalAmount"));
    }
    const currency = matchTag(xml, "InvoiceCurrencyCode") ?? "EUR";
    if (!number) anomalies.push("Missing invoice number in XML");
    if (!supplierName) anomalies.push("Missing seller name in XML");
    if (totalInclVatCents === undefined) anomalies.push("Missing gross total in XML");
    return {
      number,
      supplierName,
      date: parseIsoDateFromCii(issueRaw),
      totalExclVatCents,
      totalVatCents,
      totalInclVatCents,
      currency,
      sourceKind: "facturx_xml",
      anomalies,
      xml,
    };
  }

  let text = "";
  if (mimeType === "application/pdf" || headText.startsWith("%PDF-")) {
    try {
      text = pdfText(bytes).join("\n");
    } catch {
      anomalies.push("Unable to extract embedded text from PDF");
    }
  }

  if (text && opts.llm) {
    try {
      const reply = await opts.llm.complete({
        signal: opts.signal,
        messages: [
          {
            role: "system",
            content:
              "Extract supplier invoice fields as strict JSON matching the schema. Amounts must be integer cents.",
          },
          { role: "user", content: text.slice(0, 8000) },
        ],
        schema: {
          name: "invoice_extract",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              number: { type: "string" },
              supplierName: { type: "string" },
              date: { type: "string" },
              totalExclVatCents: { type: "integer" },
              totalVatCents: { type: "integer" },
              totalInclVatCents: { type: "integer" },
              currency: { type: "string" },
            },
            required: ["number", "supplierName", "date", "totalInclVatCents"],
          },
        },
      });
      if (reply.content) {
        const parsed = JSON.parse(reply.content) as Partial<ExtractedInvoiceData>;
        return {
          number: parsed.number,
          supplierName: parsed.supplierName,
          date: parsed.date,
          totalExclVatCents: parsed.totalExclVatCents,
          totalVatCents: parsed.totalVatCents,
          totalInclVatCents: parsed.totalInclVatCents,
          currency: parsed.currency ?? "EUR",
          sourceKind: "pdf_text",
          anomalies,
          rawText: text.slice(0, 4000),
        };
      }
    } catch {
      anomalies.push("LLM extraction fallback failed");
    }
  }

  if (!text) anomalies.push("No structured invoice XML or extractable PDF text found");
  return {
    currency: "EUR",
    sourceKind: text ? "pdf_text" : "raw",
    anomalies,
    rawText: text.slice(0, 4000) || undefined,
  };
}

export async function ingestDocument(
  tx: Tx,
  actor: string | null,
  file: IncomingFile,
  opts: { llm?: LlmClient | null; signal?: AbortSignal } = {},
): Promise<{ id: string; duplicate: boolean; extracted: ExtractedInvoiceData; blobKey: string }> {
  if (!file.bytes.byteLength) throw new StoreError("Empty file", [], 400);
  if (file.bytes.byteLength > MAX_INGEST_BYTES) throw new StoreError("File exceeds 20 MiB limit", [], 413);
  const companyId = reqCompany(tx);
  const digest = await sha256Hex(file.bytes);
  const [existing] = await tx<{ id: string; blob_key: string | null; data_json: string }[]>`
    SELECT id, blob_key, data_json FROM received_invoice WHERE company_id = ${companyId} AND sha256 = ${digest} AND _deleted = 0`;
  if (existing) {
    return {
      id: existing.id,
      duplicate: true,
      extracted: JSON.parse(existing.data_json) as ExtractedInvoiceData,
      blobKey: existing.blob_key ?? "",
    };
  }

  const stored = await storeBlobFile(tx, file.filename ?? `invoice-${digest.slice(0, 8)}`, file.mimeType, file.bytes);
  const extracted = await extractInvoiceMetadata(file.bytes, file.mimeType, opts);
  const id = await saveReceivedInvoice(tx, actor, {
    number: extracted.number ?? "",
    supplierName: extracted.supplierName ?? "",
    date: extracted.date ?? new Date().toISOString().slice(0, 10),
    status: extracted.anomalies.length === 0 && extracted.totalInclVatCents !== undefined ? "review" : "review",
    totalExclVatCents: extracted.totalExclVatCents ?? 0,
    totalVatCents: extracted.totalVatCents ?? 0,
    totalInclVatCents: extracted.totalInclVatCents ?? 0,
    currency: extracted.currency ?? "EUR",
    data: extracted,
    projectId: file.projectId ?? null,
    blobKey: stored.blobKey,
    sha256: digest,
  });
  await outbox(tx, "einvoice.received", {
    receivedInvoiceId: id,
    channel: file.channel ?? "api",
    supplierName: extracted.supplierName ?? "",
    totalInclVatCents: extracted.totalInclVatCents ?? 0,
  });
  return { id, duplicate: false, extracted, blobKey: stored.blobKey };
}

export async function parseIngestRequest(req: Request): Promise<Omit<IncomingFile, "channel">> {
  const ctype = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ctype === "multipart/form-data") {
    const form = await req.formData();
    const entry = form.get("file") ?? form.get("fichier");
    if (!(entry instanceof Blob)) throw new StoreError("Missing multipart 'file' field", [], 400);
    return {
      bytes: new Uint8Array(await entry.arrayBuffer()),
      filename: entry instanceof File ? entry.name : undefined,
      mimeType: entry.type || "application/pdf",
    };
  }
  if (!["application/pdf", "application/xml", "text/xml", "application/octet-stream"].includes(ctype)) {
    throw new StoreError("Unsupported Content-Type; expected PDF, XML, or multipart/form-data", [], 415);
  }
  const url = new URL(req.url);
  const filename = url.searchParams.get("filename") ?? url.searchParams.get("nom") ?? undefined;
  return { bytes: new Uint8Array(await req.arrayBuffer()), filename, mimeType: ctype };
}

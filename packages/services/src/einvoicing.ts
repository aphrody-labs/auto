// E-invoicing Partner Platform (PA / PDP / PPF) connector, Factur-X submission, lifecycle status sync,
// signed incoming webhook verification, SIREN directory lookup, and B2C/international e-reporting.
import { validSiren, type Document, type DocumentStatus } from "@aphrody/auto-domain";
import { facturx, verifyPdfA, xmlCii } from "@aphrody/auto-native";
import type { Tx } from "@aphrody/auto-platform";
import { reqCompany, saveEInvoiceSubmission, StoreError, uid } from "@aphrody/auto-store";
import { outbox, verifyWebhookSignature } from "./events";

export type EInvoiceProvider = "mock" | "b2brouter";
export type EInvoiceLifecycle = "submitted" | "deposited" | "rejected" | "refused" | "paid";

export const PA_TO_DOCUMENT_STATUS: Partial<Record<EInvoiceLifecycle, DocumentStatus>> = {
  deposited: "submitted",
  rejected: "rejected",
  refused: "declined",
  paid: "paid",
};

export interface PaConfig {
  provider: EInvoiceProvider;
  accountId: string;
  apiKey: string;
  webhookSecret: string;
  baseUrl?: string;
}

export interface DirectoryEntry {
  siren: string;
  provider: EInvoiceProvider;
  registered: boolean;
  routingId?: string;
}

export async function lookupDirectory(
  siren: string,
  provider: EInvoiceProvider = "mock",
  fetcher: typeof fetch = fetch,
  opts: { baseUrl?: string; apiKey?: string } = {},
): Promise<DirectoryEntry | null> {
  const clean = siren.replace(/\s/g, "");
  if (!validSiren(clean)) throw new StoreError("Invalid 9-digit SIREN", [], 400);
  if (provider === "mock") {
    if (clean === "732829320" || clean.startsWith("9")) {
      return { siren: clean, provider, registered: true, routingId: `ppf:${clean}` };
    }
    return null;
  }
  const base = opts.baseUrl ?? "https://api-staging.b2brouter.net";
  const res = await fetcher(`${base.replace(/\/+$/, "")}/directory/${encodeURIComponent(clean)}`, {
    headers: opts.apiKey ? { "x-b2brouter-api-key": opts.apiKey } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new StoreError(`Directory lookup failed (HTTP ${res.status})`, [], 502);
  const body = (await res.json()) as { routing_id?: string };
  return { siren: clean, provider, registered: true, routingId: body.routing_id };
}

export async function submitEInvoice(
  tx: Tx,
  input: { documentId: string; doc: Document; pdfBytes: Uint8Array; config: PaConfig; fetcher?: typeof fetch },
): Promise<{ submissionId: string; externalId: string; status: EInvoiceLifecycle; warnings: string[] }> {
  const fxPdf = facturx(input.doc, new Date(), input.doc.locale ?? "en");
  const warnings = verifyPdfA(fxPdf);
  const cii = xmlCii(input.doc);
  let externalId = `pa_${uid().slice(0, 12)}`;
  let status: EInvoiceLifecycle = "submitted";

  if (input.config.provider === "b2brouter") {
    const base = input.config.baseUrl ?? "https://api-staging.b2brouter.net";
    const res = await (input.fetcher ?? fetch)(
      `${base.replace(/\/+$/, "")}/projects/${input.config.accountId}/invoices`,
      {
        method: "POST",
        headers: {
          "content-type": "application/xml",
          "x-b2brouter-api-key": input.config.apiKey,
        },
        body: cii,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new StoreError(`PA submission failed (HTTP ${res.status})`, [], 502);
    const data = (await res.json()) as { id?: string | number };
    if (data.id !== undefined) externalId = String(data.id);
    status = "deposited";
  }

  const submissionId = await saveEInvoiceSubmission(tx, {
    documentId: input.documentId,
    provider: input.config.provider,
    externalId,
    status,
    raw: { warnings, bytes: fxPdf.byteLength },
  });
  await outbox(tx, "einvoice.status", { documentId: input.documentId, submissionId, externalId, status });
  return { submissionId, externalId, status, warnings };
}

export async function verifyPaWebhook(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ event: string; externalId: string; status: EInvoiceLifecycle }> {
  const valid = await verifyWebhookSignature(secret, rawBody, signatureHeader);
  if (!valid) throw new StoreError("Invalid PA webhook signature", [], 401);
  return JSON.parse(rawBody) as { event: string; externalId: string; status: EInvoiceLifecycle };
}

export async function submitEReporting(
  tx: Tx,
  input: {
    period: string;
    kind: "b2c" | "international";
    lines: { date: string; vatRate: number; exclVatCents: number; vatCents: number }[];
  },
): Promise<{ id: string; period: string; kind: string; totalExclVatCents: number; totalVatCents: number }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new StoreError("Period must be formatted as YYYY-MM", [], 400);
  }
  const companyId = reqCompany(tx);
  const totalExclVatCents = input.lines.reduce((s, l) => s + l.exclVatCents, 0);
  const totalVatCents = input.lines.reduce((s, l) => s + l.vatCents, 0);
  const id = await saveEInvoiceSubmission(tx, {
    documentId: `ereporting:${companyId}:${input.period}:${input.kind}`,
    provider: "ereporting",
    externalId: `${input.kind}_${input.period}`,
    status: "submitted",
    raw: input,
  });
  return { id, period: input.period, kind: input.kind, totalExclVatCents, totalVatCents };
}

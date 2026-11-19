// Pure Chrome-free extension logic shared by service worker, popup, and unit tests.
export const DEFAULT_INSTANCE = "https://auto.aphrody.com";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface ExtensionSettings {
  instance: string;
  token: string;
}

export function normalizeInstance(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Invalid instance URL (expected https://auto.aphrody.com)");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error("Instance must use HTTPS (HTTP allowed for localhost only)");
  }
  return u.origin;
}

export const hostPattern = (origin: string): string => `${new URL(origin).origin}/*`;

export const isValidApiToken = (token: string): boolean => /^auto_[A-Za-z0-9_-]{20,}$/.test(token.trim());

export type SupportedMime = "application/pdf" | "application/xml";

export function detectFileMime(bytes: Uint8Array): SupportedMime | null {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 512))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (head.startsWith("%PDF-")) return "application/pdf";
  if (head.startsWith("<?xml") || /^<([\w-]+:)?CrossIndustryInvoice\b/.test(head)) return "application/xml";
  return null;
}

export function sanitizeFilename(url: string, contentDisposition: string | null, mime: SupportedMime): string {
  const ext = mime === "application/pdf" ? ".pdf" : ".xml";
  const cd = contentDisposition ?? "";
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  const simple = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name = "";
  try {
    name = star ? decodeURIComponent(star[1]!.trim()) : simple ? simple[1]!.trim() : "";
  } catch {
    name = "";
  }
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
    } catch {
      name = "";
    }
  }
  name =
    [...name]
      .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? "_" : c))
      .join("")
      .slice(0, 120) || "invoice";
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

export const ingestUrl = (instance: string, filename: string): string =>
  `${instance}/v1/ingest?filename=${encodeURIComponent(filename)}`;

export interface IngestResponse {
  id: string;
  duplicate?: boolean;
  extracted?: { supplierName?: string; number?: string; totalInclVatCents?: number; anomalies?: string[] };
}

export function formatIngestNotification(res: IngestResponse, filename: string): { title: string; message: string } {
  if (res.duplicate) return { title: "Already uploaded", message: `${filename} was already sent to Auto.` };
  const ext = res.extracted ?? {};
  const who = ext.supplierName ? ` from ${ext.supplierName}` : "";
  const num = ext.number ? ` ${ext.number}` : "";
  const amt =
    ext.totalInclVatCents !== undefined
      ? `, ${(ext.totalInclVatCents / 100).toLocaleString("en-IE", { style: "currency", currency: "EUR" })}`
      : "";
  const anomalies = ext.anomalies?.length ?? 0;
  return anomalies > 0
    ? { title: "Invoice needs review", message: `Invoice${num}${who}${amt} uploaded (${anomalies} check(s)).` }
    : { title: "Invoice recorded", message: `Invoice${num}${who}${amt} uploaded.` };
}

export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

export function formatApiError(status: number, body: unknown): string {
  if (status === 401) return "API token rejected";
  const b = body as { error?: string; details?: string[] } | null;
  if (b?.error) return b.details?.length ? `${b.error} (${b.details.join(", ")})` : b.error;
  return `HTTP ${status}`;
}

// Core business domain model aligned 1:1 with Rust `auto-model` (`#11`) and legal invoicing rules.
import { t, type Locale } from "@aphrody/auto-platform/i18n";

export const VALID_VAT_RATES = [0, 21, 55, 100, 200] as const;
/** VAT rate in tenths of a percent: 0, 2.1, 5.5, 10, 20 %. */
export type VatRate = (typeof VALID_VAT_RATES)[number];

export function validVatRate(value: unknown): value is VatRate {
  return typeof value === "number" && VALID_VAT_RATES.includes(value as VatRate);
}

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceExclVatCents: number;
  vat: VatRate;
  unit?: string;
  /** Line discount in basis points: 1000 = 10 %. */
  discountBp?: number;
}

export interface Party {
  name: string;
  /** SIRET (14 digits) or national registration identifier. */
  taxId?: string;
  address: string;
  deliveryAddress?: string;
  vatNumber?: string;
  email?: string;
}

/** quote; invoice (380); deposit (386); credit_note (381). */
export const DOCUMENT_TYPES = ["quote", "invoice", "deposit", "credit_note"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = [
  "draft",
  "issued",
  "sent",
  "accepted",
  "declined",
  "submitted",
  "rejected",
  "paid",
  "cancelled",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface Logo {
  mime: string;
  dataBase64: string;
}

/** Tenant visual styling applied at render time (never stored inside immutable document JSON). */
export interface Template {
  color?: string;
  logo?: Logo;
  width?: number;
  height?: number;
  footer?: string;
}

export interface Document {
  number?: string;
  type: DocumentType;
  /** ISO date YYYY-MM-DD (issue date). */
  date: string;
  issuer: Party;
  customer: Party;
  lines: LineItem[];
  serviceDate?: string;
  dueDate?: string;
  paymentTerms?: string;
  latePenalties?: string;
  earlyDiscount?: string;
  /** VAT exemption scheme (France CGI art. 293 B). */
  vatExempt?: boolean;
  /** Credit note: credited invoice number. Invoice: source quote number. */
  origin?: string;
  validityDays?: number;
  notes?: string;
  template?: Template;
  locale?: Locale;
}

export interface RateTotals {
  rate: number;
  baseExclVatCents: number;
  vatCents: number;
}

export interface Totals {
  totalExclVatCents: number;
  totalVatCents: number;
  totalInclVatCents: number;
  byRate: RateTotals[];
  vatByRate: Record<number, number>;
}

export const VAT_EXEMPT_NOTICE = "TVA non applicable, art. 293 B du CGI";
export const RECOVERY_FEE_CENTS = 4000;
export const DEFAULT_LATE_PENALTIES = "3 times the statutory interest rate";
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export const ISSUED_TRANSITIONS: Record<DocumentType, Partial<Record<DocumentStatus, readonly DocumentStatus[]>>> = {
  quote: {
    issued: ["sent", "accepted", "declined", "cancelled"],
    sent: ["accepted", "declined", "cancelled"],
    accepted: [],
    declined: [],
    cancelled: [],
  },
  invoice: {
    issued: ["sent", "submitted", "paid", "cancelled"],
    sent: ["submitted", "paid", "cancelled"],
    submitted: ["rejected", "paid"],
    rejected: ["submitted", "cancelled"],
    paid: [],
    cancelled: [],
  },
  deposit: {
    issued: ["sent", "submitted", "paid", "cancelled"],
    sent: ["submitted", "paid", "cancelled"],
    submitted: ["rejected", "paid"],
    rejected: ["submitted", "cancelled"],
    paid: [],
    cancelled: [],
  },
  credit_note: {
    issued: ["sent", "submitted", "paid"],
    sent: ["submitted", "paid"],
    submitted: ["rejected", "paid"],
    rejected: ["submitted"],
    paid: [],
  },
};

/** Gross line amount excl. VAT before discount. */
export const lineGrossExclVat = (line: LineItem): number => Math.round(line.quantity * line.unitPriceExclVatCents);

/** Net line amount excl. VAT using the exact rounding order of `auto-model` (Rust). */
export const lineNetExclVat = (line: LineItem): number =>
  Math.round((line.quantity * line.unitPriceExclVatCents * (10000 - (line.discountBp ?? 0))) / 10000);

export function computeTotals(lines: LineItem[]): Totals {
  const baseByRate = new Map<number, number>();
  for (const line of lines) {
    const net = lineNetExclVat(line);
    baseByRate.set(line.vat, (baseByRate.get(line.vat) ?? 0) + net);
  }
  let totalExclVatCents = 0;
  let totalVatCents = 0;
  const vatByRate: Record<number, number> = {};
  const byRate: RateTotals[] = [];
  for (const [rate, baseExclVatCents] of [...baseByRate.entries()].sort((a, b) => a[0] - b[0])) {
    const vatCents = Math.round((baseExclVatCents * rate) / 1000);
    vatByRate[rate] = vatCents;
    byRate.push({ rate, baseExclVatCents, vatCents });
    totalExclVatCents += baseExclVatCents;
    totalVatCents += vatCents;
  }
  return {
    totalExclVatCents,
    totalVatCents,
    totalInclVatCents: totalExclVatCents + totalVatCents,
    byRate,
    vatByRate,
  };
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Valid French SIRET (14 digits, Luhn check). */
export function validSiret(siret: string): boolean {
  const s = siret.replace(/\s/g, "");
  return /^\d{14}$/.test(s) && luhn(s);
}

/** Valid French SIREN (9 digits, Luhn check). */
export function validSiren(siren: string): boolean {
  const s = siren.replace(/\s/g, "");
  return /^\d{9}$/.test(s) && luhn(s);
}

/** Valid EU intra-community VAT number (2-letter country prefix + 2..12 alphanumeric chars). */
export function validVatNumber(vat: string): boolean {
  const cleaned = vat.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(cleaned)) return false;
  if (cleaned.startsWith("FR")) {
    const rest = cleaned.slice(2);
    if (!/^[0-9A-HJ-NP-Z]{2}\d{9}$/.test(rest)) return false;
    const siren = rest.slice(2);
    if (!validSiren(siren)) return false;
    if (/^\d{2}$/.test(rest.slice(0, 2))) return cleaned === frVatNumber(siren);
  }
  return true;
}

/** Compute French intra-community VAT number: FR + 2-digit key + SIREN. */
export function frVatNumber(siren: string): string {
  const clean = siren.replace(/\s/g, "");
  const n = BigInt(clean);
  const key = (12n + 3n * (n % 97n)) % 97n;
  return `FR${String(key).padStart(2, "0")}${clean}`;
}

export type DocumentSeries = "QUO" | "INV" | "CN";

/** Gapless numbering series: invoices and deposits share the `INV` series. */
export function seriesForType(type: DocumentType): DocumentSeries {
  if (type === "quote") return "QUO";
  if (type === "credit_note") return "CN";
  return "INV";
}

/** Site-scoped gapless numbering: `INV-2026-0001` on cloud, or `INV-<site>-2026-0001` on edge sites. */
export function formatDocumentNumber(type: DocumentType, year: number, seq: number, site = "cloud"): string {
  const series = seriesForType(type);
  const n = String(seq).padStart(4, "0");
  if (!site || site === "cloud") return `${series}-${year}-${n}`;
  if (!SITE_ID_PATTERN.test(site)) throw new Error(`Invalid site identifier: ${site}`);
  return `${series}-${site}-${year}-${n}`;
}

const isInvoiceFamily = (type: DocumentType) => type !== "quote";

/** Verify mandatory fields and invariants on a document (empty array = valid). */
export function verifyDocument(doc: Document, locale: Locale = "en"): string[] {
  const errors: string[] = [];
  if (!doc.issuer?.taxId || !validSiret(doc.issuer.taxId)) {
    errors.push(t(locale, "Invalid issuer tax ID (SIRET)"));
  }
  if (!doc.issuer?.address?.trim()) {
    errors.push(t(locale, "Missing issuer address"));
  }
  if (!doc.customer?.name?.trim() || !doc.customer?.address?.trim()) {
    errors.push(t(locale, "Missing customer name or address"));
  }
  if (!doc.lines || doc.lines.length === 0) {
    errors.push(t(locale, "At least one line item is required"));
  } else {
    for (const [i, line] of doc.lines.entries()) {
      const idx = i + 1;
      if (!line.description?.trim()) errors.push(t(locale, "Line {n}: missing description", { n: idx }));
      if (!(line.quantity > 0)) errors.push(t(locale, "Line {n}: invalid quantity", { n: idx }));
      if (
        line.discountBp !== undefined &&
        !(Number.isInteger(line.discountBp) && line.discountBp >= 0 && line.discountBp <= 10000)
      ) {
        errors.push(t(locale, "Line {n}: invalid discount", { n: idx }));
      }
      if (!validVatRate(line.vat)) errors.push(t(locale, "Line {n}: invalid VAT rate", { n: idx }));
    }
  }
  if (doc.vatExempt) {
    if (doc.lines.some((l) => l.vat !== 0)) {
      errors.push(t(locale, "VAT exemption requires 0% VAT on all lines"));
    }
  } else if (!doc.issuer?.vatNumber?.trim()) {
    errors.push(t(locale, "Missing issuer VAT number"));
  }
  if (isInvoiceFamily(doc.type)) {
    if (doc.customer?.taxId && !validSiret(doc.customer.taxId)) {
      errors.push(t(locale, "Invalid customer tax ID (SIRET)"));
    }
    if (!doc.dueDate) errors.push(t(locale, "Missing due date"));
    if (!doc.serviceDate) errors.push(t(locale, "Missing supply or service date"));
    if (!doc.latePenalties) errors.push(t(locale, "Missing late payment penalty terms"));
    if (!doc.earlyDiscount) errors.push(t(locale, "Missing early payment discount terms"));
  }
  if (doc.type === "credit_note" && !doc.origin) {
    errors.push(t(locale, "Credit note requires an origin invoice number"));
  }
  return errors;
}

export function verifyCustomer(c: Partial<Party>, locale: Locale = "en"): string[] {
  const errors: string[] = [];
  if (!c.name?.trim()) errors.push(t(locale, "Customer name is required"));
  if (!c.address?.trim()) errors.push(t(locale, "Customer address is required"));
  if (c.taxId?.trim() && !validSiret(c.taxId) && !validSiren(c.taxId)) {
    errors.push(t(locale, "Invalid tax ID (9-digit SIREN or 14-digit SIRET expected)"));
  }
  if (c.email?.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email.trim())) {
    errors.push(t(locale, "Invalid customer email"));
  }
  return errors;
}

export function verifyProduct(
  p: { description?: string; unitPriceExclVatCents?: number; vat?: unknown },
  locale: Locale = "en",
): string[] {
  const errors: string[] = [];
  if (!p.description?.trim()) errors.push(t(locale, "Product description is required"));
  if (!Number.isSafeInteger(p.unitPriceExclVatCents) || (p.unitPriceExclVatCents ?? -1) < 0) {
    errors.push(t(locale, "Unit price excl. VAT must be a non-negative integer in cents"));
  }
  if (!validVatRate(p.vat)) {
    errors.push(t(locale, "Invalid VAT rate"));
  }
  return errors;
}

/** Apply statutory default payment/penalty terms on invoices, deposits, and credit notes. */
export function withDefaultLegalTerms(doc: Document, locale: Locale = "en"): Document {
  if (!isInvoiceFamily(doc.type)) return doc;
  const effLocale = doc.locale ?? locale;
  return {
    ...doc,
    latePenalties:
      doc.latePenalties ?? (effLocale === "fr" ? "3 fois le taux d'intérêt légal" : DEFAULT_LATE_PENALTIES),
    earlyDiscount:
      doc.earlyDiscount ??
      (effLocale === "fr" ? "Pas d'escompte pour paiement anticipé" : "No discount for early payment"),
    paymentTerms: doc.paymentTerms ?? (effLocale === "fr" ? "Paiement à 30 jours" : "Payment due within 30 days"),
  };
}

/** Convert an accepted quote into a draft invoice. */
export function quoteToInvoice(quote: Document, quoteNumber: string, date: string, dueDate: string): Document {
  if (quote.type !== "quote") throw new Error("Source document is not a quote");
  const { validityDays: _, number: __, ...rest } = quote;
  return withDefaultLegalTerms({ ...rest, type: "invoice", date, dueDate, origin: quoteNumber });
}

/** Create a full credit note cancelling an issued invoice or deposit. */
export function fullCreditNote(invoice: Document, invoiceNumber: string, date: string): Document {
  if (invoice.type === "quote" || invoice.type === "credit_note") {
    throw new Error("Only an invoice or deposit can be cancelled by a credit note");
  }
  const { number: _, ...rest } = invoice;
  return { ...rest, type: "credit_note", date, origin: invoiceNumber };
}

/** Create a partial credit note correcting specific line items of an issued invoice. */
export function partialCreditNote(invoice: Document, invoiceNumber: string, date: string, lines: LineItem[]): Document {
  if (invoice.type === "quote" || invoice.type === "credit_note") {
    throw new Error("Only an invoice or deposit can be credited");
  }
  if (lines.length === 0) throw new Error("Partial credit note requires at least one line item");
  const { number: _, ...rest } = invoice;
  return { ...rest, type: "credit_note", date, origin: invoiceNumber, lines };
}

export const formatEur = (cents: number, locale: Locale = "en"): string =>
  new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-IE", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );

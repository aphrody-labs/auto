// Sales/payment ledger entries and French FEC export (LPF art. A47 A-1: 18 columns, YYYYMMDD, comma decimals).
import type { DocumentType, Totals } from "./index";

export interface JournalEntryLine {
  journalCode: string;
  journalLib: string;
  ecritureNum: string;
  /** YYYY-MM-DD */
  ecritureDate: string;
  compteNum: string;
  compteLib: string;
  compAuxNum?: string;
  compAuxLib?: string;
  pieceRef: string;
  pieceDate: string;
  ecritureLib: string;
  debitCents: number;
  creditCents: number;
  validDate: string;
}

/** Standard French PCG accounts used by Auto. */
export const ACCOUNTS = {
  customers: { num: "411000", lib: "Clients" },
  sales: { num: "706000", lib: "Prestations de services" },
  vat: { num: "445710", lib: "TVA collectee" },
  bank: { num: "512000", lib: "Banque" },
} as const;

const JOURNALS = { VE: "Ventes", BQ: "Banque" } as const;

/** Stable auxiliary customer account code: `C` + SIREN (first 9 digits) or normalized name. */
export function customerSubAccount(name: string, taxId?: string): string {
  const base = (taxId?.replace(/\D/g, "").slice(0, 9) || name.normalize("NFD").replace(/[^A-Za-z0-9]/g, ""))
    .toUpperCase()
    .slice(0, 9);
  return `C${base || "MISC"}`;
}

export interface SalesPiece {
  type: DocumentType;
  number: string;
  date: string;
  customer: { name: string; taxId?: string };
  totals: Totals;
}

/** Generate balanced sales journal lines (quotes are omitted; credit notes flip debit/credit signs). */
export function salesEntry(piece: SalesPiece, validDate = piece.date): JournalEntryLine[] {
  if (piece.type === "quote") return [];
  const sign = piece.type === "credit_note" ? -1 : 1;
  const base = {
    journalCode: "VE",
    journalLib: JOURNALS.VE,
    ecritureNum: piece.number,
    ecritureDate: piece.date,
    pieceRef: piece.number,
    pieceDate: piece.date,
    ecritureLib: `${piece.type === "credit_note" ? "Avoir" : "Facture"} ${piece.number} ${piece.customer.name}`.slice(
      0,
      200,
    ),
    validDate,
  };
  const side = (cents: number, debit: boolean) =>
    cents * sign >= 0 === debit
      ? { debitCents: Math.abs(cents), creditCents: 0 }
      : { debitCents: 0, creditCents: Math.abs(cents) };
  const aux = customerSubAccount(piece.customer.name, piece.customer.taxId);
  const lines: JournalEntryLine[] = [
    {
      ...base,
      compteNum: ACCOUNTS.customers.num,
      compteLib: ACCOUNTS.customers.lib,
      compAuxNum: aux,
      compAuxLib: piece.customer.name,
      ...side(piece.totals.totalInclVatCents, true),
    },
    {
      ...base,
      compteNum: ACCOUNTS.sales.num,
      compteLib: ACCOUNTS.sales.lib,
      ...side(piece.totals.totalExclVatCents, false),
    },
  ];
  for (const [rate, vat] of Object.entries(piece.totals.vatByRate)) {
    if (!vat) continue;
    lines.push({
      ...base,
      compteNum: ACCOUNTS.vat.num,
      compteLib: `${ACCOUNTS.vat.lib} ${(Number(rate) / 10).toString().replace(".", ",")} %`,
      ...side(vat, false),
    });
  }
  return lines.filter((l) => l.debitCents || l.creditCents);
}

export interface PaymentReceipt {
  number: string;
  date: string;
  invoiceNumber: string;
  customer: { name: string; taxId?: string };
  amountCents: number;
}

/** Bank receipt journal entry: debit bank, credit customer auxiliary account. */
export function paymentEntry(receipt: PaymentReceipt): JournalEntryLine[] {
  const base = {
    journalCode: "BQ",
    journalLib: JOURNALS.BQ,
    ecritureNum: receipt.number,
    ecritureDate: receipt.date,
    pieceRef: receipt.invoiceNumber,
    pieceDate: receipt.date,
    ecritureLib: `Reglement ${receipt.invoiceNumber} ${receipt.customer.name}`.slice(0, 200),
    validDate: receipt.date,
  };
  return [
    {
      ...base,
      compteNum: ACCOUNTS.bank.num,
      compteLib: ACCOUNTS.bank.lib,
      debitCents: receipt.amountCents,
      creditCents: 0,
    },
    {
      ...base,
      compteNum: ACCOUNTS.customers.num,
      compteLib: ACCOUNTS.customers.lib,
      compAuxNum: customerSubAccount(receipt.customer.name, receipt.customer.taxId),
      compAuxLib: receipt.customer.name,
      debitCents: 0,
      creditCents: receipt.amountCents,
    },
  ];
}

/** Return unbalanced journal entries (empty array when all debit/credit totals match). */
export function imbalances(lines: JournalEntryLine[]): string[] {
  const balances = new Map<string, number>();
  for (const line of lines) {
    const key = `${line.journalCode} ${line.ecritureNum}`;
    balances.set(key, (balances.get(key) ?? 0) + line.debitCents - line.creditCents);
  }
  return [...balances].filter(([, diff]) => diff !== 0).map(([key, diff]) => `${key}: diff ${diff} cents`);
}

/** Mandatory DGFiP FEC column headers (LPF art. A47 A-1). */
export const FEC_COLUMNS = [
  "JournalCode",
  "JournalLib",
  "EcritureNum",
  "EcritureDate",
  "CompteNum",
  "CompteLib",
  "CompAuxNum",
  "CompAuxLib",
  "PieceRef",
  "PieceDate",
  "EcritureLib",
  "Debit",
  "Credit",
  "EcritureLet",
  "DateLet",
  "ValidDate",
  "Montantdevise",
  "Idevise",
] as const;

const fecDate = (d: string) => d.slice(0, 10).replaceAll("-", "");
const fecAmount = (cents: number) => `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
const cleanField = (s = "") => s.replace(/[\t\r\n|]+/g, " ").trim();

/** Serialize balanced FEC entries as CRLF tab-separated rows sorted by date, journal, and number. */
export function fec(lines: JournalEntryLine[]): string {
  const diffs = imbalances(lines);
  if (diffs.length) throw new Error(`Unbalanced FEC ledger: ${diffs.join("; ")}`);
  const sorted = [...lines].sort(
    (a, b) =>
      a.ecritureDate.localeCompare(b.ecritureDate) ||
      a.journalCode.localeCompare(b.journalCode) ||
      a.ecritureNum.localeCompare(b.ecritureNum),
  );
  const rows = sorted.map((l) =>
    [
      l.journalCode,
      l.journalLib,
      l.ecritureNum,
      fecDate(l.ecritureDate),
      l.compteNum,
      l.compteLib,
      l.compAuxNum ?? "",
      l.compAuxLib ?? "",
      l.pieceRef,
      fecDate(l.pieceDate),
      l.ecritureLib,
      fecAmount(l.debitCents),
      fecAmount(l.creditCents),
      "",
      "",
      fecDate(l.validDate),
      "",
      "",
    ]
      .map(cleanField)
      .join("\t"),
  );
  return [FEC_COLUMNS.join("\t"), ...rows].join("\r\n") + "\r\n";
}

/** Statutory FEC filename: `<SIREN>FEC<YYYYMMDD>.txt`. */
export const fecFilename = (siren: string, closingDate: string): string => `${siren}FEC${fecDate(closingDate)}.txt`;

/** Encode text into ISO-8859-15 (Latin-9) replacing unsupported codepoints with `?`. */
export function encodeLatin9(input: string): Uint8Array<ArrayBuffer> {
  const specials: Record<string, number> = {
    "€": 0xa4,
    Š: 0xa6,
    š: 0xa8,
    Ž: 0xb4,
    ž: 0xb8,
    Œ: 0xbc,
    œ: 0xbd,
    Ÿ: 0xbe,
  };
  const replaced = new Set([0xa4, 0xa6, 0xa8, 0xb4, 0xb8, 0xbc, 0xbd, 0xbe]);
  const out = new Uint8Array(input.length);
  let i = 0;
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    out[i++] = specials[ch] ?? (code < 0x100 && !replaced.has(code) ? code : 0x3f);
  }
  return out.slice(0, i);
}

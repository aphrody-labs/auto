import { expect, test } from "bun:test";
import {
  computeTotals,
  formatDocumentNumber,
  frVatNumber,
  fullCreditNote,
  lineNetExclVat,
  partialCreditNote,
  quoteToInvoice,
  validSiren,
  validSiret,
  validVatRate,
  verifyCustomer,
  verifyDocument,
  verifyProduct,
  withDefaultLegalTerms,
  type Document,
} from "./index";

const issuer = {
  name: "ACME SAS",
  taxId: "73282932000074",
  address: "1 Rue A, Paris",
  vatNumber: "FR44732829320",
};
const customer = { name: "Client Co", taxId: "73282932000074", address: "2 Rue B, Lyon" };
const quote: Document = {
  type: "quote",
  date: "2026-10-01",
  issuer,
  customer,
  lines: [{ description: "Audit", quantity: 2, unitPriceExclVatCents: 50000, vat: 200 }],
  validityDays: 30,
};

test("computes totals grouped by VAT rate", () => {
  const totals = computeTotals([
    { description: "a", quantity: 2, unitPriceExclVatCents: 5000, vat: 200 },
    { description: "b", quantity: 1, unitPriceExclVatCents: 1000, vat: 55 },
  ]);
  expect(totals.totalExclVatCents).toBe(11000);
  expect(totals.totalVatCents).toBe(2055);
  expect(totals.totalInclVatCents).toBe(13055);
  expect(totals.byRate).toEqual([
    { rate: 55, baseExclVatCents: 1000, vatCents: 55 },
    { rate: 200, baseExclVatCents: 10000, vatCents: 2000 },
  ]);
});

test("validates SIRET, SIREN, VAT key, and VAT rates", () => {
  expect(validSiret("73282932000074")).toBe(true);
  expect(validSiret("73282932000075")).toBe(false);
  expect(validSiren("732829320")).toBe(true);
  expect(validSiren("732829321")).toBe(false);
  expect(frVatNumber("732829320")).toBe("FR44732829320");
  expect(validVatRate(200)).toBe(true);
  expect(validVatRate(190)).toBe(false);
});

test("formats site-scoped and cloud document numbers", () => {
  expect(formatDocumentNumber("invoice", 2026, 1)).toBe("INV-2026-0001");
  expect(formatDocumentNumber("deposit", 2026, 2)).toBe("INV-2026-0002");
  expect(formatDocumentNumber("invoice", 2026, 7, "laptop-1")).toBe("INV-laptop-1-2026-0007");
  expect(formatDocumentNumber("credit_note", 2026, 1)).toBe("CN-2026-0001");
  expect(formatDocumentNumber("quote", 2026, 12)).toBe("QUO-2026-0012");
});

test("validates quote, invoice conversion, VAT exemption, and credit notes", () => {
  expect(verifyDocument(quote)).toEqual([]);
  const inv = quoteToInvoice(quote, "QUO-2026-0001", "2026-10-10", "2026-11-09");
  expect(verifyDocument(inv)).toEqual(["Missing supply or service date"]);
  expect(verifyDocument({ ...inv, serviceDate: "2026-10-05" })).toEqual([]);
  expect(inv.origin).toBe("QUO-2026-0001");

  const bareInvoice: Document = { ...quote, type: "invoice" };
  const errs = verifyDocument(bareInvoice);
  expect(errs).toContain("Missing due date");
  expect(errs).toContain("Missing late payment penalty terms");
  expect(
    verifyDocument(withDefaultLegalTerms({ ...bareInvoice, dueDate: "2026-11-01", serviceDate: "2026-10-01" })),
  ).toEqual([]);

  const exempt: Document = { ...quote, issuer: { ...issuer, vatNumber: undefined }, vatExempt: true };
  expect(verifyDocument(exempt)).toContain("VAT exemption requires 0% VAT on all lines");
  expect(verifyDocument({ ...exempt, lines: [{ ...quote.lines[0]!, vat: 0 }] })).toEqual([]);

  const fullCn = fullCreditNote(inv, "INV-2026-0001", "2026-10-20");
  expect(fullCn.type).toBe("credit_note");
  expect(fullCn.origin).toBe("INV-2026-0001");
  expect(() => fullCreditNote(quote, "QUO-1", "2026-10-20")).toThrow();

  const partialCn = partialCreditNote(inv, "INV-2026-0001", "2026-10-20", [{ ...inv.lines[0]!, quantity: 1 }]);
  expect(computeTotals(partialCn.lines).totalInclVatCents).toBe(60000);
  expect(() => partialCreditNote(inv, "INV-2026-0001", "2026-10-20", [])).toThrow();
});

test("matches auto-model line discount rounding and verifies customers/products", () => {
  const discounted = (quantity: number, unitPriceExclVatCents: number, discountBp: number) =>
    lineNetExclVat({ description: "x", quantity, unitPriceExclVatCents, vat: 200, discountBp });
  expect(discounted(3, 33333, 1250)).toBe(87499);
  expect(discounted(1.5, 19999, 1000)).toBe(26999);
  expect(discounted(7, 1999, 333)).toBe(13527);
  expect(verifyDocument({ ...quote, lines: [{ ...quote.lines[0]!, discountBp: 12000 }] })).toContain(
    "Line 1: invalid discount",
  );
  expect(verifyCustomer(customer)).toEqual([]);
  expect(verifyCustomer({ name: "" })).toContain("Customer name is required");
  expect(verifyProduct({ description: "Consulting", unitPriceExclVatCents: 10000, vat: 200 })).toEqual([]);
});

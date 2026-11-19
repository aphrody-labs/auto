import { expect, test } from "bun:test";
import { computeTotals } from "./index";
import { customerSubAccount, encodeLatin9, fec, fecFilename, imbalances, paymentEntry, salesEntry } from "./accounting";

const totals = computeTotals([
  { description: "A", quantity: 1, unitPriceExclVatCents: 10000, vat: 200 },
  { description: "B", quantity: 1, unitPriceExclVatCents: 5000, vat: 55 },
]);
const customer = { name: "Societe Durand", taxId: "73282932000074" };

test("generates balanced sales and credit note entries ignoring quotes", () => {
  const entries = salesEntry({ type: "invoice", number: "INV-2026-0001", date: "2026-10-01", customer, totals });
  expect(entries.map((l) => [l.compteNum, l.compteLib, l.debitCents, l.creditCents])).toEqual([
    ["411000", "Clients", 17275, 0],
    ["706000", "Prestations de services", 0, 15000],
    ["445710", "TVA collectee 5,5 %", 0, 275],
    ["445710", "TVA collectee 20 %", 0, 2000],
  ]);
  expect(entries[0]!.compAuxNum).toBe("C732829320");
  expect(imbalances(entries)).toEqual([]);

  const credit = salesEntry({ type: "credit_note", number: "CN-2026-0001", date: "2026-10-02", customer, totals });
  expect([credit[0]!.debitCents, credit[0]!.creditCents, credit[1]!.debitCents]).toEqual([0, 17275, 15000]);
  expect(imbalances(credit)).toEqual([]);

  expect(salesEntry({ type: "quote", number: "QUO-1", date: "2026-10-01", customer, totals })).toEqual([]);
  expect(customerSubAccount("Société Durand")).toBe("CSOCIETEDU");
});

test("formats compliant 18-column FEC export in Latin-9", () => {
  const lines = [
    ...paymentEntry({
      number: "BQ-0001",
      date: "2026-10-15",
      invoiceNumber: "INV-2026-0001",
      customer,
      amountCents: 17275,
    }),
    ...salesEntry({ type: "invoice", number: "INV-2026-0001", date: "2026-10-01", customer, totals }),
  ];
  const text = fec(lines);
  expect(text.endsWith("\r\n")).toBe(true);
  const rows = text
    .slice(0, -2)
    .split("\r\n")
    .map((r) => r.split("\t"));
  expect(rows).toHaveLength(7);
  expect(rows.every((r) => r.length === 18)).toBe(true);
  expect(rows[0]![0]).toBe("JournalCode");
  expect(rows[1]!.slice(0, 4)).toEqual(["VE", "Ventes", "INV-2026-0001", "20261001"]);
  expect(rows[1]![11]).toBe("172,75");
  expect(rows[6]!.slice(0, 2)).toEqual(["BQ", "Banque"]);
  expect(() => fec([{ ...lines[0]!, debitCents: 1 }])).toThrow("Unbalanced");
  expect(fecFilename("732829320", "2026-12-31")).toBe("732829320FEC20261231.txt");
  expect([...encodeLatin9("é€x一")]).toEqual([0xe9, 0xa4, 0x78, 0x3f]);
});

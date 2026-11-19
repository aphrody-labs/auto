import { expect, test } from "bun:test";
import {
  badgeText,
  detectFileMime,
  formatApiError,
  formatIngestNotification,
  hostPattern,
  ingestUrl,
  isValidApiToken,
  normalizeInstance,
  sanitizeFilename,
} from "./lib";

const bytes = (s: string) => new TextEncoder().encode(s);

test("normalizes instance origins and enforces HTTPS outside localhost", () => {
  expect(normalizeInstance(" https://auto.aphrody.com/app/invoices ")).toBe("https://auto.aphrody.com");
  expect(normalizeInstance("http://localhost:3000")).toBe("http://localhost:3000");
  expect(() => normalizeInstance("http://auto.example.com")).toThrow("HTTPS");
  expect(() => normalizeInstance("not-a-url")).toThrow("Invalid");
  expect(hostPattern("https://billing.vendor.com/f/123.pdf")).toBe("https://billing.vendor.com/*");
});

test("validates auto_ API tokens and magic bytes", () => {
  expect(isValidApiToken("auto_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_")).toBe(true);
  expect(isValidApiToken("Bearer abc")).toBe(false);
  expect(detectFileMime(bytes("%PDF-1.7\n..."))).toBe("application/pdf");
  expect(detectFileMime(bytes("\uFEFF<?xml version='1.0'?><rsm:CrossIndustryInvoice/>"))).toBe("application/xml");
  expect(detectFileMime(bytes("<!doctype html>"))).toBeNull();
});

test("sanitizes Content-Disposition / URL filenames and notification formatting", () => {
  expect(sanitizeFilename("https://x.fr/dl", "attachment; filename*=UTF-8''Invoice%207.pdf", "application/pdf")).toBe(
    "Invoice 7.pdf",
  );
  expect(sanitizeFilename("https://x.fr/a", 'attachment; filename="../../etc/passwd"', "application/pdf")).toBe(
    ".._.._etc_passwd.pdf",
  );
  expect(ingestUrl("https://auto.aphrody.com", "Inv 1.pdf")).toBe(
    "https://auto.aphrody.com/v1/ingest?filename=Inv%201.pdf",
  );

  const ok = formatIngestNotification(
    { id: "1", extracted: { supplierName: "Vendor SAS", number: "INV-12", totalInclVatCents: 123456, anomalies: [] } },
    "f.pdf",
  );
  expect(ok.title).toBe("Invoice recorded");
  expect(ok.message).toContain("Vendor SAS");
  expect(formatIngestNotification({ id: "1", duplicate: true }, "f.pdf").title).toBe("Already uploaded");
  expect([0, 7, 150].map(badgeText)).toEqual(["", "7", "99+"]);
  expect(formatApiError(401, null)).toContain("rejected");
});

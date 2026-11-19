import { expect, test } from "bun:test";
import {
  authCanPerform,
  authGenerateApiKey,
  authHashPassword,
  authJwks,
  authOpenSecret,
  authSealSecret,
  authSignJwt,
  authSignToken,
  authTotpCode,
  authTotpVerify,
  authVerifyJwt,
  authVerifyPassword,
  authVerifyToken,
  chunkText,
  createDocx,
  createPptx,
  docxTemplateFields,
  docxText,
  docxToPdf,
  excelDate,
  extractPdfPages,
  extractXml,
  facturx,
  fillDocxTemplate,
  frameParts,
  isEnglishWasmReady,
  mergePdfs,
  modifyXlsx,
  NativeError,
  nearestVectors,
  parseTotalInclVatCents,
  pdfDate,
  pdfText,
  pptxToPdf,
  readSpreadsheet,
  redactPdf,
  renderPdf,
  replaceDocx,
  signPdf,
  unframeParts,
  verifyPdfA,
  verifyPdfSignatures,
  writeXlsx,
  xmlCii,
} from "./index";

const HAS_ENGLISH_WASM = isEnglishWasmReady();

const sampleInvoice = {
  number: "INV-2026-0001",
  type: "invoice",
  date: "2026-10-22",
  issuer: { name: "Alpha SAS", taxId: "73282932000074", address: "1 Rue A, Paris", vatNumber: "FR44732829320" },
  customer: { name: "Client Co", taxId: "73282932000074", address: "2 Rue B, Lyon" },
  lines: [{ description: "Engineering", quantity: 3, unitPriceExclVatCents: 60000, vat: 200 }],
  serviceDate: "2026-10-15",
  dueDate: "2026-11-21",
  latePenalties: "3 times the statutory interest rate",
  earlyDiscount: "None",
};

test("round-trips u32 LE binary framing and utility helpers", () => {
  const a = new TextEncoder().encode("alpha");
  const b = new Uint8Array([1, 2, 3, 4]);
  const framed = frameParts([a, b]);
  const parts = unframeParts(framed);
  expect(parts).toHaveLength(2);
  expect(new TextDecoder().decode(parts[0]!)).toBe("alpha");
  expect([...parts[1]!]).toEqual([1, 2, 3, 4]);

  expect(parseTotalInclVatCents("<ram:GrandTotalAmount>2160.05</ram:GrandTotalAmount>")).toBe(216005);
  expect(parseTotalInclVatCents("<ram:GrandTotalAmount>-12.30</ram:GrandTotalAmount>")).toBe(-1230);
  expect(parseTotalInclVatCents("<x/>")).toBeNull();
  expect(excelDate(46317)).toBe("2026-10-22");
  expect(pdfDate(new Date("2026-10-23T12:34:56Z"))).toBe("D:20261023123456Z");
});

test.skipIf(!HAS_ENGLISH_WASM)("renders PDF, Factur-X XML/PDF-A-3b, and surfaces native errors", () => {
  const quotePdf = renderPdf({ ...sampleInvoice, type: "quote", number: "" });
  expect(new TextDecoder().decode(quotePdf.subarray(0, 5))).toBe("%PDF-");

  const fxPdf = facturx(sampleInvoice, new Date("2026-10-22T10:00:00Z"));
  expect(verifyPdfA(fxPdf)).toEqual([]);
  const xml = extractXml(fxPdf)!;
  expect(xml).toBe(xmlCii(sampleInvoice));
  expect(xml).toContain("<ram:GrandTotalAmount>2160.00</ram:GrandTotalAmount>");
  expect(extractXml(renderPdf(sampleInvoice))).toBeNull();

  expect(() => xmlCii({ ...sampleInvoice, type: "quote" })).toThrow(NativeError);
  expect(() => renderPdf({})).toThrow();
});

test.skipIf(!HAS_ENGLISH_WASM)("writes, edits, and reads XLSX spreadsheets and CSV", () => {
  const xlsx = writeXlsx({
    sheets: [
      {
        name: "Sales",
        columns: [{ title: "Date", type: "date" }, { title: "Customer" }, { title: "Incl VAT", type: "euros" }],
        rows: [["2026-10-22", "Dupont", 216000]],
      },
      {
        name: "Calc",
        columns: [
          { title: "A", type: "number" },
          { title: "B", type: "number" },
          { title: "Sum", type: "number" },
        ],
        rows: [[2, 3, null]],
      },
    ],
  });
  const read = readSpreadsheet(xlsx);
  expect(read.format).toBe("xlsx");
  expect(read.sheets[0]!.rows[1]).toEqual([46317, "Dupont", 2160]);
  const withFormula = modifyXlsx(xlsx, [{ sheet: "Calc", row: 2, col: 3, formula: "=A2+B2" }]);
  expect(readSpreadsheet(withFormula).sheets[1]!.rows[1]![2]).toBe(5);
  expect(() => writeXlsx({ sheets: [] })).toThrow(NativeError);
});

test.skipIf(!HAS_ENGLISH_WASM)(
  "merges PDFs, manipulates DOCX templates, redacts, signs, and converts PPTX",
  async () => {
    const a = renderPdf({ ...sampleInvoice, type: "quote", number: "QUO-1" });
    const tpl = createDocx({
      title: "Quote {{ number }}",
      paragraphs: [{ text: "For {{ customer }}, {{ customer }}" }, { text: "Keep {{ other }}" }],
    });
    expect(docxTemplateFields(tpl)).toEqual(["number", "customer", "other"]);
    const filled = fillDocxTemplate(tpl, { number: "QUO-7", customer: "Zoe" });
    expect(docxText(filled)).toBe("Quote QUO-7\nFor Zoe, Zoe\nKeep {{ other }}");
    const replaced = replaceDocx(filled, [{ find: "Zoe", replace: "Francois" }]);
    expect(docxText(replaced)).toContain("For Francois, Francois");

    const b = docxToPdf(filled);
    const merged = mergePdfs([
      { name: "quote.pdf", bytes: a },
      { name: "annex.pdf", bytes: b },
    ]);
    const pages = pdfText(merged);
    expect(pages).toHaveLength(2);
    expect(pdfText(extractPdfPages(merged, [2]))).toEqual([pages[1]!]);

    const redactSource = docxToPdf(
      createDocx({
        title: "Statement",
        paragraphs: [{ text: "Email zoe@example.org IBAN FR76 3000 6000 0112 3456 7890 189" }],
      }),
    );
    const { pdf: redacted, report } = redactPdf(redactSource, { patterns: ["email", "iban"] });
    expect(report.occurrences).toBe(2);
    expect(pdfText(redacted).join("\n")).not.toContain("zoe@");

    const ecP12 = Bun.file(new URL("../../../crates/auto-files/tests/data/ec-p256.p12", import.meta.url));
    if (await ecP12.exists()) {
      const signed = signPdf(b, await ecP12.bytes(), { password: "test", reason: "Approved" });
      const sigs = verifyPdfSignatures(signed);
      expect(sigs).toHaveLength(1);
      expect(sigs[0]!.signed).toBe(true);
      expect(sigs[0]!.status).toBe("unknown");
      expect(sigs[0]!.modifications).toBe("none");
    }
    const rsaP12 = Bun.file(new URL("../../../crates/auto-files/tests/data/rsa-aes.p12", import.meta.url));
    if (await rsaP12.exists()) {
      const rsaBytes = await rsaP12.bytes();
      expect(() => signPdf(b, rsaBytes, { password: "test" })).toThrow("not supported: RSA signing");
    }

    const fxFr = facturx(sampleInvoice, new Date("2026-10-22T10:00:00Z"), "fr");
    expect(pdfText(fxFr).join("\n")).toContain("Facture");

    const pptx = createPptx({
      title: "Summary",
      subtitle: "Workshop",
      slides: [{ title: "Metrics", bullets: ["Revenue up", { text: "Services", level: 1 }] }],
    });
    expect(pdfText(pptxToPdf(pptx))).toHaveLength(2);
  },
);

test.skipIf(!HAS_ENGLISH_WASM)("chunks markdown/prose and ranks nearest vectors", () => {
  const md = chunkText("guide.md", "# Guide\n\n## Warranty\n\nTwo years.\n\n## Returns\n\nThirty days.\n");
  expect(md.find((c) => c.text.includes("Two years"))!.heading).toBe("Guide > Warranty");

  const matrix = Float32Array.from([1, 0, 0, 0, 1, 0, 0.6, 0.8, 0]);
  const top = nearestVectors([0, 2, 0], matrix, 3, 2);
  expect(top.map((x) => x.index)).toEqual([1, 2]);
  expect(top[0]!.score).toBeCloseTo(1, 5);
});

test.skipIf(!HAS_ENGLISH_WASM)(
  "runs Rust Better Auth primitives (Argon2id, Ed25519 JWT/JWKS, ChaCha20, TOTP, RBAC) over Wasm",
  () => {
    const hash = authHashPassword("CorrectHorse99!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(authVerifyPassword("CorrectHorse99!", hash)).toBe(true);
    expect(authVerifyPassword("WrongPassword", hash)).toBe(false);

    const secret = "test-master-secret-32-chars-minimum!!";
    const jwks = authJwks({ masterSecret: secret });
    expect(jwks.keys[0]?.alg).toBe("EdDSA");

    const now = 1_795_000_000;
    const signed = authSignJwt({
      masterSecret: secret,
      claims: {
        iss: "https://auto.aphrody.com",
        sub: "u_1",
        aud: "https://auto.aphrody.com/mcp",
        iat: now,
        exp: now + 300,
      },
    });
    const verified = authVerifyJwt({
      masterSecret: secret,
      token: signed.token,
      expectedIssuer: "https://auto.aphrody.com",
      expectedAudience: "https://auto.aphrody.com/mcp",
      nowUnixSecs: now + 10,
    });
    expect(verified.sub).toBe("u_1");

    const sealed = authSealSecret(secret, "mail/oauth", new TextEncoder().encode("oauth-refresh"));
    expect(new TextDecoder().decode(authOpenSecret(secret, "mail/oauth", sealed))).toBe("oauth-refresh");

    const { code, uri } = authTotpCode("JBSWY3DPEHPK3PXP", now, "Auto", "dev@aphrody.com");
    expect(uri).toContain("otpauth://totp/");
    expect(authTotpVerify("JBSWY3DPEHPK3PXP", code, now)).toBe(true);

    const tok = authSignToken(secret, "session", { sid: "s1" });
    expect(authVerifyToken<{ sid: string }>(secret, "session", tok).sid).toBe("s1");

    const key = authGenerateApiKey("auto_");
    expect(key.rawKey.startsWith("auto_")).toBe(true);
    expect(authCanPerform("owner", "billing")).toBe(true);
    expect(authCanPerform("readonly", "write")).toBe(false);
  },
);

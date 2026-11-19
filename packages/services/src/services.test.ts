import { afterEach, expect, test } from "bun:test";
import { createDocx, facturx, writeXlsx } from "@aphrody/auto-native";
import { createCustomer, createDraft, issueDocument, migrate, testDb, withCompany } from "@aphrody/auto-store";
import {
  applyStudioOperation,
  assertSafeWebhookUrl,
  AUTO_TOOLS,
  checkQuota,
  checkRenewalReminder,
  classifyInboundEmail,
  createBlankStudioFile,
  createMemoryMailer,
  dispatchOutboxBatch,
  executeWorkflow,
  findTool,
  handleMcpJsonRpc,
  importLegacyN8nWorkflow,
  ingestDocument,
  inspectStudioFile,
  lookupDirectory,
  signWebhookPayload,
  submitEInvoice,
  submitEReporting,
  validateWorkflow,
  verifyStripeWebhookSignature,
  verifyWebhookSignature,
} from "./index";

const drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (drops.length) await drops.pop()!();
});

const SAMPLE_DOC = {
  type: "invoice" as const,
  date: "2026-11-18",
  dueDate: "2026-12-18",
  serviceDate: "2026-11-18",
  latePenalties: "3 times legal rate",
  earlyDiscount: "None",
  issuer: {
    name: "Aphrody SAS",
    taxId: "73282932000074",
    address: "10 Rue de Rivoli, Paris",
    vatNumber: "FR44732829320",
  },
  customer: {
    name: "Acme GmbH",
    address: "1 Alexanderplatz, Berlin",
  },
  lines: [{ description: "Consulting", quantity: 2, unitPriceExclVatCents: 100_000, vat: 200 as const }],
};

test("events: SSRF guard + HMAC signature + outbox batch delivery", async () => {
  expect(() => assertSafeWebhookUrl("http://169.254.169.254/latest", false)).toThrow();
  expect(() => assertSafeWebhookUrl("http://localhost:8080/hook", false)).toThrow();
  expect(assertSafeWebhookUrl("https://hooks.example.com/auto", false).hostname).toBe("hooks.example.com");

  const sig = await signWebhookPayload("top-secret-key", '{"ok":true}');
  expect(await verifyWebhookSignature("top-secret-key", '{"ok":true}', sig)).toBe(true);
  expect(await verifyWebhookSignature("wrong-key", '{"ok":true}', sig)).toBe(false);

  const delivered: string[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      delivered.push(await req.text());
      return new Response("ok");
    },
  });
  const env = await testDb();
  drops.push(env.drop);
  await migrate(env.sql);
  try {
    const res = await withCompany(env.sql, "comp_1", async (tx) => {
      const cust = await createCustomer(tx, "u1", { name: "Acme", address: "Paris" });
      await createDraft(tx, "u1", SAMPLE_DOC, cust.id);
      const out =
        await tx`INSERT INTO outbox (id, company_id, type, payload_json) VALUES ('ev1', 'comp_1', 'document.issued', '{"n":1}')`;
      void out;
      return dispatchOutboxBatch(tx, [{ url: srv.url.origin, secret: "whsec_1234" }], { allowPrivate: true });
    });
    expect(res.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
  } finally {
    await srv.stop(true);
  }
});

test("ingest, einvoicing, billing & renewal reminders", async () => {
  const env = await testDb();
  drops.push(env.drop);
  await migrate(env.sql);

  const mailer = createMemoryMailer();
  const pdf = facturx({ ...SAMPLE_DOC, number: "INV-2026-0001" }, new Date("2026-11-18T00:00:00Z"), "en");

  await withCompany(env.sql, "comp_billing", async (tx) => {
    await tx`
      INSERT INTO company (id, name, siren, siret, slug, plan, billing_period, subscription_status, period_ends_at)
      VALUES ('comp_billing', 'Aphrody', '732829320', '73282932000074', 'aphrody', 'pro', 'monthly', 'active', '2026-11-25T10:00:00Z')`;
    const q = await checkQuota(tx, "invoices", new Date("2026-11-18T00:00:00Z"));
    expect(q.limit).toBe(1000);

    const ing1 = await ingestDocument(tx, "u1", { bytes: pdf, filename: "inv.pdf", mimeType: "application/pdf" });
    expect(ing1.duplicate).toBe(false);
    expect(ing1.extracted.totalInclVatCents).toBe(240_000);
    const ing2 = await ingestDocument(tx, "u1", { bytes: pdf, filename: "inv.pdf", mimeType: "application/pdf" });
    expect(ing2.duplicate).toBe(true);

    const draft = await createDraft(tx, "u1", SAMPLE_DOC);
    const issued = await issueDocument(tx, "u1", draft.id);
    const pa = await submitEInvoice(tx, {
      documentId: issued.id,
      doc: issued.data,
      pdfBytes: pdf,
      config: { provider: "mock", accountId: "acc1", apiKey: "key1", webhookSecret: "sec1" },
    });
    expect(pa.status).toBe("submitted");

    const erep = await submitEReporting(tx, {
      period: "2026-11",
      kind: "b2c",
      lines: [{ date: "2026-11-18", vatRate: 200, exclVatCents: 10000, vatCents: 2000 }],
    });
    expect(erep.totalVatCents).toBe(2000);

    const rem = await checkRenewalReminder(tx, "2026-11-18", { mailer });
    expect(rem?.plan).toBe("pro");
  });

  const dir = await lookupDirectory("732829320", "mock");
  expect(dir?.registered).toBe(true);

  expect(
    classifyInboundEmail({
      subject: "Facture #104",
      text: "Please find attached",
      attachments: [{ filename: "f104.pdf", mimeType: "application/pdf" }],
    }),
  ).toBe("invoice");

  const secret = "whsec_test";
  const ts = 1_760_000_000;
  const body = '{"id":"evt_1"}';
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  expect(await verifyStripeWebhookSignature(body, `t=${ts},v1=${sig}`, secret, { nowSeconds: ts + 10 })).toBe(true);
});

test("studio operations, DAG workflows, legacy n8n import, and MCP JSON-RPC tools", async () => {
  const blankDocx = createBlankStudioFile("docx");
  expect(inspectStudioFile(blankDocx, "docx").format).toBe("docx");

  const tplDocx = createDocx({ title: "Offer", paragraphs: [{ text: "Client: {{customer}}" }] });
  const filled = applyStudioOperation(tplDocx, "docx", { type: "fill_docx", values: { customer: "Acme" } });
  const asPdf = applyStudioOperation(filled.bytes, "docx", { type: "docx_to_pdf" });
  expect(asPdf.format).toBe("pdf");

  const xlsx = writeXlsx({ sheets: [{ name: "S1", columns: [{ title: "Item" }], rows: [["Consulting"]] }] });
  expect(inspectStudioFile(xlsx, "xlsx").format).toBe("xlsx");

  const def = validateWorkflow({
    version: 1,
    nodes: [
      { id: "t", type: "trigger.manual", config: {} },
      { id: "c", type: "condition.if", config: { left: "{{$json.amount}}", op: "gt", right: 100 } },
      { id: "hi", type: "code.run", config: { expression: "$json.input.amount * 2" } },
      { id: "lo", type: "transform.map", config: { label: "small" } },
    ],
    edges: [
      { from: "t", to: "c" },
      { from: "c", to: "hi", condition: "true" },
      { from: "c", to: "lo", condition: "false" },
    ],
  });
  const wfRes = await executeWorkflow(def, { amount: 250 });
  expect(wfRes.status).toBe("success");
  expect(wfRes.output).toBe(500);

  const migrated = importLegacyN8nWorkflow({
    nodes: [
      { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: {} },
      { name: "Compute", type: "n8n-nodes-base.code", parameters: { expression: "$json.x + 1" } },
    ],
    connections: { Webhook: { main: [[{ node: "Compute" }]] } },
  });
  expect(migrated.nodes).toHaveLength(2);
  expect(migrated.edges).toHaveLength(1);

  expect(AUTO_TOOLS.length).toBeGreaterThanOrEqual(18);
  const env = await testDb();
  drops.push(env.drop);
  await migrate(env.sql);

  const rpcList = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, async () => ({}));
  expect((rpcList?.result as { tools: unknown[] }).tools.length).toBe(AUTO_TOOLS.length);

  const rpcCall = await handleMcpJsonRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_customer", arguments: { name: "Beta", address: "Lyon" } },
    },
    (name, args) => withCompany(env.sql, "comp_mcp", (tx) => findTool(name)!.execute(args, { tx, actor: "agent" })),
  );
  const text = (rpcCall?.result as { content: { text: string }[] }).content[0]?.text ?? "";
  expect(text).toContain("Beta");
});

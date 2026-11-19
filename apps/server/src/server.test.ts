import { afterEach, expect, test } from "bun:test";
import { createAutoClient } from "@aphrody/auto-client";
import { createSelfHostedServer } from "./self-hosted";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test("apps/server full end-to-end flow: health, Rust auth, company creation, documents, Factur-X, FEC, MCP & sync", async () => {
  const rt = await createSelfHostedServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
  });
  cleanups.push(() => rt.stop());

  // 1. Health & Rust Better Auth helper endpoints
  const h = await fetch(`${rt.url}/health`).then(
    (r) => r.json() as Promise<{ ok: boolean; mode: string; auth: string }>,
  );
  expect(h.ok).toBe(true);
  expect(h.mode).toBe("self-hosted");

  const hashed = (await fetch(`${rt.url}/api/auth/rust/hash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "MyStrongPassword#2026" }),
  }).then((r) => r.json())) as { hash: string };
  expect(hashed.hash.startsWith("$argon2id$")).toBe(true);

  const verified = (await fetch(`${rt.url}/api/auth/rust/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "MyStrongPassword#2026", hash: hashed.hash }),
  }).then((r) => r.json())) as { valid: boolean };
  expect(verified.valid).toBe(true);

  // 2. Better Auth email sign-up -> session cookie + bearer JWT/session
  const signup = await fetch(`${rt.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@aphrody.com", password: "Password123456!", name: "Owner" }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const compRes = await fetch(`${rt.url}/v1/companies`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Aphrody SAS", taxId: "73282932000074", address: "10 Rue de Rivoli, Paris" }),
  });
  expect(compRes.status).toBe(201);
  const comp = (await compRes.json()) as { id: string; siren: string };
  expect(comp.siren).toBe("732829320");

  // 3. SDK AutoClient with company header + session cookie
  const client = createAutoClient({
    baseUrl: rt.url,
    companyId: comp.id,
    fetcher: ((input, init) => {
      const hdrs = new Headers(init?.headers);
      hdrs.set("cookie", cookie);
      return fetch(input, { ...init, headers: hdrs });
    }) as typeof fetch,
  });

  const cust = await client.createCustomer({ name: "Acme Client", address: "Lyon, France" });
  expect(cust.id).toBeTruthy();

  const draft = (await client.createDraft(
    {
      type: "invoice",
      date: "2026-11-18",
      dueDate: "2026-12-18",
      serviceDate: "2026-11-18",
      issuer: {
        name: "Aphrody SAS",
        taxId: "73282932000074",
        address: "10 Rue de Rivoli, Paris",
        vatNumber: "FR44732829320",
      },
      customer: { name: cust.name, address: cust.address },
      lines: [{ description: "Platform Engineering", quantity: 1, unitPriceExclVatCents: 100_000, vat: 200 }],
    },
    cust.id,
  )) as { id: string; status: string };
  expect(draft.status).toBe("draft");

  const issued = (await client.issueDocument(draft.id)) as { id: string; number: string; status: string };
  expect(issued.status).toBe("issued");
  expect(issued.number).toMatch(/^INV-2026-\d{4}$/);

  const pdfBytes = await client.downloadDocumentPdf(issued.id);
  expect(new TextDecoder().decode(pdfBytes.subarray(0, 5))).toBe("%PDF-");

  const xml = await client.downloadDocumentXml(issued.id);
  expect(xml).toContain("CrossIndustryInvoice");

  const fecText = await client.exportFec("2026-01-01", "2026-12-31");
  expect(fecText).toContain("JournalCode\t");

  const mcpRes = await client.mcpCallTool("search_workspace", { query: "Acme" });
  expect(JSON.stringify(mcpRes.result)).toContain("Acme Client");

  const pull = await client.syncPull(0, 100);
  expect(pull.changes.length).toBeGreaterThan(0);
});

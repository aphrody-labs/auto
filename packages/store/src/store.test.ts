import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Document } from "@aphrody/auto-domain";
import {
  appendAudit,
  applyRemoteChanges,
  can,
  compareHlc,
  createCompanyWithOwner,
  createCustomer,
  createDraft,
  createProduct,
  decryptSecret,
  diffBlobManifest,
  encryptSecret,
  exportAccountingData,
  getDocument,
  issueDocument,
  nextHlc,
  pullChanges,
  recordPayment,
  setSite,
  testDb,
  totp,
  transitionDocumentStatus,
  verifyAuditChain,
  verifyTotp,
  withCompany,
  type Sql,
} from "./index";

let sql: Sql;
let drop: () => Promise<void>;
let companyA: string;
let companyB: string;

const sampleDoc: Document = {
  type: "invoice",
  date: "2026-10-22",
  issuer: { name: "Alpha SAS", taxId: "73282932000074", address: "1 Main St, Paris", vatNumber: "FR44732829320" },
  customer: { name: "Client Co", taxId: "73282932000074", address: "2 Side St, Lyon" },
  lines: [{ description: "Engineering", quantity: 2, unitPriceExclVatCents: 50000, vat: 200 }],
  serviceDate: "2026-10-15",
  dueDate: "2026-11-21",
  latePenalties: "3 times the statutory interest rate",
  earlyDiscount: "None",
};

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  await sql`INSERT INTO app_user (id, email, name) VALUES (${"u1"}, ${"owner@alpha.test"}, ${"Owner"})`;
  companyA = (await createCompanyWithOwner(sql, "u1", { name: "Alpha SAS", taxId: "73282932000074", address: "Paris" }))
    .id;
  companyB = (await createCompanyWithOwner(sql, "u1", { name: "Beta SAS", taxId: "73282932000074", address: "Lyon" }))
    .id;
});

afterAll(() => drop());

test("drafts issue sequentially with immutability triggers and hash-chained audit logs", async () => {
  const draft = await withCompany(sql, companyA, (tx) => createDraft(tx, "u1", sampleDoc));
  expect(draft.number).toBeNull();
  expect(draft.inclVatCents).toBe(120000);

  const issued = await withCompany(sql, companyA, (tx) => issueDocument(tx, "u1", draft.id));
  expect(issued.number).toBe("INV-2026-0001");
  expect(issued.status).toBe("issued");

  await expect(
    withCompany(sql, companyA, (tx) => tx`UPDATE document SET data = '{}' WHERE id = ${issued.id}`),
  ).rejects.toThrow("cannot be modified");
  await expect(withCompany(sql, companyA, (tx) => tx`DELETE FROM document WHERE id = ${issued.id}`)).rejects.toThrow(
    "cannot be deleted",
  );

  const paid = await withCompany(sql, companyA, (tx) =>
    recordPayment(tx, "u1", { documentId: issued.id, date: "2026-10-25", amountCents: 120000, method: "transfer" }),
  );
  expect(paid.totalPaidCents).toBe(120000);
  const reloaded = await withCompany(sql, companyA, (tx) => getDocument(tx, issued.id));
  expect(reloaded?.status).toBe("paid");

  await expect(
    withCompany(sql, companyA, (tx) => transitionDocumentStatus(tx, "u1", issued.id, "cancelled")),
  ).rejects.toThrow("not allowed");

  const chain = await withCompany(sql, companyA, (tx) => verifyAuditChain(tx));
  expect(chain.valid).toBe(true);
  expect(chain.count).toBeGreaterThanOrEqual(3);

  const exported = await withCompany(sql, companyA, (tx) => exportAccountingData(tx, "2026-01-01", "2026-12-31"));
  expect(exported.sales).toHaveLength(1);
  expect(exported.receipts).toHaveLength(1);
});

test("enforces company isolation, 50 concurrent gapless numbers, vault crypto, and TOTP", async () => {
  const nums = await Promise.all(
    Array.from({ length: 50 }, async () => {
      return withCompany(sql, companyB, async (tx) => {
        const d = await createDraft(tx, "u1", sampleDoc);
        return (await issueDocument(tx, "u1", d.id)).number!;
      });
    }),
  );
  expect(new Set(nums).size).toBe(50);
  expect(nums[0]).toBe("INV-2026-0001");
  expect(nums[49]).toBe("INV-2026-0050");

  const secret = crypto.getRandomValues(new Uint8Array(20));
  const enc = await encryptSecret("totp:u1", secret);
  const dec = await decryptSecret("totp:u1", enc);
  expect(dec).toEqual(secret);
  const code = await totp(secret, 1_792_000_000_000);
  expect(await verifyTotp(secret, code, 1_792_000_000_000)).not.toBeNull();
  expect(can("accountant", "write")).toBe(true);
  expect(can("viewer", "write")).toBe(false);
});

test("bidirectional HLC delta sync converges across cloud and edge sites without number collisions", async () => {
  const cloud = await testDb();
  const edge = await testDb();
  try {
    await cloud.sql`INSERT INTO app_user (id, email, name) VALUES ('u1', 'a@b.c', 'A')`;
    await edge.sql`INSERT INTO app_user (id, email, name) VALUES ('u1', 'a@b.c', 'A')`;
    const cid = "11111111-1111-4111-8111-111111111111";

    await withCompany(edge.sql, cid, async (tx) => {
      await setSite(tx, "paris-1");
      await createCustomer(tx, "u1", { name: "Paris Client", address: "1 Rue Rivoli" });
      await createProduct(tx, "u1", { description: "Audit", unitPriceExclVatCents: 10000, vat: 200 });
      const d = await createDraft(tx, "u1", sampleDoc);
      const issued = await issueDocument(tx, "u1", d.id);
      expect(issued.number).toBe("INV-paris-1-2026-0001");
    });

    await withCompany(cloud.sql, cid, async (tx) => {
      await setSite(tx, "cloud");
      const d = await createDraft(tx, "u1", sampleDoc);
      const issued = await issueDocument(tx, "u1", d.id);
      expect(issued.number).toBe("INV-2026-0001");
    });

    const edgeOut = await withCompany(edge.sql, cid, (tx) => pullChanges(tx, 0));
    const cloudOut = await withCompany(cloud.sql, cid, (tx) => pullChanges(tx, 0));

    const resCloud = await withCompany(cloud.sql, cid, (tx) => applyRemoteChanges(tx, "cloud", edgeOut.changes));
    const resEdge = await withCompany(edge.sql, cid, (tx) => applyRemoteChanges(tx, "paris-1", cloudOut.changes));
    expect(resCloud.applied).toBeGreaterThan(0);
    expect(resEdge.applied).toBeGreaterThan(0);

    const cloudDocs = await withCompany(
      cloud.sql,
      cid,
      (tx) => tx<{ number: string }[]>`SELECT number FROM document ORDER BY number ASC`,
    );
    const edgeDocs = await withCompany(
      edge.sql,
      cid,
      (tx) => tx<{ number: string }[]>`SELECT number FROM document ORDER BY number ASC`,
    );
    expect(cloudDocs.map((d) => d.number)).toEqual(["INV-2026-0001", "INV-paris-1-2026-0001"]);
    expect(edgeDocs.map((d) => d.number)).toEqual(["INV-2026-0001", "INV-paris-1-2026-0001"]);

    expect(compareHlc(nextHlc(null, "a", 100), nextHlc(null, "b", 100))).toBeLessThan(0);
    const diff = await withCompany(cloud.sql, cid, (tx) =>
      diffBlobManifest(tx, [{ key: "missing.pdf", sha256: "abc" }]),
    );
    expect(diff.missingLocal).toEqual(["missing.pdf"]);
  } finally {
    await cloud.drop();
    await edge.drop();
  }
});

void appendAudit;

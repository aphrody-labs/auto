// Core commercial invoicing store on unified SQLite: drafts, gapless site-scoped issuance,
// immutable artifacts, payments, reminders, subscriptions, hash-chained audit logs, and FEC export data.
import type { PaymentReceipt, SalesPiece } from "@aphrody/auto-domain/accounting";
import {
  computeTotals,
  formatDocumentNumber,
  fullCreditNote,
  ISSUED_TRANSITIONS,
  partialCreditNote,
  seriesForType,
  verifyCustomer,
  verifyDocument,
  verifyProduct,
  type Document,
  type DocumentStatus,
  type DocumentType,
  type LineItem,
  type Party,
  type VatRate,
} from "@aphrody/auto-domain";
import { t, type Locale } from "@aphrody/auto-i18n";
import { blobsOf, readSite, type Tx } from "./db";
import {
  asBytes,
  asJson,
  asNum,
  likePattern,
  nowIso,
  reqCompany,
  requireUuid,
  sha256Hex,
  StoreError,
  uid,
} from "./sqlite";
import { recordChange } from "./sync";

export interface Customer extends Party {
  id: string;
}

export interface Product {
  id: string;
  description: string;
  unitPriceExclVatCents: number;
  vat: VatRate;
  unit?: string;
}

export interface DocumentRow {
  id: string;
  companyId: string;
  type: DocumentType;
  status: DocumentStatus;
  number: string | null;
  customerId: string | null;
  data: Document;
  exclVatCents: number;
  vatCents: number;
  inclVatCents: number;
  portalToken: string | null;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawDocRow {
  id: string;
  company_id: string;
  type: DocumentType;
  status: DocumentStatus;
  number: string | null;
  customer_id: string | null;
  data: string;
  excl_vat_cents: number;
  vat_cents: number;
  incl_vat_cents: number;
  portal_token: string | null;
  issued_at: string | null;
  created_at: string;
  updated_at: string;
}

const mapDoc = (r: RawDocRow): DocumentRow => ({
  id: r.id,
  companyId: r.company_id,
  type: r.type,
  status: r.status,
  number: r.number,
  customerId: r.customer_id,
  data: asJson<Document>(r.data),
  exclVatCents: asNum(r.excl_vat_cents),
  vatCents: asNum(r.vat_cents),
  inclVatCents: asNum(r.incl_vat_cents),
  portalToken: r.portal_token,
  issuedAt: r.issued_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Audit hash chain --------------------------------------------------------------------------------

const GENESIS_HASH = "0".repeat(64);

export async function appendAudit(
  tx: Tx,
  actor: string | null,
  action: string,
  ref: string | null,
  payload: unknown = {},
): Promise<void> {
  const companyId = reqCompany(tx);
  const [prev] = await tx<{ hash: string }[]>`
    SELECT hash FROM audit_log WHERE company_id = ${companyId} ORDER BY id DESC LIMIT 1`;
  const prevHash = prev?.hash ?? GENESIS_HASH;
  const at = nowIso();
  const payloadJson = JSON.stringify(payload ?? {});
  const hash = await sha256Hex(`${prevHash}|${companyId}|${actor ?? ""}|${action}|${ref ?? ""}|${payloadJson}|${at}`);
  await tx`
    INSERT INTO audit_log (company_id, at, actor, action, ref, payload, prev_hash, hash)
    VALUES (${companyId}, ${at}, ${actor}, ${action}, ${ref}, ${payloadJson}, ${prevHash}, ${hash})`;
}

export async function verifyAuditChain(tx: Tx): Promise<{ valid: boolean; count: number; brokenAtId?: number }> {
  const companyId = reqCompany(tx);
  const rows = await tx<
    {
      id: number;
      at: string;
      actor: string | null;
      action: string;
      ref: string | null;
      payload: string;
      prev_hash: string;
      hash: string;
    }[]
  >`SELECT id, at, actor, action, ref, payload, prev_hash, hash FROM audit_log WHERE company_id = ${companyId} ORDER BY id ASC`;

  let expectedPrev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prev_hash !== expectedPrev) return { valid: false, count: rows.length, brokenAtId: r.id };
    const expectedHash = await sha256Hex(
      `${r.prev_hash}|${companyId}|${r.actor ?? ""}|${r.action}|${r.ref ?? ""}|${r.payload}|${r.at}`,
    );
    if (r.hash !== expectedHash) return { valid: false, count: rows.length, brokenAtId: r.id };
    expectedPrev = r.hash;
  }
  return { valid: true, count: rows.length };
}

// Company profile replication ---------------------------------------------------------------------

export async function upsertCompanyProfile(
  tx: Tx,
  profile: {
    id: string;
    name: string;
    siren: string;
    siret: string;
    address: string;
    vatNumber?: string | null;
    vatExempt?: boolean;
  },
): Promise<void> {
  const site = await readSite(tx);
  await tx`
    INSERT INTO company_profile (id, name, siren, siret, address, vat_number, vat_exempt, updated_at, _site)
    VALUES (${profile.id}, ${profile.name}, ${profile.siren}, ${profile.siret}, ${profile.address}, ${profile.vatNumber ?? null}, ${profile.vatExempt ? 1 : 0}, ${nowIso()}, ${site})
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      siren = excluded.siren,
      siret = excluded.siret,
      address = excluded.address,
      vat_number = excluded.vat_number,
      vat_exempt = excluded.vat_exempt,
      updated_at = excluded.updated_at`;
}

// Customers & Products ----------------------------------------------------------------------------

export async function createCustomer(
  tx: Tx,
  actor: string | null,
  input: Party,
  locale: Locale = "en",
): Promise<Customer> {
  const errors = verifyCustomer(input, locale);
  if (errors.length) throw new StoreError(t(locale, "Invalid customer"), errors, 400);
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = uid();
  const now = nowIso();
  const cols = {
    id,
    company_id: companyId,
    name: input.name.trim(),
    tax_id: input.taxId?.trim() || null,
    address: input.address.trim(),
    vat_number: input.vatNumber?.trim() || null,
    email: input.email?.trim() || null,
    created_at: now,
    updated_at: now,
    _deleted: 0,
  };
  const hlc = await recordChange(tx, "customer", id, "upsert", cols, site);
  await tx`
    INSERT INTO customer (id, company_id, name, tax_id, address, vat_number, email, created_at, updated_at, _deleted, _hlc, _site)
    VALUES (${cols.id}, ${cols.company_id}, ${cols.name}, ${cols.tax_id}, ${cols.address}, ${cols.vat_number}, ${cols.email}, ${now}, ${now}, 0, ${hlc}, ${site})`;
  await appendAudit(tx, actor, "customer.create", id, { name: cols.name });
  return {
    id,
    name: cols.name,
    address: cols.address,
    ...(cols.tax_id ? { taxId: cols.tax_id } : {}),
    ...(cols.vat_number ? { vatNumber: cols.vat_number } : {}),
    ...(cols.email ? { email: cols.email } : {}),
  };
}

export async function updateCustomer(
  tx: Tx,
  actor: string | null,
  id: string,
  input: Party,
  locale: Locale = "en",
): Promise<Customer> {
  requireUuid(id, "customerId");
  const errors = verifyCustomer(input, locale);
  if (errors.length) throw new StoreError(t(locale, "Invalid customer"), errors, 400);
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const now = nowIso();
  const hlc = await recordChange(
    tx,
    "customer",
    id,
    "upsert",
    {
      name: input.name.trim(),
      tax_id: input.taxId?.trim() || null,
      address: input.address.trim(),
      vat_number: input.vatNumber?.trim() || null,
      email: input.email?.trim() || null,
      updated_at: now,
    },
    site,
  );
  const rows = await tx<{ id: string }[]>`
    UPDATE customer SET name = ${input.name.trim()}, tax_id = ${input.taxId?.trim() || null}, address = ${input.address.trim()},
      vat_number = ${input.vatNumber?.trim() || null}, email = ${input.email?.trim() || null}, updated_at = ${now}, _hlc = ${hlc}, _site = ${site}
    WHERE id = ${id} AND company_id = ${companyId} AND _deleted = 0 RETURNING id`;
  if (!rows.length) throw new StoreError(t(locale, "Customer not found"), [], 404);
  await appendAudit(tx, actor, "customer.update", id, { name: input.name.trim() });
  return (await getCustomer(tx, id))!;
}

export async function getCustomer(tx: Tx, id: string): Promise<Customer | null> {
  const companyId = reqCompany(tx);
  const [r] = await tx<
    {
      id: string;
      name: string;
      tax_id: string | null;
      address: string;
      vat_number: string | null;
      email: string | null;
    }[]
  >`SELECT id, name, tax_id, address, vat_number, email FROM customer WHERE id = ${id} AND company_id = ${companyId} AND _deleted = 0`;
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    ...(r.tax_id ? { taxId: r.tax_id } : {}),
    ...(r.vat_number ? { vatNumber: r.vat_number } : {}),
    ...(r.email ? { email: r.email } : {}),
  };
}

export async function listCustomers(tx: Tx, search?: string): Promise<Customer[]> {
  const companyId = reqCompany(tx);
  const pat = search ? likePattern(search) : null;
  const rows = pat
    ? await tx<
        {
          id: string;
          name: string;
          tax_id: string | null;
          address: string;
          vat_number: string | null;
          email: string | null;
        }[]
      >`
        SELECT id, name, tax_id, address, vat_number, email FROM customer
        WHERE company_id = ${companyId} AND _deleted = 0 AND (lower(name) LIKE ${pat} ESCAPE '\\' OR tax_id LIKE ${`${search}%`})
        ORDER BY name ASC LIMIT 200`
    : await tx<
        {
          id: string;
          name: string;
          tax_id: string | null;
          address: string;
          vat_number: string | null;
          email: string | null;
        }[]
      >`SELECT id, name, tax_id, address, vat_number, email FROM customer WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY name ASC LIMIT 500`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    ...(r.tax_id ? { taxId: r.tax_id } : {}),
    ...(r.vat_number ? { vatNumber: r.vat_number } : {}),
    ...(r.email ? { email: r.email } : {}),
  }));
}

export async function createProduct(
  tx: Tx,
  actor: string | null,
  input: Omit<Product, "id">,
  locale: Locale = "en",
): Promise<Product> {
  const errors = verifyProduct(input, locale);
  if (errors.length) throw new StoreError(t(locale, "Invalid product"), errors, 400);
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = uid();
  const now = nowIso();
  const cols = {
    id,
    company_id: companyId,
    description: input.description.trim(),
    unit_price_excl_vat_cents: input.unitPriceExclVatCents,
    vat: input.vat,
    unit: input.unit?.trim() || null,
    updated_at: now,
    _deleted: 0,
  };
  const hlc = await recordChange(tx, "product", id, "upsert", cols, site);
  await tx`
    INSERT INTO product (id, company_id, description, unit_price_excl_vat_cents, vat, unit, updated_at, _deleted, _hlc, _site)
    VALUES (${id}, ${companyId}, ${cols.description}, ${cols.unit_price_excl_vat_cents}, ${cols.vat}, ${cols.unit}, ${now}, 0, ${hlc}, ${site})`;
  await appendAudit(tx, actor, "product.create", id, { description: cols.description });
  return {
    id,
    description: cols.description,
    unitPriceExclVatCents: cols.unit_price_excl_vat_cents,
    vat: cols.vat as VatRate,
    ...(cols.unit ? { unit: cols.unit } : {}),
  };
}

export async function listProducts(tx: Tx): Promise<Product[]> {
  const companyId = reqCompany(tx);
  const rows = await tx<
    {
      id: string;
      description: string;
      unit_price_excl_vat_cents: number;
      vat: VatRate;
      unit: string | null;
    }[]
  >`SELECT id, description, unit_price_excl_vat_cents, vat, unit FROM product WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY description ASC LIMIT 500`;
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    unitPriceExclVatCents: asNum(r.unit_price_excl_vat_cents),
    vat: r.vat,
    ...(r.unit ? { unit: r.unit } : {}),
  }));
}

// Drafts, Issuance & Lifecycle --------------------------------------------------------------------

export async function createDraft(
  tx: Tx,
  actor: string | null,
  doc: Document,
  customerId: string | null = null,
): Promise<DocumentRow> {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = uid();
  const clean: Document = { ...doc, number: undefined };
  const tRes = computeTotals(clean.lines);
  const now = nowIso();
  const portalToken = crypto.randomUUID().replaceAll("-", "");
  const cols = {
    id,
    company_id: companyId,
    type: clean.type,
    status: "draft",
    number: null,
    customer_id: customerId,
    data: JSON.stringify(clean),
    excl_vat_cents: tRes.totalExclVatCents,
    vat_cents: tRes.totalVatCents,
    incl_vat_cents: tRes.totalInclVatCents,
    portal_token: portalToken,
    issued_at: null,
    created_at: now,
    updated_at: now,
    _deleted: 0,
  };
  const hlc = await recordChange(tx, "document", id, "upsert", cols, site);
  await tx`
    INSERT INTO document (id, company_id, type, status, number, customer_id, data, excl_vat_cents, vat_cents, incl_vat_cents, portal_token, created_at, updated_at, _deleted, _hlc, _site)
    VALUES (${id}, ${companyId}, ${clean.type}, ${"draft"}, ${null}, ${customerId}, ${cols.data}, ${tRes.totalExclVatCents}, ${tRes.totalVatCents}, ${tRes.totalInclVatCents}, ${portalToken}, ${now}, ${now}, 0, ${hlc}, ${site})`;
  await appendAudit(tx, actor, "document.create_draft", id, { type: clean.type, inclVatCents: tRes.totalInclVatCents });
  return (await getDocument(tx, id))!;
}

export async function updateDraft(
  tx: Tx,
  actor: string | null,
  id: string,
  doc: Document,
  customerId: string | null = null,
  locale: Locale = "en",
): Promise<DocumentRow> {
  requireUuid(id, "documentId");
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const clean: Document = { ...doc, number: undefined };
  const tRes = computeTotals(clean.lines);
  const now = nowIso();
  const dataStr = JSON.stringify(clean);
  const hlc = await recordChange(
    tx,
    "document",
    id,
    "upsert",
    {
      type: clean.type,
      customer_id: customerId,
      data: dataStr,
      excl_vat_cents: tRes.totalExclVatCents,
      vat_cents: tRes.totalVatCents,
      incl_vat_cents: tRes.totalInclVatCents,
      updated_at: now,
    },
    site,
  );
  const updated = await tx<{ id: string }[]>`
    UPDATE document SET type = ${clean.type}, customer_id = ${customerId}, data = ${dataStr},
      excl_vat_cents = ${tRes.totalExclVatCents}, vat_cents = ${tRes.totalVatCents}, incl_vat_cents = ${tRes.totalInclVatCents},
      updated_at = ${now}, _hlc = ${hlc}, _site = ${site}
    WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft' AND _deleted = 0 RETURNING id`;
  if (!updated.length) {
    throw new StoreError(t(locale, "Draft document not found"), [], 404);
  }
  await appendAudit(tx, actor, "document.update_draft", id, { inclVatCents: tRes.totalInclVatCents });
  return (await getDocument(tx, id))!;
}

export async function getDocument(tx: Tx, id: string): Promise<DocumentRow | null> {
  const companyId = reqCompany(tx);
  const [row] = await tx<RawDocRow[]>`
    SELECT id, company_id, type, status, number, customer_id, data, excl_vat_cents, vat_cents, incl_vat_cents, portal_token, issued_at, created_at, updated_at
    FROM document WHERE id = ${id} AND company_id = ${companyId} AND _deleted = 0`;
  return row ? mapDoc(row) : null;
}

export async function getDocumentByPortalToken(tx: Tx, token: string): Promise<DocumentRow | null> {
  const [row] = await tx<RawDocRow[]>`
    SELECT id, company_id, type, status, number, customer_id, data, excl_vat_cents, vat_cents, incl_vat_cents, portal_token, issued_at, created_at, updated_at
    FROM document WHERE portal_token = ${token} AND status <> 'draft' AND _deleted = 0`;
  return row ? mapDoc(row) : null;
}

export async function listDocuments(
  tx: Tx,
  filter?: { type?: DocumentType; status?: DocumentStatus; customerId?: string },
): Promise<DocumentRow[]> {
  const companyId = reqCompany(tx);
  const rows = await tx<RawDocRow[]>`
    SELECT id, company_id, type, status, number, customer_id, data, excl_vat_cents, vat_cents, incl_vat_cents, portal_token, issued_at, created_at, updated_at
    FROM document WHERE company_id = ${companyId} AND _deleted = 0
      AND (${filter?.type ?? null} IS NULL OR type = ${filter?.type ?? null})
      AND (${filter?.status ?? null} IS NULL OR status = ${filter?.status ?? null})
      AND (${filter?.customerId ?? null} IS NULL OR customer_id = ${filter?.customerId ?? null})
    ORDER BY created_at DESC LIMIT 500`;
  return rows.map(mapDoc);
}

export async function issueDocument(
  tx: Tx,
  actor: string | null,
  id: string,
  locale: Locale = "en",
): Promise<DocumentRow> {
  requireUuid(id, "documentId");
  const existing = await getDocument(tx, id);
  if (!existing) throw new StoreError(t(locale, "Document not found"), [], 404);
  if (existing.status !== "draft") {
    throw new StoreError(t(locale, "Document already issued"), [], 409);
  }
  const errors = verifyDocument(existing.data, existing.data.locale ?? locale);
  if (errors.length) {
    throw new StoreError(t(locale, "Missing mandatory fields"), errors, 422);
  }
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const year = Number(existing.data.date.slice(0, 4)) || new Date().getUTCFullYear();
  const baseSeries = seriesForType(existing.type);
  const series = site === "cloud" ? baseSeries : `${baseSeries}-${site}`;

  const [seqRow] = await tx<{ seq: number }[]>`
    INSERT INTO counter (company_id, series, year, seq) VALUES (${companyId}, ${series}, ${year}, 1)
    ON CONFLICT (company_id, series, year) DO UPDATE SET seq = seq + 1
    RETURNING seq`;
  const seq = asNum(seqRow!.seq);
  const number = formatDocumentNumber(existing.type, year, seq, site);
  const issuedDoc: Document = { ...existing.data, number };
  const issuedAt = nowIso();
  const dataStr = JSON.stringify(issuedDoc);

  const hlc = await recordChange(
    tx,
    "document",
    id,
    "upsert",
    {
      id,
      company_id: companyId,
      type: existing.type,
      status: "issued",
      number,
      series,
      year,
      seq,
      customer_id: existing.customerId,
      data: dataStr,
      excl_vat_cents: existing.exclVatCents,
      vat_cents: existing.vatCents,
      incl_vat_cents: existing.inclVatCents,
      portal_token: existing.portalToken,
      issued_at: issuedAt,
      created_at: existing.createdAt,
      updated_at: issuedAt,
      _deleted: 0,
    },
    site,
  );

  await tx`
    UPDATE document SET status = ${"issued"}, number = ${number}, series = ${series}, year = ${year}, seq = ${seq},
      data = ${dataStr}, issued_at = ${issuedAt}, updated_at = ${issuedAt}, _hlc = ${hlc}, _site = ${site}
    WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft'`;

  await appendAudit(tx, actor, "document.issue", id, { number, inclVatCents: existing.inclVatCents });
  return (await getDocument(tx, id))!;
}

export async function transitionDocumentStatus(
  tx: Tx,
  actor: string | null,
  id: string,
  nextStatus: DocumentStatus,
  locale: Locale = "en",
): Promise<DocumentRow> {
  const existing = await getDocument(tx, id);
  if (!existing) throw new StoreError(t(locale, "Document not found"), [], 404);
  const allowed = ISSUED_TRANSITIONS[existing.type]?.[existing.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new StoreError(
      t(locale, "Transition from {from} to {to} is not allowed", { from: existing.status, to: nextStatus }),
      [],
      409,
    );
  }
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const now = nowIso();
  const hlc = await recordChange(tx, "document", id, "upsert", { status: nextStatus, updated_at: now }, site);
  await tx`UPDATE document SET status = ${nextStatus}, updated_at = ${now}, _hlc = ${hlc}, _site = ${site} WHERE id = ${id} AND company_id = ${companyId}`;
  await appendAudit(tx, actor, "document.status", id, { from: existing.status, to: nextStatus });
  return (await getDocument(tx, id))!;
}

export async function createCreditNoteFromInvoice(
  tx: Tx,
  actor: string | null,
  invoiceId: string,
  date: string,
  lines?: LineItem[],
  locale: Locale = "en",
): Promise<DocumentRow> {
  const inv = await getDocument(tx, invoiceId);
  if (!inv || inv.status === "draft" || !inv.number) {
    throw new StoreError(t(locale, "Issued invoice not found"), [], 404);
  }
  const draftDoc = lines?.length
    ? partialCreditNote(inv.data, inv.number, date, lines)
    : fullCreditNote(inv.data, inv.number, date);
  const created = await createDraft(tx, actor, draftDoc, inv.customerId);
  return issueDocument(tx, actor, created.id, locale);
}

// Artifacts, Payments & Reminders -----------------------------------------------------------------

export async function storeArtifact(
  tx: Tx,
  documentId: string,
  kind: "facturx" | "pdf",
  bytes: Uint8Array,
): Promise<{ sha256: string; size: number }> {
  const companyId = reqCompany(tx);
  const sha = await sha256Hex(bytes);
  const blobKey = `${companyId}/artifacts/${documentId}/${kind}-${sha.slice(0, 12)}.pdf`;
  const blobs = blobsOf(tx);
  if (blobs) {
    await blobs.put(blobKey, bytes, {
      contentType: "application/pdf",
      cacheControl: "public, max-age=31536000, immutable",
    });
  }
  await tx`
    INSERT INTO artifact (id, company_id, document_id, kind, sha256, size, content, blob_key)
    VALUES (${uid()}, ${companyId}, ${documentId}, ${kind}, ${sha}, ${bytes.byteLength}, ${blobs ? null : bytes}, ${blobs ? blobKey : null})
    ON CONFLICT (document_id, kind) DO NOTHING`;
  return { sha256: sha, size: bytes.byteLength };
}

export async function getArtifact(
  tx: Tx,
  documentId: string,
  kind: "facturx" | "pdf",
): Promise<{ sha256: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const companyId = reqCompany(tx);
  const [row] = await tx<{ sha256: string; content: unknown; blob_key: string | null }[]>`
    SELECT sha256, content, blob_key FROM artifact WHERE company_id = ${companyId} AND document_id = ${documentId} AND kind = ${kind}`;
  if (!row) return null;
  if (row.blob_key) {
    const blobs = blobsOf(tx);
    const obj = blobs ? await blobs.get(row.blob_key) : null;
    if (obj) return { sha256: row.sha256, bytes: new Uint8Array(await obj.bytes()) };
  }
  return { sha256: row.sha256, bytes: asBytes(row.content) };
}

export type PaymentMethod = "transfer" | "card" | "check" | "cash" | "direct_debit" | "other";

export async function recordPayment(
  tx: Tx,
  actor: string | null,
  input: { documentId: string; date: string; amountCents: number; method: PaymentMethod; reference?: string },
  locale: Locale = "en",
) {
  const companyId = reqCompany(tx);
  const doc = await getDocument(tx, input.documentId);
  if (!doc || doc.status === "draft") throw new StoreError(t(locale, "Issued invoice not found"), [], 404);
  if (input.amountCents <= 0) throw new StoreError(t(locale, "Payment amount must be positive"), [], 400);
  const id = uid();
  await tx`
    INSERT INTO payment (id, company_id, document_id, date, amount_cents, method, reference)
    VALUES (${id}, ${companyId}, ${input.documentId}, ${input.date}, ${input.amountCents}, ${input.method}, ${input.reference ?? null})`;
  await appendAudit(tx, actor, "payment.record", id, { documentId: input.documentId, amountCents: input.amountCents });

  const [sumRow] = await tx<{ paid: number }[]>`
    SELECT coalesce(sum(amount_cents), 0) AS paid FROM payment WHERE company_id = ${companyId} AND document_id = ${input.documentId}`;
  if (asNum(sumRow?.paid) >= doc.inclVatCents && doc.status !== "paid") {
    await transitionDocumentStatus(tx, actor, doc.id, "paid", locale);
  }
  return { id, ...input, totalPaidCents: asNum(sumRow?.paid) };
}

export async function listPayments(tx: Tx, documentId?: string) {
  const companyId = reqCompany(tx);
  return tx<
    {
      id: string;
      document_id: string;
      date: string;
      amount_cents: number;
      method: PaymentMethod;
      reference: string | null;
      created_at: string;
    }[]
  >`
    SELECT id, document_id, date, amount_cents, method, reference, created_at FROM payment
    WHERE company_id = ${companyId} AND (${documentId ?? null} IS NULL OR document_id = ${documentId ?? null})
    ORDER BY date DESC, created_at DESC`;
}

export async function recordReminder(
  tx: Tx,
  actor: string | null,
  documentId: string,
  level: 1 | 2 | 3,
  channel: "email" | "postal" | "phone",
): Promise<void> {
  const companyId = reqCompany(tx);
  await tx`
    INSERT INTO reminder (id, company_id, document_id, level, channel)
    VALUES (${uid()}, ${companyId}, ${documentId}, ${level}, ${channel})
    ON CONFLICT (document_id, level) DO NOTHING`;
  await appendAudit(tx, actor, "reminder.send", documentId, { level, channel });
}

export async function listOverdueDocuments(tx: Tx, asOfIso: string): Promise<DocumentRow[]> {
  const companyId = reqCompany(tx);
  const rows = await tx<RawDocRow[]>`
    SELECT id, company_id, type, status, number, customer_id, data, excl_vat_cents, vat_cents, incl_vat_cents, portal_token, issued_at, created_at, updated_at
    FROM document WHERE company_id = ${companyId} AND _deleted = 0
      AND type IN ('invoice', 'deposit') AND status IN ('issued', 'sent', 'submitted')
      AND json_extract(data, '$.dueDate') < ${asOfIso.slice(0, 10)}
    ORDER BY issued_at ASC`;
  return rows.map(mapDoc);
}

// Subscriptions -----------------------------------------------------------------------------------

export async function createSubscription(
  tx: Tx,
  actor: string | null,
  input: {
    customerId: string;
    title: string;
    lines: LineItem[];
    interval: "monthly" | "quarterly" | "annual";
    nextRunAt: string;
    autoIssue?: boolean;
  },
) {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = uid();
  const hlc = await recordChange(tx, "subscription_schedule", id, "upsert", { ...input, active: 1 }, site);
  await tx`
    INSERT INTO subscription_schedule (id, company_id, customer_id, title, lines_json, interval, next_run_at, auto_issue, active, _hlc, _site)
    VALUES (${id}, ${companyId}, ${input.customerId}, ${input.title}, ${JSON.stringify(input.lines)}, ${input.interval}, ${input.nextRunAt}, ${input.autoIssue ? 1 : 0}, 1, ${hlc}, ${site})`;
  await appendAudit(tx, actor, "subscription.create", id, { title: input.title });
  return { id, ...input, active: true };
}

export async function listDueSubscriptions(tx: Tx, asOfDate: string) {
  const companyId = reqCompany(tx);
  return tx<
    {
      id: string;
      customer_id: string;
      title: string;
      lines_json: string;
      interval: "monthly" | "quarterly" | "annual";
      next_run_at: string;
      auto_issue: number;
    }[]
  >`SELECT id, customer_id, title, lines_json, interval, next_run_at, auto_issue FROM subscription_schedule
    WHERE company_id = ${companyId} AND active = 1 AND _deleted = 0 AND next_run_at <= ${asOfDate}`;
}

// Spreadsheet import & Accounting export queries --------------------------------------------------

export type CellValue = string | number | boolean | null;

const FIELD_SYNONYMS: Record<string, string[]> = {
  name: ["name", "company", "customer", "nom", "raison sociale", "client", "societe"],
  taxId: ["taxid", "tax id", "siret", "siren", "registration"],
  address: ["address", "adresse", "street", "rue"],
  vatNumber: ["vat", "vat number", "tva", "tva intracom"],
  email: ["email", "mail", "courriel"],
  description: ["description", "product", "service", "designation", "libelle"],
  unitPriceExclVatCents: ["price", "unit price", "prix ht", "pu ht"],
  vat: ["vat rate", "tax rate", "tva", "taux tva"],
  unit: ["unit", "unite", "u"],
};

const normHeader = (v: unknown) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function suggestImportMapping<F extends string>(
  headers: CellValue[],
  fields: readonly F[],
): Partial<Record<F, number>> {
  const normalized = headers.map(normHeader);
  const used = new Set<number>();
  const mapping: Partial<Record<F, number>> = {};
  for (const field of fields) {
    const syns = FIELD_SYNONYMS[field] ?? [field.toLowerCase()];
    const idx = normalized.findIndex((h, i) => !used.has(i) && syns.includes(h));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

export async function exportAccountingData(
  tx: Tx,
  startDate: string,
  endDate: string,
): Promise<{ sales: SalesPiece[]; receipts: PaymentReceipt[] }> {
  const companyId = reqCompany(tx);
  const docs = await tx<RawDocRow[]>`
    SELECT id, company_id, type, status, number, customer_id, data, excl_vat_cents, vat_cents, incl_vat_cents, portal_token, issued_at, created_at, updated_at
    FROM document WHERE company_id = ${companyId} AND status <> 'draft' AND type <> 'quote'
      AND json_extract(data, '$.date') BETWEEN ${startDate} AND ${endDate} AND _deleted = 0
    ORDER BY number ASC`;

  const sales: SalesPiece[] = docs.map((r) => {
    const doc = asJson<Document>(r.data);
    return {
      type: r.type,
      number: r.number ?? "",
      date: doc.date,
      customer: { name: doc.customer.name, taxId: doc.customer.taxId },
      totals: computeTotals(doc.lines),
    };
  });

  const payRows = await tx<
    {
      id: string;
      date: string;
      amount_cents: number;
      number: string | null;
      data: string;
    }[]
  >`
    SELECT p.id, p.date, p.amount_cents, d.number, d.data FROM payment p
    JOIN document d ON d.id = p.document_id AND d.company_id = p.company_id
    WHERE p.company_id = ${companyId} AND p.date BETWEEN ${startDate} AND ${endDate}
    ORDER BY p.date ASC`;

  const receipts: PaymentReceipt[] = payRows.map((p) => {
    const d = asJson<Document>(p.data);
    return {
      number: p.id.slice(0, 8),
      date: p.date,
      invoiceNumber: p.number ?? "",
      customer: { name: d.customer.name, taxId: d.customer.taxId },
      amountCents: asNum(p.amount_cents),
    };
  });

  return { sales, receipts };
}

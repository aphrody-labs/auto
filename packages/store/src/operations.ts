// Extended workspace store: suppliers, projects & profitability analytics, HR, studio, inbox, search,
// mailbox, automations, knowledge RAG, einvoicing submissions, webhooks/outbox, and templates.
import {
  accruedLeaveDays,
  verifyEmployee,
  workingDays,
  type AbsenceStatus,
  type AbsenceType,
  type Employee as DomainEmployee,
} from "@aphrody/auto-domain/hr";
import { t, type Locale } from "@aphrody/auto-i18n";
import { blobsOf, readSite, type Tx } from "./db";
import { appendAudit } from "./invoicing";
import { asBool, asBytes, asJson, asNum, likePattern, nowIso, reqCompany, sha256Hex, StoreError, uid } from "./sqlite";
import { recordChange } from "./sync";

export interface Supplier {
  id: string;
  name: string;
  address: string;
  taxId: string;
  vatNumber?: string;
  email: string;
  phone: string;
  contact: string;
  notes: string;
  archived: boolean;
}

export interface Project {
  id: string;
  name: string;
  code: string;
  customerId?: string | null;
  address: string;
  budgetExclVatCents: number;
  progress: number;
  status: "planned" | "active" | "completed" | "paused";
  startDate?: string | null;
  endDate?: string | null;
  notes: string;
  archived: boolean;
}

export async function saveSupplier(
  tx: Tx,
  actor: string | null,
  input: Omit<Supplier, "id" | "archived"> & { id?: string; archived?: boolean },
): Promise<Supplier> {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = input.id ?? uid();
  const now = nowIso();
  const hlc = await recordChange(
    tx,
    "supplier",
    id,
    "upsert",
    { ...input, id, company_id: companyId, updated_at: now },
    site,
  );
  await tx`
    INSERT INTO supplier (id, company_id, name, address, tax_id, vat_number, email, phone, contact, notes, archived, created_at, updated_at, _hlc, _site)
    VALUES (${id}, ${companyId}, ${input.name.trim()}, ${input.address}, ${input.taxId}, ${input.vatNumber ?? null}, ${input.email}, ${input.phone}, ${input.contact}, ${input.notes}, ${input.archived ? 1 : 0}, ${now}, ${now}, ${hlc}, ${site})
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, address = excluded.address, tax_id = excluded.tax_id, vat_number = excluded.vat_number,
      email = excluded.email, phone = excluded.phone, contact = excluded.contact, notes = excluded.notes,
      archived = excluded.archived, updated_at = excluded.updated_at, _hlc = excluded._hlc, _site = excluded._site`;
  await appendAudit(tx, actor, input.id ? "supplier.update" : "supplier.create", id, { name: input.name });
  return {
    id,
    name: input.name.trim(),
    address: input.address,
    taxId: input.taxId,
    vatNumber: input.vatNumber,
    email: input.email,
    phone: input.phone,
    contact: input.contact,
    notes: input.notes,
    archived: Boolean(input.archived),
  };
}

export async function listSuppliers(tx: Tx): Promise<Supplier[]> {
  const companyId = reqCompany(tx);
  const rows = await tx<
    {
      id: string;
      name: string;
      address: string;
      tax_id: string;
      vat_number: string | null;
      email: string;
      phone: string;
      contact: string;
      notes: string;
      archived: number;
    }[]
  >`SELECT id, name, address, tax_id, vat_number, email, phone, contact, notes, archived FROM supplier WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY name ASC`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    taxId: r.tax_id,
    vatNumber: r.vat_number ?? undefined,
    email: r.email,
    phone: r.phone,
    contact: r.contact,
    notes: r.notes,
    archived: asBool(r.archived),
  }));
}

export async function saveProject(
  tx: Tx,
  actor: string | null,
  input: Omit<Project, "id" | "archived"> & { id?: string; archived?: boolean },
): Promise<Project> {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = input.id ?? uid();
  const now = nowIso();
  const hlc = await recordChange(
    tx,
    "project",
    id,
    "upsert",
    { ...input, id, company_id: companyId, updated_at: now },
    site,
  );
  await tx`
    INSERT INTO project (id, company_id, name, code, customer_id, address, budget_excl_vat_cents, progress, status, start_date, end_date, notes, archived, created_at, updated_at, _hlc, _site)
    VALUES (${id}, ${companyId}, ${input.name.trim()}, ${input.code}, ${input.customerId ?? null}, ${input.address}, ${input.budgetExclVatCents}, ${input.progress}, ${input.status}, ${input.startDate ?? null}, ${input.endDate ?? null}, ${input.notes}, ${input.archived ? 1 : 0}, ${now}, ${now}, ${hlc}, ${site})
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, code = excluded.code, customer_id = excluded.customer_id, address = excluded.address,
      budget_excl_vat_cents = excluded.budget_excl_vat_cents, progress = excluded.progress, status = excluded.status,
      start_date = excluded.start_date, end_date = excluded.end_date, notes = excluded.notes, archived = excluded.archived,
      updated_at = excluded.updated_at, _hlc = excluded._hlc, _site = excluded._site`;
  await appendAudit(tx, actor, input.id ? "project.update" : "project.create", id, { name: input.name });
  return { id, ...input, archived: Boolean(input.archived) };
}

export async function listProjects(tx: Tx): Promise<Project[]> {
  const companyId = reqCompany(tx);
  const rows = await tx<
    {
      id: string;
      name: string;
      code: string;
      customer_id: string | null;
      address: string;
      budget_excl_vat_cents: number;
      progress: number;
      status: Project["status"];
      start_date: string | null;
      end_date: string | null;
      notes: string;
      archived: number;
    }[]
  >`SELECT id, name, code, customer_id, address, budget_excl_vat_cents, progress, status, start_date, end_date, notes, archived FROM project WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY created_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    customerId: r.customer_id,
    address: r.address,
    budgetExclVatCents: asNum(r.budget_excl_vat_cents),
    progress: asNum(r.progress),
    status: r.status,
    startDate: r.start_date,
    endDate: r.end_date,
    notes: r.notes,
    archived: asBool(r.archived),
  }));
}

export async function linkDocumentToProject(tx: Tx, projectId: string, documentId: string): Promise<void> {
  const companyId = reqCompany(tx);
  await tx`
    INSERT INTO project_document (company_id, project_id, document_id)
    VALUES (${companyId}, ${projectId}, ${documentId}) ON CONFLICT DO NOTHING`;
}

export async function getProjectFolder(tx: Tx, projectId: string, locale: Locale = "en") {
  const companyId = reqCompany(tx);
  const [proj] = (await listProjects(tx)).filter((p) => p.id === projectId);
  if (!proj) throw new StoreError(t(locale, "Project not found"), [], 404);
  const salesRows = await tx<{ excl_vat_cents: number; type: string; status: string }[]>`
    SELECT d.excl_vat_cents, d.type, d.status FROM document d
    JOIN project_document pd ON pd.company_id = d.company_id AND pd.document_id = d.id
    WHERE d.company_id = ${companyId} AND pd.project_id = ${projectId} AND d.status <> 'draft' AND d.type <> 'quote' AND d._deleted = 0`;
  const purchaseRows = await tx<{ total_excl_vat_cents: number }[]>`
    SELECT total_excl_vat_cents FROM received_invoice
    WHERE company_id = ${companyId} AND project_id = ${projectId} AND status = 'validated' AND _deleted = 0`;
  const salesExclVatCents = salesRows.reduce(
    (s, r) => s + (r.type === "credit_note" ? -asNum(r.excl_vat_cents) : asNum(r.excl_vat_cents)),
    0,
  );
  const expensesExclVatCents = purchaseRows.reduce((s, r) => s + asNum(r.total_excl_vat_cents), 0);
  return {
    project: proj,
    analytics: {
      salesExclVatCents,
      expensesExclVatCents,
      marginExclVatCents: salesExclVatCents - expensesExclVatCents,
    },
  };
}

// Blobs / Inbox / File Sources / Unified Search ---------------------------------------------------

export async function storeBlobFile(
  tx: Tx,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<{ id: string; sha256: string; blobKey: string }> {
  const companyId = reqCompany(tx);
  const sha = await sha256Hex(bytes);
  const blobKey = `${companyId}/blobs/${sha}`;
  const blobs = blobsOf(tx);
  if (blobs) await blobs.put(blobKey, bytes, { contentType: mimeType });
  const id = uid();
  await tx`
    INSERT INTO stored_file (id, company_id, name, mime_type, sha256, size, blob_key)
    VALUES (${id}, ${companyId}, ${name}, ${mimeType}, ${sha}, ${bytes.byteLength}, ${blobKey})
    ON CONFLICT (company_id, sha256) DO NOTHING`;
  const [existing] = await tx<{ id: string; blob_key: string }[]>`
    SELECT id, blob_key FROM stored_file WHERE company_id = ${companyId} AND sha256 = ${sha}`;
  return { id: existing?.id ?? id, sha256: sha, blobKey: existing?.blob_key ?? blobKey };
}

export async function readBlobFile(
  tx: Tx,
  fileId: string,
): Promise<{ name: string; mimeType: string; bytes: Uint8Array<ArrayBuffer>; sha256: string } | null> {
  const companyId = reqCompany(tx);
  const [row] = await tx<{ name: string; mime_type: string; blob_key: string; sha256: string }[]>`
    SELECT name, mime_type, blob_key, sha256 FROM stored_file WHERE id = ${fileId} AND company_id = ${companyId}`;
  if (!row) return null;
  const blobs = blobsOf(tx);
  const obj = blobs ? await blobs.get(row.blob_key) : null;
  if (!obj) return null;
  return { name: row.name, mimeType: row.mime_type, sha256: row.sha256, bytes: new Uint8Array(await obj.bytes()) };
}

export async function saveReceivedInvoice(
  tx: Tx,
  actor: string | null,
  input: {
    id?: string;
    number?: string;
    supplierName?: string;
    date?: string;
    status?: "review" | "validated" | "rejected";
    totalExclVatCents?: number;
    totalVatCents?: number;
    totalInclVatCents?: number;
    currency?: string;
    data?: unknown;
    supplierId?: string | null;
    projectId?: string | null;
    blobKey?: string | null;
    sha256?: string | null;
  },
) {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = input.id ?? uid();
  const now = nowIso();
  await tx`
    INSERT INTO received_invoice (id, company_id, number, supplier_name, date, status, total_excl_vat_cents, total_vat_cents, total_incl_vat_cents, currency, data_json, blob_key, sha256, supplier_id, project_id, created_at, updated_at, _site)
    VALUES (${id}, ${companyId}, ${input.number ?? ""}, ${input.supplierName ?? ""}, ${input.date ?? ""}, ${input.status ?? "review"}, ${input.totalExclVatCents ?? 0}, ${input.totalVatCents ?? 0}, ${input.totalInclVatCents ?? 0}, ${input.currency ?? "EUR"}, ${JSON.stringify(input.data ?? {})}, ${input.blobKey ?? null}, ${input.sha256 ?? null}, ${input.supplierId ?? null}, ${input.projectId ?? null}, ${now}, ${now}, ${site})
    ON CONFLICT (id) DO UPDATE SET
      number = excluded.number, supplier_name = excluded.supplier_name, date = excluded.date, status = excluded.status,
      total_excl_vat_cents = excluded.total_excl_vat_cents, total_vat_cents = excluded.total_vat_cents, total_incl_vat_cents = excluded.total_incl_vat_cents,
      data_json = excluded.data_json, supplier_id = excluded.supplier_id, project_id = excluded.project_id, updated_at = excluded.updated_at`;
  await appendAudit(tx, actor, "inbox.save_invoice", id, { number: input.number });
  return id;
}

export async function listReceivedInvoices(tx: Tx) {
  const companyId = reqCompany(tx);
  return tx<
    {
      id: string;
      number: string;
      supplier_name: string;
      date: string;
      status: string;
      total_excl_vat_cents: number;
      total_vat_cents: number;
      total_incl_vat_cents: number;
      currency: string;
      project_id: string | null;
      supplier_id: string | null;
    }[]
  >`SELECT id, number, supplier_name, date, status, total_excl_vat_cents, total_vat_cents, total_incl_vat_cents, currency, project_id, supplier_id FROM received_invoice WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY created_at DESC LIMIT 200`;
}

export async function searchWorkspace(tx: Tx, query: string, locale: Locale = "en") {
  const clean = query.trim();
  if (clean.length < 2 || clean.length > 200) {
    throw new StoreError(t(locale, "Search query must be 2 to 200 characters"), [], 400);
  }
  const companyId = reqCompany(tx);
  const pat = likePattern(clean);
  const rows = await tx<{ id: string; segment: string; reference: string; label: string; url: string }[]>`
    SELECT id, type AS segment, coalesce(number, 'Draft') AS reference, json_extract(data, '$.customer.name') AS label, '/app/documents/' || id AS url
    FROM document WHERE company_id = ${companyId} AND _deleted = 0 AND (lower(coalesce(number, '')) LIKE ${pat} ESCAPE '\\' OR lower(data) LIKE ${pat} ESCAPE '\\')
    UNION ALL
    SELECT id, 'received_invoice', coalesce(number, 'Pending'), supplier_name, '/app/inbox/' || id
    FROM received_invoice WHERE company_id = ${companyId} AND _deleted = 0 AND (lower(number) LIKE ${pat} ESCAPE '\\' OR lower(supplier_name) LIKE ${pat} ESCAPE '\\')
    UNION ALL
    SELECT id, 'project', code, name, '/app/projects/' || id
    FROM project WHERE company_id = ${companyId} AND _deleted = 0 AND (lower(name) LIKE ${pat} ESCAPE '\\' OR lower(code) LIKE ${pat} ESCAPE '\\')
    LIMIT 100`;
  return rows;
}

// Studio, HR, Mailbox, Automations, Knowledge, E-Invoicing, Webhooks, Templates -----------------

export interface StudioDocument {
  id: string;
  name: string;
  format: "docx" | "xlsx" | "pptx" | "pdf";
  segment: string;
  revision: number;
  archived: boolean;
  fileId: string;
  updatedAt: string;
}

export async function createStudioDocument(
  tx: Tx,
  actor: string | null,
  meta: { name: string; format: StudioDocument["format"]; segment?: string; mimeType: string; bytes: Uint8Array },
): Promise<StudioDocument> {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const file = await storeBlobFile(tx, meta.name, meta.mimeType, meta.bytes);
  const id = uid();
  const now = nowIso();
  const seg = meta.segment ?? "customers";
  await tx`
    INSERT INTO studio_document (id, company_id, name, format, segment, revision, archived, file_id, created_at, updated_at, _site)
    VALUES (${id}, ${companyId}, ${meta.name}, ${meta.format}, ${seg}, 1, 0, ${file.id}, ${now}, ${now}, ${site})`;
  await tx`
    INSERT INTO studio_revision (id, company_id, document_id, revision, file_id, actor, created_at)
    VALUES (${uid()}, ${companyId}, ${id}, 1, ${file.id}, ${actor}, ${now})`;
  await appendAudit(tx, actor, "studio.create", id, { format: meta.format });
  return {
    id,
    name: meta.name,
    format: meta.format,
    segment: seg,
    revision: 1,
    archived: false,
    fileId: file.id,
    updatedAt: now,
  };
}

export async function saveStudioRevision(
  tx: Tx,
  actor: string | null,
  id: string,
  expectedRevision: number,
  mimeType: string,
  bytes: Uint8Array,
  locale: Locale = "en",
): Promise<StudioDocument> {
  const companyId = reqCompany(tx);
  const [cur] = await tx<
    {
      id: string;
      name: string;
      format: StudioDocument["format"];
      segment: string;
      revision: number;
      archived: number;
      file_id: string;
    }[]
  >`
    SELECT id, name, format, segment, revision, archived, file_id FROM studio_document WHERE id = ${id} AND company_id = ${companyId} AND _deleted = 0`;
  if (!cur) throw new StoreError(t(locale, "Studio document not found"), [], 404);
  if (cur.revision !== expectedRevision) {
    throw new StoreError(t(locale, "Document was modified concurrently; reload the latest revision"), [], 409);
  }
  if (asBool(cur.archived)) throw new StoreError(t(locale, "Unarchive the document before editing"), [], 409);
  const file = await storeBlobFile(tx, cur.name, mimeType, bytes);
  const nextRev = cur.revision + 1;
  const now = nowIso();
  await tx`UPDATE studio_document SET file_id = ${file.id}, revision = ${nextRev}, updated_at = ${now} WHERE id = ${id}`;
  await tx`INSERT INTO studio_revision (id, company_id, document_id, revision, file_id, actor, created_at) VALUES (${uid()}, ${companyId}, ${id}, ${nextRev}, ${file.id}, ${actor}, ${now})`;
  return {
    id,
    name: cur.name,
    format: cur.format,
    segment: cur.segment,
    revision: nextRev,
    archived: false,
    fileId: file.id,
    updatedAt: now,
  };
}

export async function listStudioDocuments(tx: Tx): Promise<StudioDocument[]> {
  const companyId = reqCompany(tx);
  const rows = await tx<
    {
      id: string;
      name: string;
      format: StudioDocument["format"];
      segment: string;
      revision: number;
      archived: number;
      file_id: string;
      updated_at: string;
    }[]
  >`SELECT id, name, format, segment, revision, archived, file_id, updated_at FROM studio_document WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY updated_at DESC LIMIT 200`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    format: r.format,
    segment: r.segment,
    revision: asNum(r.revision),
    archived: asBool(r.archived),
    fileId: r.file_id,
    updatedAt: r.updated_at,
  }));
}

export async function saveEmployee(tx: Tx, actor: string | null, input: DomainEmployee, locale: Locale = "en") {
  const errs = verifyEmployee(input, locale);
  if (errs.length) throw new StoreError(t(locale, "Invalid employee"), errs, 400);
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = uid();
  const now = nowIso();
  const hlc = await recordChange(
    tx,
    "employee",
    id,
    "upsert",
    { ...input, id, company_id: companyId, updated_at: now },
    site,
  );
  await tx`
    INSERT INTO employee (id, company_id, last_name, first_name, email, role, contract, start_date, end_date, working_time_percent, gross_monthly_salary_cents, created_at, updated_at, _hlc, _site)
    VALUES (${id}, ${companyId}, ${input.lastName.trim()}, ${input.firstName.trim()}, ${input.email ?? null}, ${input.role.trim()}, ${input.contract}, ${input.startDate}, ${input.endDate ?? null}, ${input.workingTimePercent}, ${input.grossMonthlySalaryCents}, ${now}, ${now}, ${hlc}, ${site})`;
  await appendAudit(tx, actor, "hr.employee.create", id, { role: input.role });
  return { id, ...input };
}

export async function listEmployees(tx: Tx) {
  const companyId = reqCompany(tx);
  return tx<
    {
      id: string;
      last_name: string;
      first_name: string;
      email: string | null;
      role: string;
      contract: string;
      start_date: string;
      end_date: string | null;
      working_time_percent: number;
      gross_monthly_salary_cents: number;
    }[]
  >`SELECT id, last_name, first_name, email, role, contract, start_date, end_date, working_time_percent, gross_monthly_salary_cents FROM employee WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY last_name ASC`;
}

export async function requestAbsence(
  tx: Tx,
  actor: string | null,
  input: { employeeId: string; type: AbsenceType; startDate: string; endDate: string; notes?: string },
) {
  const companyId = reqCompany(tx);
  const days = Math.max(1, workingDays(input.startDate, input.endDate));
  const id = uid();
  await tx`
    INSERT INTO absence (id, company_id, employee_id, type, start_date, end_date, days, status, notes)
    VALUES (${id}, ${companyId}, ${input.employeeId}, ${input.type}, ${input.startDate}, ${input.endDate}, ${days}, ${"requested"}, ${input.notes ?? null})`;
  await enqueueOutbox(tx, "absence.requested", { absenceId: id, employeeId: input.employeeId, days });
  await appendAudit(tx, actor, "hr.absence.request", id, { days });
  return { id, ...input, days, status: "requested" as AbsenceStatus };
}

export async function employeeLeaveBalance(
  tx: Tx,
  employeeId: string,
  asOfDate: string,
): Promise<{ accruedDays: number; takenDays: number; remainingDays: number }> {
  const companyId = reqCompany(tx);
  const [emp] = await tx<
    { start_date: string; end_date: string | null }[]
  >`SELECT start_date, end_date FROM employee WHERE id = ${employeeId} AND company_id = ${companyId}`;
  if (!emp) return { accruedDays: 0, takenDays: 0, remainingDays: 0 };
  const accrued = accruedLeaveDays({ startDate: emp.start_date, endDate: emp.end_date ?? undefined }, asOfDate);
  const [taken] = await tx<{ days: number }[]>`
    SELECT coalesce(sum(days), 0) AS days FROM absence
    WHERE company_id = ${companyId} AND employee_id = ${employeeId} AND type = 'paid_leave' AND status = 'approved' AND _deleted = 0`;
  const used = asNum(taken?.days);
  return { accruedDays: accrued, takenDays: used, remainingDays: Math.max(0, Number((accrued - used).toFixed(2))) };
}

export async function saveAutomation(
  tx: Tx,
  actor: string | null,
  input: { id?: string; name: string; active: boolean; definition: unknown },
) {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  const id = input.id ?? uid();
  const defJson = JSON.stringify(input.definition);
  const now = nowIso();
  const [cur] = await tx<
    { version: number }[]
  >`SELECT version FROM automation WHERE id = ${id} AND company_id = ${companyId}`;
  const version = (cur?.version ?? 0) + 1;
  const hlc = await recordChange(
    tx,
    "automation",
    id,
    "upsert",
    { id, name: input.name, active: input.active ? 1 : 0, version, definition_json: defJson, updated_at: now },
    site,
  );
  await tx`
    INSERT INTO automation (id, company_id, name, active, version, definition_json, created_at, updated_at, _hlc, _site)
    VALUES (${id}, ${companyId}, ${input.name}, ${input.active ? 1 : 0}, ${version}, ${defJson}, ${now}, ${now}, ${hlc}, ${site})
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, active = excluded.active, version = excluded.version, definition_json = excluded.definition_json,
      updated_at = excluded.updated_at, _hlc = excluded._hlc, _site = excluded._site`;
  await tx`
    INSERT INTO automation_version (id, company_id, automation_id, version, definition_json, created_at)
    VALUES (${uid()}, ${companyId}, ${id}, ${version}, ${defJson}, ${now})`;
  await appendAudit(tx, actor, "automation.save", id, { version });
  return { id, name: input.name, active: input.active, version };
}

export async function listAutomations(tx: Tx) {
  const companyId = reqCompany(tx);
  const rows = await tx<
    { id: string; name: string; active: number; version: number; definition_json: string; updated_at: string }[]
  >`
    SELECT id, name, active, version, definition_json, updated_at FROM automation WHERE company_id = ${companyId} AND _deleted = 0 ORDER BY updated_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    active: asBool(r.active),
    version: asNum(r.version),
    definition: asJson<Record<string, unknown>>(r.definition_json),
    updatedAt: r.updated_at,
  }));
}

export async function recordAutomationRun(
  tx: Tx,
  input: {
    automationId: string;
    status: "success" | "error";
    triggerType: string;
    steps: unknown[];
    output: unknown[];
    error?: string;
  },
): Promise<string> {
  const companyId = reqCompany(tx);
  const id = uid();
  const now = nowIso();
  await tx`
    INSERT INTO automation_run (id, company_id, automation_id, status, trigger_type, steps_json, output_json, error, started_at, finished_at)
    VALUES (${id}, ${companyId}, ${input.automationId}, ${input.status}, ${input.triggerType}, ${JSON.stringify(input.steps)}, ${JSON.stringify(input.output)}, ${input.error ?? null}, ${now}, ${now})`;
  return id;
}

export async function saveKnowledgeDocument(
  tx: Tx,
  source: string,
  title: string,
  chunks: { index: number; heading: string | null; text: string; embedding?: Float32Array }[],
): Promise<string> {
  const companyId = reqCompany(tx);
  const docId = uid();
  const sha = await sha256Hex(chunks.map((c) => c.text).join("\n"));
  await tx`INSERT INTO knowledge_doc (id, company_id, source, title, sha256) VALUES (${docId}, ${companyId}, ${source}, ${title}, ${sha})`;
  for (const ch of chunks) {
    const emb = ch.embedding
      ? new Uint8Array(ch.embedding.buffer, ch.embedding.byteOffset, ch.embedding.byteLength)
      : null;
    await tx`
      INSERT INTO knowledge_chunk (id, company_id, doc_id, chunk_index, heading, content, embedding)
      VALUES (${uid()}, ${companyId}, ${docId}, ${ch.index}, ${ch.heading}, ${ch.text}, ${emb})`;
  }
  return docId;
}

export async function listKnowledgeChunks(tx: Tx) {
  const companyId = reqCompany(tx);
  const rows = await tx<
    { id: string; doc_id: string; chunk_index: number; heading: string | null; content: string; embedding: unknown }[]
  >`
    SELECT id, doc_id, chunk_index, heading, content, embedding FROM knowledge_chunk WHERE company_id = ${companyId} AND _deleted = 0`;
  return rows.map((r) => ({
    id: r.id,
    docId: r.doc_id,
    chunkIndex: asNum(r.chunk_index),
    heading: r.heading,
    content: r.content,
    embedding: r.embedding ? asBytes(r.embedding) : null,
  }));
}

export async function saveEInvoiceSubmission(
  tx: Tx,
  input: { documentId: string; provider: string; externalId?: string; status: string; raw?: unknown },
): Promise<string> {
  const companyId = reqCompany(tx);
  const id = uid();
  await tx`
    INSERT INTO einvoice_submission (id, company_id, document_id, provider, external_id, status, raw_json)
    VALUES (${id}, ${companyId}, ${input.documentId}, ${input.provider}, ${input.externalId ?? null}, ${input.status}, ${JSON.stringify(input.raw ?? {})})`;
  return id;
}

export async function enqueueOutbox(tx: Tx, type: string, payload: unknown): Promise<{ id: string }> {
  const companyId = reqCompany(tx);
  const id = uid();
  await tx`
    INSERT INTO outbox (id, company_id, type, payload_json)
    VALUES (${id}, ${companyId}, ${type}, ${JSON.stringify(payload ?? {})})`;
  return { id };
}

export async function claimOutboxBatch(tx: Tx, limit = 20) {
  const companyId = reqCompany(tx);
  const now = nowIso();
  return tx<{ id: string; type: string; payload_json: string; attempts: number }[]>`
    SELECT id, type, payload_json, attempts FROM outbox
    WHERE company_id = ${companyId} AND status = 'pending' AND next_attempt_at <= ${now}
    ORDER BY created_at ASC LIMIT ${limit}`;
}

export async function completeOutbox(tx: Tx, id: string, error?: string): Promise<void> {
  if (!error) {
    await tx`UPDATE outbox SET status = ${"delivered"} WHERE id = ${id}`;
    return;
  }
  const nextAt = new Date(Date.now() + 60_000).toISOString();
  await tx`
    UPDATE outbox SET attempts = attempts + 1, last_error = ${error}, next_attempt_at = ${nextAt},
      status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END
    WHERE id = ${id}`;
}

export async function saveTemplateConfig(
  tx: Tx,
  cfg: { color?: string; logoMime?: string; logoDataBase64?: string; footer?: string },
): Promise<void> {
  const companyId = reqCompany(tx);
  const site = await readSite(tx);
  await tx`
    INSERT INTO template_config (company_id, color, logo_mime, logo_data_base64, footer, updated_at, _site)
    VALUES (${companyId}, ${cfg.color ?? null}, ${cfg.logoMime ?? null}, ${cfg.logoDataBase64 ?? null}, ${cfg.footer ?? null}, ${nowIso()}, ${site})
    ON CONFLICT (company_id) DO UPDATE SET
      color = excluded.color, logo_mime = excluded.logo_mime, logo_data_base64 = excluded.logo_data_base64,
      footer = excluded.footer, updated_at = excluded.updated_at`;
}

export async function getTemplateConfig(tx: Tx) {
  const companyId = reqCompany(tx);
  const [row] = await tx<
    { color: string | null; logo_mime: string | null; logo_data_base64: string | null; footer: string | null }[]
  >`
    SELECT color, logo_mime, logo_data_base64, footer FROM template_config WHERE company_id = ${companyId} AND _deleted = 0`;
  if (!row) return undefined;
  return {
    ...(row.color ? { color: row.color } : {}),
    ...(row.logo_mime && row.logo_data_base64
      ? { logo: { mime: row.logo_mime, dataBase64: row.logo_data_base64 } }
      : {}),
    ...(row.footer ? { footer: row.footer } : {}),
  };
}

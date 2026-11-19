// Unified Web-standard HTTP/REST/WS/MCP/OpenAPI router for BOTH Cloudflare Workers and Bun self-hosted.
import { fec, paymentEntry, salesEntry } from "@aphrody/auto-domain/accounting";
import { withDefaultLegalTerms, type Document, type DocumentStatus } from "@aphrody/auto-domain";
import { resolveLocale, t } from "@aphrody/auto-i18n";
import {
  authHashPassword,
  authJwks,
  authSignJwt,
  authVerifyPassword,
  extractXml,
  facturx,
  parseTotalInclVatCents,
  renderPdf,
} from "@aphrody/auto-native";
import type { Blobs, Sql, Tx } from "@aphrody/auto-platform";
import type { LlmClient } from "@aphrody/auto-platform/llm";
import {
  applyStudioOperation,
  assertSafeWebhookUrl,
  checkQuota,
  createBlankStudioFile,
  createMailerFromEnv,
  createStripeCheckoutSession,
  detectStudioFormat,
  dispatchOutboxBatch,
  executeWorkflow,
  findTool,
  handleMcpJsonRpc,
  importLegacyN8nWorkflow,
  ingestDocument,
  inspectStudioFile,
  lookupDirectory,
  MAIL_PRESETS,
  outbox,
  parseIngestRequest,
  submitEInvoice,
  submitEReporting,
  validateStudioFilename,
  validateWorkflow,
  verifyStripeWebhookSignature,
  type JsonRpcRequest,
  type Mailer,
  type StudioOperation,
} from "@aphrody/auto-services";
import {
  appendAudit,
  applyRemoteChanges,
  authenticateRequest,
  createAuth,
  createCompanyWithOwner,
  createCreditNoteFromInvoice,
  createCustomer,
  createDraft,
  createProduct,
  createStudioDocument,
  employeeLeaveBalance,
  exportAccountingData,
  getArtifact,
  getDocument,
  getDocumentByPortalToken,
  getProjectFolder,
  getTemplateConfig,
  issueDocument,
  linkDocumentToProject,
  listAutomations,
  listCustomers,
  listDocuments,
  listEmployees,
  listOverdueDocuments,
  listPayments,
  listProducts,
  listProjects,
  listReceivedInvoices,
  listStudioDocuments,
  listSuppliers,
  listUserCompanies,
  pullChanges,
  readBlobFile,
  recordAutomationRun,
  recordOperatorAudit,
  recordPayment,
  recordReminder,
  requestAbsence,
  requireAction,
  requireSegment,
  saveAutomation,
  saveEmployee,
  saveProject,
  saveStudioRevision,
  saveSupplier,
  saveTemplateConfig,
  searchWorkspace,
  setAuthMailer,
  storeArtifact,
  transitionDocumentStatus,
  uid,
  updateCustomer,
  updateDraft,
  upsertCompanyProfile,
  verifyAuditChain,
  withCompany,
  type AutoAuth,
  type Caller,
  type SyncChange,
} from "@aphrody/auto-store";

export interface ServerDeps {
  sql: Sql;
  blobs?: Blobs;
  auth?: AutoAuth;
  mailer?: Mailer;
  llm?: LlmClient | null;
  mode: "serverless" | "self-hosted";
  companySql?: (companyId: string) => Promise<Sql>;
  onSyncPull?: (
    companyId: string,
    sinceSeq: number,
    limit: number,
  ) => Promise<{ changes: SyncChange[]; nextSeq: number }>;
  onSyncPush?: (companyId: string, ops: SyncChange[]) => Promise<{ applied: number; skipped: number }>;
  onReleaseAsset?: (name: string) => Promise<Response | null>;
  env?: Record<string, string | undefined>;
}

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("origin");
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-company-id,x-api-key,accept-language",
      }
    : {};
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function errJson(err: unknown): Response {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    const se = err as { message: string; status: number; details?: string[] };
    return json({ error: se.message, details: se.details ?? [] }, se.status);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return json({ error: msg }, 500);
}

async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

export function buildOpenApiSpec(baseUrl = "https://auto.aphrody.com") {
  return {
    openapi: "3.1.0",
    info: { title: "Auto API", version: "2026.11.5", license: { name: "Apache-2.0" } },
    servers: [{ url: baseUrl }],
    paths: {
      "/health": { get: { summary: "Health check" } },
      "/v1/me": { get: { summary: "Current authenticated caller and companies" } },
      "/v1/documents": { get: { summary: "List documents" }, post: { summary: "Create draft document" } },
      "/v1/documents/{id}/issue": { post: { summary: "Issue document with gapless sequence" } },
      "/v1/customers": { get: { summary: "List customers" }, post: { summary: "Create customer" } },
      "/v1/products": { get: { summary: "List products" }, post: { summary: "Create product" } },
      "/v1/projects": { get: { summary: "List projects" }, post: { summary: "Save project" } },
      "/v1/suppliers": { get: { summary: "List suppliers" }, post: { summary: "Save supplier" } },
      "/v1/employees": { get: { summary: "List employees" }, post: { summary: "Save employee" } },
      "/v1/automations": { get: { summary: "List automations" }, post: { summary: "Save automation workflow" } },
      "/v1/ingest": { post: { summary: "Ingest supplier invoice PDF/XML" } },
      "/v1/compliance/fec": { get: { summary: "Export DGFiP FEC ledger" } },
      "/mcp": { post: { summary: "Model Context Protocol JSON-RPC 2.0 endpoint" } },
      "/api/sync/pull": { post: { summary: "Pull HLC sync changes" } },
      "/api/sync/push": { post: { summary: "Push HLC sync changes" } },
      "/releases/manifest.json": { get: { summary: "Signed LTO binary release manifest" } },
    },
  };
}

export function createAutoApp(deps: ServerDeps) {
  const env = deps.env ?? (typeof process !== "undefined" ? process.env : {});
  const auth = deps.auth ?? createAuth(deps.sql, { env });
  const mailer = deps.mailer ?? createMailerFromEnv(env);
  setAuthMailer({
    async send(msg) {
      await mailer.send(msg);
    },
  });

  async function runCompany<T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (deps.companySql) {
      const cSql = await deps.companySql(companyId);
      return withCompany(cSql, companyId, fn);
    }
    return withCompany(deps.sql, companyId, fn);
  }

  async function authenticate(
    req: Request,
    action: Parameters<typeof requireAction>[1],
  ): Promise<{ caller: Caller; locale: "en" | "fr" }> {
    const locale = resolveLocale(req.headers.get("accept-language"), "en");
    const res = await authenticateRequest(deps.sql, auth, req);
    if (!res) throw Object.assign(new Error(t(locale, "Authentication required")), { status: 401 });
    requireAction(res.caller, action, locale);
    requireSegment(res.caller, req, locale);
    return { caller: res.caller, locale };
  }

  async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    const res = await route(req);
    const cors = corsHeaders(req);
    if (!Object.keys(cors).length) return res;
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) merged.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const locale = resolveLocale(url.searchParams.get("lang") ?? req.headers.get("accept-language"), "en");

    try {
      if (path === "/health" && method === "GET") {
        return json({
          ok: true,
          mode: deps.mode,
          version: "2026.11.5",
          auth: "auto-auth-rust+better-auth",
          timestamp: new Date().toISOString(),
        });
      }

      if (path === "/v1/openapi.json" && method === "GET") {
        return json(buildOpenApiSpec(url.origin));
      }

      if (path === "/.well-known/jwks.json" || path === "/api/auth/jwks") {
        try {
          const masterSecret = env.AUTO_MASTER_KEY ?? env.BETTER_AUTH_SECRET ?? "auto-dev-better-auth-secret-32chars!!";
          return json(authJwks({ masterSecret }));
        } catch {
          return auth.handler(req);
        }
      }

      if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
        return json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/api/auth/oauth2/authorize`,
          token_endpoint: `${url.origin}/api/auth/oauth2/token`,
          jwks_uri: `${url.origin}/.well-known/jwks.json`,
          device_authorization_endpoint: `${url.origin}/api/auth/device/code`,
          grant_types_supported: [
            "authorization_code",
            "refresh_token",
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
          id_token_signing_alg_values_supported: ["EdDSA"],
        });
      }

      if (path.startsWith("/.well-known/oauth-protected-resource") && method === "GET") {
        return json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
        });
      }

      // Fast Rust-powered auth helper endpoints alongside full Better Auth `/api/auth/*` handler
      if (path === "/api/auth/rust/hash" && method === "POST") {
        const b = await readJson<{ password: string; mode?: "argon2id" | "scrypt" }>(req);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        return json({ hash: authHashPassword(b.password, salt, b.mode ?? "argon2id") });
      }
      if (path === "/api/auth/rust/verify" && method === "POST") {
        const b = await readJson<{ password: string; hash: string }>(req);
        return json({ valid: authVerifyPassword(b.password, b.hash) });
      }

      if (path.startsWith("/api/auth")) {
        return auth.handler(req);
      }

      if (path === "/releases/manifest.json" || path.startsWith("/releases/")) {
        if (deps.onReleaseAsset) {
          const name = path === "/releases/manifest.json" ? "manifest.json" : path.slice("/releases/".length);
          const hit = await deps.onReleaseAsset(name);
          if (hit) return hit;
        }
        return json({ error: "Release artifact not published yet" }, 404);
      }

      // Public client portal routes
      if (path.startsWith("/v1/portal/")) {
        const parts = path.slice("/v1/portal/".length).split("/");
        const token = parts[0]!;
        const companyHint = url.searchParams.get("companyId");
        if (!companyHint) return json({ error: "companyId query parameter required" }, 400);
        if (method === "GET" && parts.length === 1) {
          const doc = await runCompany(companyHint, (tx) => getDocumentByPortalToken(tx, token));
          return doc ? json(doc) : json({ error: "Not found" }, 404);
        }
        if (method === "POST" && parts[1] === "accept") {
          const updated = await runCompany(companyHint, async (tx) => {
            const doc = await getDocumentByPortalToken(tx, token);
            if (!doc) return null;
            return transitionDocumentStatus(tx, null, doc.id, "accepted", locale);
          });
          return updated ? json(updated) : json({ error: "Not found" }, 404);
        }
      }

      // Authenticated routes ----------------------------------------------------------------------
      if (path === "/v1/me" && method === "GET") {
        const sess = await auth.api.getSession({ headers: req.headers }).catch(() => null);
        if (!sess?.user) return json({ error: "Authentication required" }, 401);
        const companies = await listUserCompanies(deps.sql, sess.user.id);
        return json({ user: sess.user, companies });
      }

      if (path === "/v1/companies" && method === "POST") {
        const sess = await auth.api.getSession({ headers: req.headers }).catch(() => null);
        if (!sess?.user) return json({ error: "Authentication required" }, 401);
        const body = await readJson<{
          name: string;
          taxId: string;
          address: string;
          vatNumber?: string;
          vatExempt?: boolean;
        }>(req);
        const created = await createCompanyWithOwner(deps.sql, sess.user.id, body, locale);
        await runCompany(created.id, (tx) =>
          upsertCompanyProfile(tx, {
            id: created.id,
            name: body.name,
            siren: created.siren,
            siret: created.siret,
            address: body.address,
            vatNumber: created.vatNumber,
            vatExempt: body.vatExempt,
          }),
        );
        return json(created, 201);
      }

      if (path === "/v1/auth/jwt" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        const masterSecret = env.AUTO_MASTER_KEY ?? env.BETTER_AUTH_SECRET ?? "auto-dev-better-auth-secret-32chars!!";
        const now = Math.floor(Date.now() / 1000);
        const res = authSignJwt({
          masterSecret,
          claims: {
            iss: url.origin,
            sub: caller.userId,
            aud: `${url.origin}/mcp`,
            iat: now,
            exp: now + 900,
            activeOrganizationId: caller.companyId,
            role: caller.role,
          },
        });
        return json(res);
      }

      // Documents CRUD & issuance
      if (path === "/v1/documents" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        const docs = await runCompany(caller.companyId, (tx) =>
          listDocuments(tx, {
            type: (url.searchParams.get("type") as Document["type"]) || undefined,
            status: (url.searchParams.get("status") as DocumentStatus) || undefined,
            customerId: url.searchParams.get("customerId") || undefined,
          }),
        );
        return json(docs);
      }

      if (path === "/v1/documents" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ document?: Document; customerId?: string } & Partial<Document>>(req);
        const rawDoc = b.document ?? (b as unknown as Document);
        const prepared = withDefaultLegalTerms(rawDoc, locale);
        const created = await runCompany(caller.companyId, (tx) =>
          createDraft(tx, caller.userId, prepared, b.customerId ?? null),
        );
        return json(created, 201);
      }

      const docMatch = /^\/v1\/documents\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (docMatch) {
        const docId = decodeURIComponent(docMatch[1]!);
        const sub = docMatch[2];
        if (!sub && method === "GET") {
          const { caller } = await authenticate(req, "read");
          const d = await runCompany(caller.companyId, (tx) => getDocument(tx, docId));
          return d ? json(d) : json({ error: "Document not found" }, 404);
        }
        if (!sub && method === "PUT") {
          const { caller } = await authenticate(req, "write");
          const b = await readJson<{ document?: Document; customerId?: string } & Partial<Document>>(req);
          const rawDoc = withDefaultLegalTerms(b.document ?? (b as unknown as Document), locale);
          const updated = await runCompany(caller.companyId, (tx) =>
            updateDraft(tx, caller.userId, docId, rawDoc, b.customerId ?? null, locale),
          );
          return json(updated);
        }
        if (sub === "issue" && method === "POST") {
          const { caller } = await authenticate(req, "write");
          const issued = await runCompany(caller.companyId, async (tx) => {
            if (deps.mode === "serverless") {
              const quota = await checkQuota(tx, "invoices").catch(() => null);
              void quota;
            }
            const res = await issueDocument(tx, caller.userId, docId, locale);
            const pdf = res.type === "quote" ? renderPdf(res.data, locale) : facturx(res.data, new Date(), locale);
            await storeArtifact(tx, res.id, res.type === "quote" ? "pdf" : "facturx", pdf);
            await outbox(tx, "document.issued", { id: res.id, number: res.number, inclVatCents: res.inclVatCents });
            return res;
          });
          return json(issued);
        }
        if (sub === "status" && method === "POST") {
          const { caller } = await authenticate(req, "write");
          const b = await readJson<{ status: DocumentStatus }>(req);
          const updated = await runCompany(caller.companyId, (tx) =>
            transitionDocumentStatus(tx, caller.userId, docId, b.status, locale),
          );
          return json(updated);
        }
        if (sub === "credit-note" && method === "POST") {
          const { caller } = await authenticate(req, "write");
          const b = await readJson<{ date?: string; lines?: Document["lines"] }>(req);
          const cn = await runCompany(caller.companyId, (tx) =>
            createCreditNoteFromInvoice(
              tx,
              caller.userId,
              docId,
              b.date ?? new Date().toISOString().slice(0, 10),
              b.lines,
              locale,
            ),
          );
          return json(cn, 201);
        }
        if (sub === "pdf" && method === "GET") {
          const { caller } = await authenticate(req, "read");
          const out = await runCompany(caller.companyId, async (tx) => {
            const art = (await getArtifact(tx, docId, "facturx")) ?? (await getArtifact(tx, docId, "pdf"));
            if (art) return art.bytes;
            const d = await getDocument(tx, docId);
            if (!d) return null;
            const tpl = await getTemplateConfig(tx);
            return renderPdf({ ...d.data, ...(tpl ? { template: tpl } : {}) }, locale);
          });
          return out
            ? new Response(out, {
                headers: { "content-type": "application/pdf", "cache-control": "private, max-age=60" },
              })
            : json({ error: "Document not found" }, 404);
        }
        if (sub === "xml" && method === "GET") {
          const { caller } = await authenticate(req, "read");
          const xmlText = await runCompany(caller.companyId, async (tx) => {
            const art = await getArtifact(tx, docId, "facturx");
            if (art) return extractXml(art.bytes);
            return null;
          });
          return xmlText
            ? new Response(xmlText, { headers: { "content-type": "application/xml; charset=utf-8" } })
            : json({ error: "Factur-X XML not found" }, 404);
        }
        if (sub === "payments" && method === "GET") {
          const { caller } = await authenticate(req, "read");
          return json(await runCompany(caller.companyId, (tx) => listPayments(tx, docId)));
        }
        if (sub === "payments" && method === "POST") {
          const { caller } = await authenticate(req, "write");
          const b = await readJson<{
            date: string;
            amountCents: number;
            method: "transfer" | "card" | "check" | "cash" | "direct_debit" | "other";
            reference?: string;
          }>(req);
          const p = await runCompany(caller.companyId, async (tx) => {
            const res = await recordPayment(tx, caller.userId, { documentId: docId, ...b }, locale);
            await outbox(tx, "payment.recorded", { documentId: docId, amountCents: b.amountCents });
            return res;
          });
          return json(p, 201);
        }
        if (sub === "einvoice" && method === "POST") {
          const { caller } = await authenticate(req, "write");
          const res = await runCompany(caller.companyId, async (tx) => {
            const d = await getDocument(tx, docId);
            if (!d) throw Object.assign(new Error("Document not found"), { status: 404 });
            const pdf = renderPdf(d.data, locale);
            return submitEInvoice(tx, {
              documentId: d.id,
              doc: d.data,
              pdfBytes: pdf,
              config: { provider: "mock", accountId: "default", apiKey: "mock", webhookSecret: "mock" },
            });
          });
          return json(res, 201);
        }
      }

      // Customers, Products, Suppliers, Projects, HR
      if (path === "/v1/customers" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(
          await runCompany(caller.companyId, (tx) => listCustomers(tx, url.searchParams.get("q") ?? undefined)),
        );
      }
      if (path === "/v1/customers" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<Parameters<typeof createCustomer>[2]>(req);
        return json(await runCompany(caller.companyId, (tx) => createCustomer(tx, caller.userId, b, locale)), 201);
      }
      if (path.startsWith("/v1/customers/") && method === "PUT") {
        const { caller } = await authenticate(req, "write");
        const cid = decodeURIComponent(path.slice("/v1/customers/".length));
        const b = await readJson<Parameters<typeof updateCustomer>[3]>(req);
        return json(await runCompany(caller.companyId, (tx) => updateCustomer(tx, caller.userId, cid, b, locale)));
      }

      if (path === "/v1/products" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => listProducts(tx)));
      }
      if (path === "/v1/products" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<Parameters<typeof createProduct>[2]>(req);
        return json(await runCompany(caller.companyId, (tx) => createProduct(tx, caller.userId, b, locale)), 201);
      }

      if (path === "/v1/suppliers" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => listSuppliers(tx)));
      }
      if (path === "/v1/suppliers" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<Parameters<typeof saveSupplier>[2]>(req);
        return json(await runCompany(caller.companyId, (tx) => saveSupplier(tx, caller.userId, b)), 201);
      }

      if (path === "/v1/projects" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => listProjects(tx)));
      }
      if (path === "/v1/projects" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<Parameters<typeof saveProject>[2]>(req);
        return json(await runCompany(caller.companyId, (tx) => saveProject(tx, caller.userId, b)), 201);
      }
      const projFolderMatch = /^\/v1\/projects\/([^/]+)\/folder$/.exec(path);
      if (projFolderMatch && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(
          await runCompany(caller.companyId, (tx) =>
            getProjectFolder(tx, decodeURIComponent(projFolderMatch[1]!), locale),
          ),
        );
      }
      if (path === "/v1/projects/link" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ projectId: string; documentId: string }>(req);
        await runCompany(caller.companyId, (tx) => linkDocumentToProject(tx, b.projectId, b.documentId));
        return new Response(null, { status: 204 });
      }

      if (path === "/v1/employees" && method === "GET") {
        const { caller } = await authenticate(req, "hr");
        return json(await runCompany(caller.companyId, (tx) => listEmployees(tx)));
      }
      if (path === "/v1/employees" && method === "POST") {
        const { caller } = await authenticate(req, "hr");
        const b = await readJson<Parameters<typeof saveEmployee>[2]>(req);
        return json(await runCompany(caller.companyId, (tx) => saveEmployee(tx, caller.userId, b, locale)), 201);
      }
      const leaveMatch = /^\/v1\/employees\/([^/]+)\/leave$/.exec(path);
      if (leaveMatch && method === "GET") {
        const { caller } = await authenticate(req, "hr");
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        return json(
          await runCompany(caller.companyId, (tx) =>
            employeeLeaveBalance(tx, decodeURIComponent(leaveMatch[1]!), date),
          ),
        );
      }
      if (path === "/v1/absences" && method === "POST") {
        const { caller } = await authenticate(req, "hr");
        const b = await readJson<Parameters<typeof requestAbsence>[2]>(req);
        return json(await runCompany(caller.companyId, (tx) => requestAbsence(tx, caller.userId, b)), 201);
      }

      // Reminders, Compliance, Ingest, Studio, Search
      if (path === "/v1/reminders" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        return json(await runCompany(caller.companyId, (tx) => listOverdueDocuments(tx, date)));
      }
      if (path === "/v1/reminders/send" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ documentId: string; level: 1 | 2 | 3; channel?: "email" | "postal" | "phone" }>(req);
        await runCompany(caller.companyId, (tx) =>
          recordReminder(tx, caller.userId, b.documentId, b.level, b.channel ?? "email"),
        );
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/audit/verify" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => verifyAuditChain(tx)));
      }
      if (path === "/v1/compliance/fec" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        const start = url.searchParams.get("start") ?? `${new Date().getUTCFullYear()}-01-01`;
        const end = url.searchParams.get("end") ?? new Date().toISOString().slice(0, 10);
        const text = await runCompany(caller.companyId, async (tx) => {
          const { sales, receipts } = await exportAccountingData(tx, start, end);
          return fec([...sales.flatMap((s) => salesEntry(s)), ...receipts.flatMap((r) => paymentEntry(r))]);
        });
        return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }

      if (path === "/v1/ingest" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const incoming = await parseIngestRequest(req);
        const res = await runCompany(caller.companyId, (tx) =>
          ingestDocument(tx, caller.userId, incoming, { llm: deps.llm }),
        );
        return json(res, res.duplicate ? 200 : 201);
      }
      if (path === "/v1/received-invoices" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => listReceivedInvoices(tx)));
      }
      if (path === "/v1/search" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        const q = url.searchParams.get("q") ?? "";
        return json(await runCompany(caller.companyId, (tx) => searchWorkspace(tx, q, locale)));
      }

      if (path === "/v1/studio" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => listStudioDocuments(tx)));
      }
      if (path === "/v1/studio" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ name: string; format?: "docx" | "xlsx"; segment?: string }>(req);
        const format = b.format ?? (detectStudioFormat(b.name) === "xlsx" ? "xlsx" : "docx");
        const name = validateStudioFilename(b.name, format);
        const bytes = createBlankStudioFile(format);
        const mimeType =
          format === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        const created = await runCompany(caller.companyId, (tx) =>
          createStudioDocument(tx, caller.userId, { name, format, segment: b.segment, mimeType, bytes }),
        );
        return json(created, 201);
      }
      const studioOpMatch = /^\/v1\/studio\/([^/]+)\/op$/.exec(path);
      if (studioOpMatch && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const sid = decodeURIComponent(studioOpMatch[1]!);
        const b = await readJson<{ expectedRevision: number; operation: StudioOperation }>(req);
        const res = await runCompany(caller.companyId, async (tx) => {
          const all = await listStudioDocuments(tx);
          const doc = all.find((d) => d.id === sid);
          if (!doc) throw Object.assign(new Error("Studio document not found"), { status: 404 });
          const blob = await readBlobFile(tx, doc.fileId);
          if (!blob) throw Object.assign(new Error("Studio file bytes missing"), { status: 404 });
          const transformed = applyStudioOperation(blob.bytes, doc.format, b.operation);
          const updated = await saveStudioRevision(
            tx,
            caller.userId,
            sid,
            b.expectedRevision,
            transformed.mimeType,
            transformed.bytes,
            locale,
          );
          return {
            document: updated,
            meta: transformed.meta,
            preview: inspectStudioFile(transformed.bytes, transformed.format),
          };
        });
        return json(res);
      }

      if (path === "/v1/templates/config" && method === "PUT") {
        const { caller } = await authenticate(req, "settings");
        const b = await readJson<Parameters<typeof saveTemplateConfig>[1]>(req);
        await runCompany(caller.companyId, (tx) => saveTemplateConfig(tx, b));
        return new Response(null, { status: 204 });
      }

      // Automations, E-Invoicing, Mail, Billing, Webhooks, Admin
      if (path === "/v1/automations" && method === "GET") {
        const { caller } = await authenticate(req, "read");
        return json(await runCompany(caller.companyId, (tx) => listAutomations(tx)));
      }
      if (path === "/v1/automations" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ id?: string; name: string; active?: boolean; definition: unknown }>(req);
        const def = validateWorkflow(b.definition);
        return json(
          await runCompany(caller.companyId, (tx) =>
            saveAutomation(tx, caller.userId, { ...b, active: b.active ?? true, definition: def }),
          ),
          201,
        );
      }
      if (path === "/v1/automations/import-n8n" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ name?: string; workflow: Parameters<typeof importLegacyN8nWorkflow>[0] }>(req);
        const def = importLegacyN8nWorkflow(b.workflow);
        return json(
          await runCompany(caller.companyId, (tx) =>
            saveAutomation(tx, caller.userId, { name: b.name ?? "Imported workflow", active: false, definition: def }),
          ),
          201,
        );
      }
      const autoRunMatch = /^\/v1\/automations\/([^/]+)\/run$/.exec(path);
      if (autoRunMatch && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const aid = decodeURIComponent(autoRunMatch[1]!);
        const b = await readJson<{ input?: unknown }>(req).catch(() => ({ input: {} }));
        const runRes = await runCompany(caller.companyId, async (tx) => {
          const all = await listAutomations(tx);
          const wf = all.find((w) => w.id === aid);
          if (!wf) throw Object.assign(new Error("Automation not found"), { status: 404 });
          const res = await executeWorkflow(validateWorkflow(wf.definition), b.input ?? {}, {
            tx,
            mailer,
            llm: deps.llm,
            companyId: caller.companyId,
          });
          await recordAutomationRun(tx, {
            automationId: wf.id,
            status: res.status,
            triggerType: "manual",
            steps: res.steps,
            output: [res.output],
            error: res.error,
          });
          return res;
        });
        return json(runRes);
      }

      if (path === "/v1/mail/presets" && method === "GET") return json(MAIL_PRESETS);

      if (path.startsWith("/v1/einvoicing/directory/") && method === "GET") {
        await authenticate(req, "read");
        const siren = decodeURIComponent(path.slice("/v1/einvoicing/directory/".length));
        return json((await lookupDirectory(siren, "mock")) ?? { siren, registered: false });
      }
      if (path === "/v1/einvoicing/ereporting" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<Parameters<typeof submitEReporting>[1]>(req);
        return json(await runCompany(caller.companyId, (tx) => submitEReporting(tx, b)), 201);
      }

      if (path === "/v1/webhooks" && method === "POST") {
        const { caller } = await authenticate(req, "settings");
        const b = await readJson<{ url: string; secret: string; events?: string[] }>(req);
        const safe = assertSafeWebhookUrl(b.url);
        const id = uid();
        await runCompany(caller.companyId, async (tx) => {
          await tx`INSERT INTO webhook_endpoint (id, company_id, url, secret, events_json) VALUES (${id}, ${caller.companyId}, ${safe.toString()}, ${b.secret}, ${JSON.stringify(b.events ?? ["*"])})`;
        });
        return json({ id, url: safe.toString() }, 201);
      }

      if (path === "/v1/billing/checkout" && method === "POST") {
        const { caller } = await authenticate(req, "settings");
        const b = await readJson<{
          stripeKey?: string;
          amountCents: number;
          productName: string;
          successUrl: string;
          cancelUrl: string;
        }>(req);
        const key = b.stripeKey ?? env.STRIPE_SECRET_KEY ?? "";
        if (!key) return json({ error: "Stripe key missing" }, 400);
        return json(
          await createStripeCheckoutSession({
            stripeKey: key,
            amountCents: b.amountCents,
            productName: b.productName,
            successUrl: b.successUrl,
            cancelUrl: b.cancelUrl,
            metadata: { company_id: caller.companyId },
          }),
        );
      }
      if (path === "/v1/billing/webhook" && method === "POST") {
        const rawBody = await req.text();
        const sig = req.headers.get("stripe-signature");
        const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
        if (!secret || !(await verifyStripeWebhookSignature(rawBody, sig, secret))) {
          return json({ error: "Invalid Stripe signature" }, 401);
        }
        return json({ received: true });
      }

      const suspendMatch = /^\/v1\/admin\/companies\/([^/]+)\/suspend$/.exec(path);
      if (suspendMatch && method === "POST") {
        const { caller } = await authenticate(req, "settings");
        const targetId = decodeURIComponent(suspendMatch[1]!);
        const b = await readJson<{ reason?: string }>(req).catch(() => ({ reason: undefined }));
        await deps.sql`UPDATE company SET suspended_at = ${new Date().toISOString()}, suspension_reason = ${b.reason ?? null} WHERE id = ${targetId}`;
        await recordOperatorAudit(deps.sql, caller.userId, "company.suspend", targetId, b.reason ?? null);
        return json({ ok: true, id: targetId });
      }

      // MCP JSON-RPC 2.0 endpoint
      if (path === "/mcp" && method === "POST") {
        const { caller, locale: userLocale } = await authenticate(req, "read");
        const rpc = await readJson<JsonRpcRequest>(req);
        const reply = await handleMcpJsonRpc(rpc, async (name, args) => {
          const tool = findTool(name);
          if (!tool) throw new Error(`Unknown tool: ${name}`);
          return runCompany(caller.companyId, async (tx) => {
            const out = await tool.execute(args, { tx, actor: caller.userId, locale: userLocale });
            await appendAudit(tx, caller.userId, `mcp.${name}`, null, args);
            return out;
          });
        });
        return reply ? json(reply) : new Response(null, { status: 204 });
      }

      // HTTP Sync fallback
      if (path === "/api/sync/pull" && method === "POST") {
        const { caller } = await authenticate(req, "read");
        const b = await readJson<{ sinceSeq?: number; limit?: number }>(req).catch(
          (): { sinceSeq?: number; limit?: number } => ({}),
        );
        const res = deps.onSyncPull
          ? await deps.onSyncPull(caller.companyId, b.sinceSeq ?? 0, b.limit ?? 500)
          : await runCompany(caller.companyId, (tx) => pullChanges(tx, b.sinceSeq ?? 0, b.limit ?? 500));
        return json(res);
      }

      if (path === "/api/sync/push" && method === "POST") {
        const { caller } = await authenticate(req, "write");
        const b = await readJson<{ ops: SyncChange[] }>(req);
        const res = deps.onSyncPush
          ? await deps.onSyncPush(caller.companyId, b.ops ?? [])
          : await runCompany(caller.companyId, (tx) => applyRemoteChanges(tx, "cloud", b.ops ?? []));
        return json(res);
      }

      if (path === "/v1/outbox/dispatch" && method === "POST") {
        const { caller } = await authenticate(req, "settings");
        return json(await runCompany(caller.companyId, (tx) => dispatchOutboxBatch(tx)));
      }

      return json({ error: "Route not found" }, 404);
    } catch (err) {
      return errJson(err);
    }
  }

  return { fetch: handler, auth, authenticate, runCompany };
}

export function extractCiiSummary(xmlBytes: Uint8Array) {
  const xml = new TextDecoder().decode(xmlBytes);
  return { totalInclVatCents: parseTotalInclVatCents(xml) };
}

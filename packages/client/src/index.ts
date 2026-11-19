// Typed SDK client for Auto REST API, MCP JSON-RPC, Agent tool-calling, WebSocket sync,
// and client-side multi-upstream failover / consistent-hash load balancing.
import type { Document, DocumentStatus, DocumentType, LineItem, Party } from "@aphrody/auto-domain";
import type { Locale } from "@aphrody/auto-i18n";
import { AutoSyncClient, type AutoSyncOptions, type SyncOpWire } from "./sync";

export * from "./sync";

export class AutoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "AutoApiError";
  }
}

export type LoadBalancerStrategy = "round_robin" | "consistent_hash" | "failover";

export interface AutoClientConfig {
  baseUrl?: string;
  upstreams?: string[];
  strategy?: LoadBalancerStrategy;
  token?: string;
  companyId?: string;
  locale?: Locale;
  timeoutMs?: number;
  credentials?: RequestCredentials;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

interface UpstreamHealth {
  url: string;
  failures: number;
  unhealthyUntilMs: number;
}

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class AutoClient {
  private readonly upstreams: UpstreamHealth[];
  private readonly strategy: LoadBalancerStrategy;
  private rrCounter = 0;
  private token?: string;
  private companyId?: string;
  private locale: Locale;
  private readonly timeoutMs: number;
  private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly credentials?: RequestCredentials;

  constructor(cfg: AutoClientConfig = {}) {
    const rawList = cfg.upstreams?.length ? cfg.upstreams : [cfg.baseUrl || "https://auto.aphrody.com"];
    this.upstreams = rawList.map((u) => ({ url: u.replace(/\/+$/, ""), failures: 0, unhealthyUntilMs: 0 }));
    this.strategy = cfg.strategy ?? "consistent_hash";
    this.token = cfg.token;
    this.companyId = cfg.companyId;
    this.locale = cfg.locale ?? "en";
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.fetcher = cfg.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.credentials = cfg.credentials;
  }

  setAuth(token?: string, companyId?: string): void {
    if (token !== undefined) this.token = token;
    if (companyId !== undefined) this.companyId = companyId;
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  private pickUpstreams(): UpstreamHealth[] {
    const now = Date.now();
    const healthy = this.upstreams.filter((u) => u.unhealthyUntilMs <= now);
    const pool = healthy.length ? [...healthy] : [...this.upstreams];
    if (pool.length <= 1) return pool;
    let startIdx = 0;
    if (this.strategy === "consistent_hash" && this.companyId) {
      startIdx = fnv1a(this.companyId) % pool.length;
    } else if (this.strategy === "round_robin") {
      startIdx = this.rrCounter++ % pool.length;
    }
    return [...pool.slice(startIdx), ...pool.slice(0, startIdx)];
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const candidates = this.pickUpstreams();
    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const upstream = candidates[i]!;
      const headers = new Headers(init.headers);
      if (this.token && !headers.has("authorization")) headers.set("authorization", `Bearer ${this.token}`);
      if (this.companyId && !headers.has("x-company-id")) headers.set("x-company-id", this.companyId);
      if (!headers.has("accept-language")) headers.set("accept-language", this.locale);
      if (init.body && typeof init.body === "string" && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      try {
        const res = await this.fetcher(`${upstream.url}${path}`, {
          ...init,
          headers,
          ...(this.credentials ? { credentials: this.credentials } : {}),
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)])
            : AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status >= 502 && res.status <= 504 && i < candidates.length - 1) {
          upstream.failures++;
          upstream.unhealthyUntilMs = Date.now() + 10_000;
          continue;
        }
        upstream.failures = 0;
        upstream.unhealthyUntilMs = 0;
        if (!res.ok) {
          const parsed = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
          throw new AutoApiError(parsed.error ?? `HTTP ${res.status}`, res.status, parsed.details ?? []);
        }
        return res;
      } catch (err) {
        if (err instanceof AutoApiError) throw err;
        upstream.failures++;
        upstream.unhealthyUntilMs = Date.now() + 10_000;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new AutoApiError("All upstreams unreachable", 503);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async bytes(path: string, init?: RequestInit): Promise<Uint8Array<ArrayBuffer>> {
    const res = await this.request(path, init);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Health & Session ------------------------------------------------------------------------------

  health() {
    return this.json<{ ok: boolean; mode: string; version: string; timestamp: string }>("/health");
  }

  me() {
    return this.json<{ user: Record<string, unknown>; companyId?: string; role?: string; companies?: unknown[] }>(
      "/v1/me",
    );
  }

  // Documents -------------------------------------------------------------------------------------

  listDocuments(filter?: { type?: DocumentType; status?: DocumentStatus; customerId?: string }) {
    const qs = new URLSearchParams();
    if (filter?.type) qs.set("type", filter.type);
    if (filter?.status) qs.set("status", filter.status);
    if (filter?.customerId) qs.set("customerId", filter.customerId);
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.json<Record<string, unknown>[]>(`/v1/documents${suffix}`);
  }

  getDocument(id: string) {
    return this.json<Record<string, unknown>>(`/v1/documents/${encodeURIComponent(id)}`);
  }

  createDraft(document: Document, customerId?: string) {
    return this.json<Record<string, unknown>>("/v1/documents", {
      method: "POST",
      body: JSON.stringify({ document, customerId }),
    });
  }

  updateDraft(id: string, document: Document, customerId?: string) {
    return this.json<Record<string, unknown>>(`/v1/documents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ document, customerId }),
    });
  }

  issueDocument(id: string) {
    return this.json<Record<string, unknown>>(`/v1/documents/${encodeURIComponent(id)}/issue`, {
      method: "POST",
      body: "{}",
    });
  }

  transitionStatus(id: string, status: DocumentStatus) {
    return this.json<Record<string, unknown>>(`/v1/documents/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }

  createCreditNote(invoiceId: string, date: string, lines?: LineItem[]) {
    return this.json<Record<string, unknown>>(`/v1/documents/${encodeURIComponent(invoiceId)}/credit-note`, {
      method: "POST",
      body: JSON.stringify({ date, lines }),
    });
  }

  downloadDocumentPdf(id: string) {
    return this.bytes(`/v1/documents/${encodeURIComponent(id)}/pdf`);
  }

  downloadDocumentXml(id: string) {
    return this.request(`/v1/documents/${encodeURIComponent(id)}/xml`).then((r) => r.text());
  }

  // Payments & Reminders --------------------------------------------------------------------------

  recordPayment(documentId: string, input: { date: string; amountCents: number; method: string; reference?: string }) {
    return this.json<Record<string, unknown>>(`/v1/documents/${encodeURIComponent(documentId)}/payments`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listPayments(documentId: string) {
    return this.json<Record<string, unknown>[]>(`/v1/documents/${encodeURIComponent(documentId)}/payments`);
  }

  listOverdue(asOfDate?: string) {
    const qs = asOfDate ? `?date=${encodeURIComponent(asOfDate)}` : "";
    return this.json<Record<string, unknown>[]>(`/v1/reminders${qs}`);
  }

  // CRM & Catalog ---------------------------------------------------------------------------------

  listCustomers(query?: string) {
    const qs = query ? `?q=${encodeURIComponent(query)}` : "";
    return this.json<(Party & { id: string })[]>(`/v1/customers${qs}`);
  }

  createCustomer(customer: Party) {
    return this.json<Party & { id: string }>("/v1/customers", { method: "POST", body: JSON.stringify(customer) });
  }

  listProducts() {
    return this.json<Record<string, unknown>[]>("/v1/products");
  }

  createProduct(product: { description: string; unitPriceExclVatCents: number; vat: number; unit?: string }) {
    return this.json<Record<string, unknown>>("/v1/products", { method: "POST", body: JSON.stringify(product) });
  }

  // Operations, Projects & Search -----------------------------------------------------------------

  listProjects() {
    return this.json<Record<string, unknown>[]>("/v1/projects");
  }

  saveProject(project: Record<string, unknown>) {
    return this.json<Record<string, unknown>>("/v1/projects", { method: "POST", body: JSON.stringify(project) });
  }

  listSuppliers() {
    return this.json<Record<string, unknown>[]>("/v1/suppliers");
  }

  saveSupplier(supplier: Record<string, unknown>) {
    return this.json<Record<string, unknown>>("/v1/suppliers", { method: "POST", body: JSON.stringify(supplier) });
  }

  listEmployees() {
    return this.json<Record<string, unknown>[]>("/v1/employees");
  }

  searchWorkspace(query: string) {
    return this.json<Record<string, unknown>[]>(`/v1/search?q=${encodeURIComponent(query)}`);
  }

  exportFec(startDate: string, endDate: string) {
    return this.request(
      `/v1/compliance/fec?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`,
    ).then((r) => r.text());
  }

  // Automations, E-Invoicing & MCP ----------------------------------------------------------------

  listAutomations() {
    return this.json<Record<string, unknown>[]>("/v1/automations");
  }

  saveAutomation(input: { id?: string; name: string; active?: boolean; definition: unknown }) {
    return this.json<Record<string, unknown>>("/v1/automations", { method: "POST", body: JSON.stringify(input) });
  }

  runAutomation(id: string, input: unknown = {}) {
    return this.json<Record<string, unknown>>(`/v1/automations/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
  }

  lookupDirectory(siren: string) {
    return this.json<Record<string, unknown>>(`/v1/einvoicing/directory/${encodeURIComponent(siren)}`);
  }

  callMcp(method: string, params: Record<string, unknown> = {}) {
    return this.json<{ jsonrpc: string; id: number; result?: unknown; error?: unknown }>("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
  }

  mcpCallTool(name: string, args: Record<string, unknown> = {}) {
    return this.callMcp("tools/call", { name, arguments: args });
  }

  // Sync, Cluster & Releases ----------------------------------------------------------------------

  syncPull(sinceSeq = 0, limit = 500) {
    return this.json<{ changes: SyncOpWire[]; nextSeq: number }>("/api/sync/pull", {
      method: "POST",
      body: JSON.stringify({ sinceSeq, limit }),
    });
  }

  syncPush(ops: SyncOpWire[]) {
    return this.json<{ applied: number; skipped: number }>("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
  }

  connectSync(opts: Omit<AutoSyncOptions, "wsUrl" | "httpFallback" | "companyId" | "token">): AutoSyncClient {
    const base = this.pickUpstreams()[0]!.url;
    const wsBase = base.replace(/^http/i, "ws");
    const client = new AutoSyncClient({
      ...opts,
      wsUrl: `${wsBase}/v1/sync`,
      companyId: this.companyId,
      token: this.token,
      httpFallback: {
        pull: (sinceSeq) => this.syncPull(sinceSeq),
        push: (ops) => this.syncPush(ops),
      },
    });
    client.connect();
    return client;
  }

  getReleaseManifest() {
    return this.json<Record<string, unknown>>("/releases/manifest.json");
  }
}

export function createAutoClient(config: AutoClientConfig = {}): AutoClient {
  return new AutoClient(config);
}

export function createAutoClientFromEnv(env: Record<string, string | undefined> = process.env): AutoClient {
  const upstreams = env.AUTO_UPSTREAMS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new AutoClient({
    baseUrl: env.AUTO_API_URL,
    upstreams: upstreams?.length ? upstreams : undefined,
    token: env.AUTO_TOKEN,
    companyId: env.AUTO_COMPANY_ID,
    locale: env.AUTO_LOCALE === "fr" ? "fr" : "en",
  });
}

export interface ClientAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export function asAgentTools(client: AutoClient): ClientAgentTool[] {
  return [
    {
      name: "auto_list_documents",
      description: "List invoices, quotes, and credit notes.",
      parameters: { type: "object", properties: { status: { type: "string" }, type: { type: "string" } } },
      execute: (args) => client.listDocuments(args as Parameters<AutoClient["listDocuments"]>[0]),
    },
    {
      name: "auto_create_customer",
      description: "Create a customer record.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          address: { type: "string" },
          taxId: { type: "string" },
          email: { type: "string" },
        },
        required: ["name", "address"],
      },
      execute: (args) => client.createCustomer(args as unknown as Party),
    },
    {
      name: "auto_list_overdue",
      description: "List overdue unpaid invoices.",
      parameters: { type: "object", properties: { asOfDate: { type: "string" } } },
      execute: (args) => client.listOverdue(args.asOfDate as string | undefined),
    },
    {
      name: "auto_search",
      description: "Search across documents, projects, and received invoices.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: (args) => client.searchWorkspace(String(args.query)),
    },
    {
      name: "auto_run_automation",
      description: "Run an automation workflow by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, input: { type: "object" } },
        required: ["id"],
      },
      execute: (args) => client.runAutomation(String(args.id), args.input),
    },
  ];
}

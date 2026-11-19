// Interactive Auto Workspace Web App compiled cleanly by Bun for `/app/`.
import { AutoClient, type AutoSyncClient, AutoApiError } from "@aphrody/auto-client";
import type { Document, DocumentType, LineItem, Party } from "@aphrody/auto-domain";
import type { Locale } from "@aphrody/auto-i18n";

function docTotalInclVatCents(lines: readonly LineItem[]): number {
  let base = 0;
  let vat = 0;
  const byRate = new Map<number, number>();
  for (const l of lines) {
    const net = Math.round((l.quantity * l.unitPriceExclVatCents * (10_000 - (l.discountBp ?? 0))) / 10_000);
    base += net;
    byRate.set(l.vat, (byRate.get(l.vat) ?? 0) + net);
  }
  for (const [rate, b] of byRate) vat += Math.round((b * rate) / 1000);
  return base + vat;
}

const STORAGE_LOCALE = "auto.locale";
const STORAGE_THEME = "auto.theme";
const STORAGE_COMPANY = "auto.companyId";

type TabId = "documents" | "customers" | "accounting" | "automations" | "cluster";

interface AppState {
  locale: Locale;
  frDict: Record<string, string>;
  theme: "light" | "dark";
  tab: TabId;
  mode: "serverless" | "self-hosted";
  version: string;
  user: Record<string, unknown> | null;
  companyId: string;
  documents: Record<string, unknown>[];
  customers: (Party & { id: string })[];
  projects: Record<string, unknown>[];
  automations: Record<string, unknown>[];
  searchQuery: string;
  syncState: string;
  notice: string;
  error: string;
  jwks: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
}

const storedLocale = localStorage.getItem(STORAGE_LOCALE);
const storedTheme = localStorage.getItem(STORAGE_THEME);

const state: AppState = {
  locale: storedLocale === "fr" ? "fr" : "en",
  frDict: {},
  theme:
    storedTheme === "dark" || (!storedTheme && globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches)
      ? "dark"
      : "light",
  tab: "documents",
  mode: "serverless",
  version: "...",
  user: null,
  companyId: localStorage.getItem(STORAGE_COMPANY) ?? "",
  documents: [],
  customers: [],
  projects: [],
  automations: [],
  searchQuery: "",
  syncState: "offline",
  notice: "",
  error: "",
  jwks: null,
  manifest: null,
};

const tr = (text: string): string => (state.locale === "fr" ? (state.frDict[text] ?? text) : text);

async function ensureFrenchCatalog(): Promise<void> {
  if (state.locale !== "fr" || Object.keys(state.frDict).length > 0) return;
  try {
    const res = await fetch("/assets/i18n-fr.json");
    if (res.ok) state.frDict = (await res.json()) as Record<string, string>;
  } catch {}
}

const formatMoneyCents = (cents: number, locale: Locale): string =>
  new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );

const client = new AutoClient({
  baseUrl: globalThis.location.origin,
  credentials: "include",
  token: localStorage.getItem("auto.token") ?? undefined,
  companyId: state.companyId || undefined,
  locale: state.locale,
});

let syncHandle: AutoSyncClient | null = null;
const root = document.getElementById("app-root")!;
const cmdDialog = document.getElementById("cmd-dialog") as HTMLDialogElement | null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((ev: Event) => void) | undefined> = {},
  ...children: (Node | string | number | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else if (typeof v === "string") {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function applyAppearance(): void {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = state.locale;
  client.setLocale(state.locale);
}

function clearFeedback(): void {
  state.error = "";
  state.notice = "";
}

async function refreshWorkspace(): Promise<void> {
  await ensureFrenchCatalog();
  try {
    const h = await client.health();
    state.mode = h.mode === "self-hosted" ? "self-hosted" : "serverless";
    state.version = h.version;
  } catch {
    state.syncState = "offline";
  }

  try {
    const me = await client.me();
    state.user = me.user ?? null;
    const firstCompanyId = (me.companies as { id?: string }[] | undefined)?.[0]?.id;
    const activeCompany = me.companyId ?? firstCompanyId ?? state.companyId;
    if (activeCompany) {
      state.companyId = activeCompany;
      localStorage.setItem(STORAGE_COMPANY, state.companyId);
      client.setAuth(undefined, state.companyId);
    }
  } catch {
    if (!state.user) state.user = null;
  }

  if (state.user && state.companyId) {
    try {
      const [docs, custs, projs, autos] = await Promise.all([
        client.listDocuments(),
        client.listCustomers(),
        client.listProjects(),
        client.listAutomations(),
      ]);
      state.documents = docs;
      state.customers = custs;
      state.projects = projs;
      state.automations = autos;
      connectLiveSync();
    } catch (err) {
      state.error = err instanceof AutoApiError ? err.message : String(err);
    }
  }

  if (state.tab === "cluster") {
    const [jwksRes, manifestRes] = await Promise.all([
      fetch("/.well-known/jwks.json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      client.getReleaseManifest().catch(() => null),
    ]);
    state.jwks = jwksRes as Record<string, unknown> | null;
    state.manifest = manifestRes;
  }

  render();
}

function connectLiveSync(): void {
  if (!state.companyId || syncHandle) return;
  syncHandle = client.connectSync({
    site: "web",
    onStateChange(status) {
      state.syncState = status;
      renderHeaderBadges();
    },
    onRemoteOps() {
      void client.listDocuments().then((docs) => {
        state.documents = docs;
        render();
      });
    },
  });
}

function renderHeaderBadges(): void {
  const syncEl = document.getElementById("sync-pill");
  if (syncEl) {
    syncEl.textContent = `${tr("Sync")}: ${state.syncState}`;
    syncEl.dataset.state = state.syncState;
  }
  const modeEl = document.getElementById("mode-pill");
  if (modeEl) {
    modeEl.textContent = state.mode === "self-hosted" ? tr("Self-Hosted Cluster") : tr("Cloudflare Serverless");
  }
}

async function handleSignInOrUp(mode: "signin" | "signup", form: HTMLFormElement): Promise<void> {
  clearFeedback();
  const data = new FormData(form);
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  const name = String(data.get("name") ?? "").trim();
  const companyName = String(data.get("companyName") ?? "").trim();
  const endpoint = mode === "signup" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
  const body = mode === "signup" ? { email, password, name: name || email.split("@")[0] } : { email, password };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
    }
    const payload = (await res.json().catch(() => ({}))) as { token?: string; user?: Record<string, unknown> };
    if (payload.token) {
      localStorage.setItem("auto.token", payload.token);
      client.setAuth(payload.token, state.companyId || undefined);
    }
    if (payload.user) state.user = payload.user;
    if (mode === "signup" && companyName) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (payload.token) headers.authorization = `Bearer ${payload.token}`;
      const created = await fetch("/v1/companies", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ name: companyName, taxId: "73282932000074", address: "Paris, France" }),
      });
      if (created.ok) {
        const company = (await created.json()) as { id?: string };
        if (company.id) {
          state.companyId = company.id;
          localStorage.setItem(STORAGE_COMPANY, company.id);
          client.setAuth(payload.token, company.id);
        }
      }
    }
    state.notice = tr(mode === "signup" ? "Account ready" : "Signed in");
    await refreshWorkspace();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    render();
  }
}

async function createQuickDoc(kind: DocumentType): Promise<void> {
  clearFeedback();
  const customerName = state.customers[0]?.name ? String(state.customers[0].name) : "Acme Client";
  const today = new Date().toISOString().slice(0, 10);
  const draft: Document = {
    type: kind,
    date: today,
    dueDate: today,
    serviceDate: today,
    issuer: {
      name: "Auto Demo SAS",
      address: "14 Rue de la Paix, 75002 Paris",
      taxId: "73282932000074",
      vatNumber: "FR44732829320",
    },
    customer: { name: customerName, address: "1 Rue Rivoli, 75001 Paris" },
    lines: [
      {
        description: kind === "quote" ? "Cloudflare Edge & LTO Deployment" : "Monthly Platform License",
        quantity: 1,
        unitPriceExclVatCents: 120_000,
        vat: 200,
      },
    ],
  };
  try {
    await client.createDraft(draft, state.customers[0]?.id ? String(state.customers[0].id) : undefined);
    state.notice = tr("Draft saved");
    await refreshWorkspace();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    render();
  }
}

function renderAuthView(): HTMLElement {
  const signinForm = el(
    "form",
    {
      class: "card stack",
      onSubmit(ev) {
        ev.preventDefault();
        void handleSignInOrUp("signin", signinForm);
      },
    },
    el("h2", {}, tr("Sign in")),
    el(
      "label",
      { class: "field" },
      tr("Email"),
      el("input", { name: "email", type: "email", required: true, autocomplete: "email" }),
    ),
    el(
      "label",
      { class: "field" },
      tr("Password"),
      el("input", { name: "password", type: "password", required: true, autocomplete: "current-password" }),
    ),
    el("button", { class: "btn primary", type: "submit" }, tr("Sign in")),
  );

  const signupForm = el(
    "form",
    {
      class: "card stack",
      onSubmit(ev) {
        ev.preventDefault();
        void handleSignInOrUp("signup", signupForm);
      },
    },
    el("h2", {}, tr("Create account")),
    el("label", { class: "field" }, tr("Full name"), el("input", { name: "name", type: "text", required: true })),
    el(
      "label",
      { class: "field" },
      tr("Company name"),
      el("input", { name: "companyName", type: "text", required: true }),
    ),
    el("label", { class: "field" }, tr("Email"), el("input", { name: "email", type: "email", required: true })),
    el(
      "label",
      { class: "field" },
      tr("Password"),
      el("input", { name: "password", type: "password", required: true, minlength: "8" }),
    ),
    el("button", { class: "btn primary", type: "submit" }, tr("Create workspace")),
  );

  return el("div", { class: "grid-2" }, signinForm, signupForm);
}

function renderDocumentsTab(): HTMLElement {
  const filtered = state.documents.filter((row) => {
    const q = state.searchQuery.trim().toLowerCase();
    if (!q) return true;
    return JSON.stringify(row).toLowerCase().includes(q);
  });

  const toolbar = el(
    "div",
    { class: "toolbar" },
    el("input", {
      type: "search",
      value: state.searchQuery,
      placeholder: tr("Search documents, SIRET, projects"),
      "aria-label": tr("Search"),
      onInput(ev) {
        state.searchQuery = (ev.target as HTMLInputElement).value;
        render();
      },
    }),
    el(
      "button",
      { class: "btn primary", type: "button", onClick: () => void createQuickDoc("quote") },
      tr("New Quote"),
    ),
    el(
      "button",
      { class: "btn outline", type: "button", onClick: () => void createQuickDoc("invoice") },
      tr("New Invoice"),
    ),
  );

  if (!filtered.length) {
    return el(
      "section",
      { class: "stack" },
      toolbar,
      el("div", { class: "card empty-state" }, tr("No documents match this filter yet.")),
    );
  }

  const rows = filtered.map((row) => {
    const doc = (row.data as Document | undefined) ?? (row as unknown as Document);
    const id = String(row.id ?? "");
    const status = String(row.status ?? "draft");
    const number = String(row.number ?? tr("Draft"));
    const customer = String(doc?.customer?.name ?? row.customer_name ?? "");
    const totals = doc?.lines ? { totalInclVatCents: docTotalInclVatCents(doc.lines) } : null;
    const totalLabel = totals ? formatMoneyCents(totals.totalInclVatCents, state.locale) : "-";

    const runDocAction = async (fn: () => Promise<unknown>, okLabel: string) => {
      clearFeedback();
      try {
        await fn();
        state.notice = tr(okLabel);
        await refreshWorkspace();
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        render();
      }
    };

    const actions = el(
      "div",
      { class: "row-actions" },
      status === "draft" &&
        el(
          "button",
          {
            class: "btn outline",
            type: "button",
            onClick: () => void runDocAction(() => client.issueDocument(id), "Issued"),
          },
          tr("Issue"),
        ),
      status === "issued" &&
        row.type === "invoice" &&
        el(
          "button",
          {
            class: "btn outline",
            type: "button",
            onClick: () =>
              void runDocAction(
                () =>
                  client.recordPayment(id, {
                    date: new Date().toISOString().slice(0, 10),
                    amountCents: totals?.totalInclVatCents ?? 0,
                    method: "transfer",
                  }),
                "Payment recorded",
              ),
          },
          tr("Record payment"),
        ),
      el(
        "a",
        {
          class: "btn outline",
          href: `/v1/documents/${encodeURIComponent(id)}/pdf`,
          target: "_blank",
          rel: "noopener",
        },
        "Factur-X PDF",
      ),
    );

    return el(
      "tr",
      {},
      el("td", { class: "mono" }, number),
      el("td", {}, String(row.type ?? doc.type ?? "invoice")),
      el("td", {}, customer),
      el("td", { class: "num mono" }, totalLabel),
      el("td", {}, el("span", { class: `badge badge-${status}` }, status)),
      el("td", {}, actions),
    );
  });

  return el(
    "section",
    { class: "stack" },
    toolbar,
    el(
      "div",
      { class: "table-wrap card" },
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, tr("Number")),
            el("th", {}, tr("Type")),
            el("th", {}, tr("Customer")),
            el("th", { class: "num" }, tr("Total incl. VAT")),
            el("th", {}, tr("Status")),
            el("th", {}, tr("Actions")),
          ),
        ),
        el("tbody", {}, ...rows),
      ),
    ),
  );
}

function renderCustomersTab(): HTMLElement {
  const form = el(
    "form",
    {
      class: "card toolbar",
      onSubmit(ev) {
        ev.preventDefault();
        const fd = new FormData(form);
        void client
          .createCustomer({
            name: String(fd.get("name") ?? ""),
            address: String(fd.get("address") ?? "Paris, France"),
            taxId: String(fd.get("taxId") ?? "") || undefined,
          })
          .then(() => refreshWorkspace())
          .catch((e) => {
            state.error = String(e);
            render();
          });
      },
    },
    el("input", { name: "name", placeholder: tr("Customer name"), required: true }),
    el("input", { name: "taxId", placeholder: "SIRET (14 digits)" }),
    el("input", { name: "address", placeholder: tr("Billing address"), required: true }),
    el("button", { class: "btn primary", type: "submit" }, tr("Add customer")),
  );

  const list = el(
    "div",
    { class: "grid-3" },
    ...state.customers.map((c) =>
      el(
        "article",
        { class: "card stack-sm" },
        el("strong", {}, String(c.name ?? "")),
        el("div", { class: "muted mono" }, String(c.taxId ?? "-")),
        el("div", { class: "muted" }, String(c.address ?? "")),
      ),
    ),
  );

  return el("section", { class: "stack" }, form, list);
}

function renderAccountingTab(): HTMLElement {
  const fecPre = el(
    "pre",
    { class: "code-box", id: "fec-preview" },
    tr("Click Export FEC to generate the 18-column accounting ledger."),
  );
  return el(
    "section",
    { class: "stack" },
    el(
      "div",
      { class: "card toolbar" },
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onClick() {
            const year = new Date().getFullYear();
            void client
              .exportFec(`${year}-01-01`, `${year}-12-31`)
              .then((tsv) => {
                fecPre.textContent = tsv || tr("No posted entries in range.");
              })
              .catch((e) => {
                state.error = e instanceof Error ? e.message : String(e);
                render();
              });
          },
        },
        tr("Export FEC (Art. A47 A-1)"),
      ),
      el("span", { class: "muted" }, "Factur-X EN 16931 & Art. 286 CGI immutable SHA-256 chain active."),
    ),
    fecPre,
  );
}

function renderAutomationsTab(): HTMLElement {
  const mcpOut = el("pre", { class: "code-box" }, tr("Run an MCP tool call to inspect live server output."));
  return el(
    "section",
    { class: "stack" },
    el(
      "div",
      { class: "card toolbar" },
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onClick() {
            void client
              .mcpCallTool("list_documents", {})
              .then((res) => {
                mcpOut.textContent = JSON.stringify(res, null, 2);
              })
              .catch((e) => {
                state.error = e instanceof Error ? e.message : String(e);
                render();
              });
          },
        },
        tr("Test MCP Tool (list_documents)"),
      ),
      el(
        "button",
        {
          class: "btn outline",
          type: "button",
          onClick() {
            void client
              .saveAutomation({
                name: "Invoice reminder digest",
                active: true,
                definition: {
                  version: 1,
                  nodes: [
                    { id: "trigger", type: "trigger.manual", config: {} },
                    { id: "digest", type: "transform.map", config: { template: { summary: "Reminder digest ready" } } },
                  ],
                  edges: [{ from: "trigger", to: "digest" }],
                },
              })
              .then(() => refreshWorkspace())
              .catch((e) => {
                state.error = e instanceof Error ? e.message : String(e);
                render();
              });
          },
        },
        tr("Create DAG workflow"),
      ),
    ),
    el(
      "div",
      { class: "grid-3" },
      ...state.automations.map((a) =>
        el(
          "article",
          { class: "card toolbar-between" },
          el("span", {}, String(a.name ?? a.id)),
          el(
            "button",
            {
              class: "btn outline",
              type: "button",
              onClick: () =>
                void client
                  .runAutomation(String(a.id))
                  .then((r) => {
                    mcpOut.textContent = JSON.stringify(r, null, 2);
                  })
                  .catch((e) => {
                    state.error = e instanceof Error ? e.message : String(e);
                    render();
                  }),
            },
            tr("Run"),
          ),
        ),
      ),
    ),
    mcpOut,
  );
}

function renderClusterTab(): HTMLElement {
  return el(
    "section",
    { class: "stack" },
    el(
      "div",
      { class: "grid-2" },
      el(
        "article",
        { class: "card stack-sm" },
        el("h3", {}, "Rust Better Auth JWKS (Ed25519)"),
        el("pre", { class: "code-box" }, JSON.stringify(state.jwks ?? { status: "ready" }, null, 2)),
      ),
      el(
        "article",
        { class: "card stack-sm" },
        el("h3", {}, tr("Signed Release Manifest")),
        el("pre", { class: "code-box" }, JSON.stringify(state.manifest ?? { version: state.version }, null, 2)),
      ),
    ),
  );
}

function render(): void {
  applyAppearance();
  const topControls = el(
    "div",
    { class: "header-controls" },
    el(
      "span",
      { id: "mode-pill", class: "badge" },
      state.mode === "self-hosted" ? tr("Self-Hosted Cluster") : tr("Cloudflare Serverless"),
    ),
    el("span", { id: "sync-pill", class: "badge", "data-state": state.syncState }, `${tr("Sync")}: ${state.syncState}`),
    el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onClick() {
          state.locale = state.locale === "en" ? "fr" : "en";
          localStorage.setItem(STORAGE_LOCALE, state.locale);
          void ensureFrenchCatalog().then(render);
        },
      },
      state.locale.toUpperCase(),
    ),
    el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onClick() {
          state.theme = state.theme === "light" ? "dark" : "light";
          localStorage.setItem(STORAGE_THEME, state.theme);
          render();
        },
      },
      state.theme === "dark" ? tr("Light") : tr("Dark"),
    ),
    el("button", { class: "btn outline", type: "button", onClick: () => cmdDialog?.showModal() }, "Ctrl+K"),
  );

  const tabs: [TabId, string][] = [
    ["documents", tr("Documents")],
    ["customers", tr("Customers")],
    ["accounting", tr("Accounting & FEC")],
    ["automations", tr("Automations")],
    ["cluster", tr("Cluster & Auth")],
  ];

  const navBar = el(
    "nav",
    { class: "workspace-tabs", "aria-label": tr("Workspace sections") },
    ...tabs.map(([id, label]) =>
      el(
        "button",
        {
          class: `btn ${state.tab === id ? "primary" : "outline"}`,
          type: "button",
          "aria-current": state.tab === id ? "page" : undefined,
          onClick() {
            state.tab = id;
            void refreshWorkspace();
          },
        },
        label,
      ),
    ),
  );

  const body = !state.user
    ? renderAuthView()
    : state.tab === "documents"
      ? renderDocumentsTab()
      : state.tab === "customers"
        ? renderCustomersTab()
        : state.tab === "accounting"
          ? renderAccountingTab()
          : state.tab === "automations"
            ? renderAutomationsTab()
            : renderClusterTab();

  root.replaceChildren(
    el("div", { class: "workspace-bar" }, topControls, state.user && navBar),
    state.error && el("div", { class: "alert alert-error", role: "alert" }, state.error),
    state.notice && el("div", { class: "alert alert-info", "aria-live": "polite" }, state.notice),
    body,
  );
}

globalThis.addEventListener("keydown", (ev: KeyboardEvent) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    cmdDialog?.showModal();
  }
});

cmdDialog?.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("[data-cmd-tab]");
  if (!btn) return;
  const target = btn.getAttribute("data-cmd-tab") as TabId;
  state.tab = target;
  cmdDialog.close();
  void refreshWorkspace();
});

render();
void refreshWorkspace();

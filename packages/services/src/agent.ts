// AI Agent tools, Model Context Protocol (MCP) JSON-RPC 2.0 handler, and LLM tool-calling turn loop.
import { fec, paymentEntry, salesEntry } from "@aphrody/auto-domain/accounting";
import type { Document } from "@aphrody/auto-domain";
import { t, type Locale } from "@aphrody/auto-i18n";
import type { Tx } from "@aphrody/auto-platform";
import type { LlmClient, LlmMessage, LlmTool } from "@aphrody/auto-platform/llm";
import {
  createCustomer,
  createDraft,
  createProduct,
  employeeLeaveBalance,
  exportAccountingData,
  issueDocument,
  listAutomations,
  listCustomers,
  listDocuments,
  listEmployees,
  listOverdueDocuments,
  listProducts,
  listProjects,
  listSuppliers,
  recordAutomationRun,
  recordPayment,
  reqCompany,
  requestAbsence,
  saveAutomation,
  saveProject,
  searchWorkspace,
} from "@aphrody/auto-store";
import { executeWorkflow, validateWorkflow, WORKFLOW_NODE_CATALOG } from "./automations";

export interface AgentToolContext {
  tx: Tx;
  actor: string | null;
  locale?: Locale;
}

export interface AutoTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<unknown>;
}

export const AUTO_TOOLS: readonly AutoTool[] = [
  {
    name: "get_company_profile",
    description: "Get the current company profile and tax details.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args, ctx) {
      const id = reqCompany(ctx.tx);
      const [row] =
        await ctx.tx`SELECT id, name, siren, siret, address, vat_number, vat_exempt FROM company_profile WHERE id = ${id}`;
      return row ?? { id };
    },
  },
  {
    name: "list_documents",
    description: "List invoices, quotes, deposits, and credit notes with optional status/type filters.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["quote", "invoice", "deposit", "credit_note"] },
        status: { type: "string" },
        customerId: { type: "string" },
      },
    },
    async execute(args, ctx) {
      return listDocuments(ctx.tx, args as Parameters<typeof listDocuments>[1]);
    },
  },
  {
    name: "create_draft_document",
    description: "Create a new draft invoice or quote.",
    inputSchema: {
      type: "object",
      properties: {
        document: { type: "object" },
        customerId: { type: "string" },
      },
      required: ["document"],
    },
    async execute(args, ctx) {
      return createDraft(ctx.tx, ctx.actor, args.document as Document, (args.customerId as string | undefined) ?? null);
    },
  },
  {
    name: "issue_document",
    description: "Issue a draft document with gapless sequential numbering and immutable audit entry.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async execute(args, ctx) {
      return issueDocument(ctx.tx, ctx.actor, String(args.id), ctx.locale ?? "en");
    },
  },
  {
    name: "record_payment",
    description: "Record a customer payment against an issued invoice.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        date: { type: "string" },
        amountCents: { type: "integer" },
        method: { type: "string", enum: ["transfer", "card", "check", "cash", "direct_debit", "other"] },
        reference: { type: "string" },
      },
      required: ["documentId", "date", "amountCents", "method"],
    },
    async execute(args, ctx) {
      return recordPayment(ctx.tx, ctx.actor, args as Parameters<typeof recordPayment>[2], ctx.locale ?? "en");
    },
  },
  {
    name: "list_overdue_documents",
    description: "List unpaid issued invoices past their due date.",
    inputSchema: { type: "object", properties: { asOfDate: { type: "string" } } },
    async execute(args, ctx) {
      return listOverdueDocuments(ctx.tx, String(args.asOfDate ?? new Date().toISOString().slice(0, 10)));
    },
  },
  {
    name: "list_customers",
    description: "Search customers in the current company.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async execute(args, ctx) {
      return listCustomers(ctx.tx, args.query as string | undefined);
    },
  },
  {
    name: "create_customer",
    description: "Create a customer record.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { type: "string" },
        taxId: { type: "string" },
        email: { type: "string" },
      },
      required: ["name", "address"],
    },
    async execute(args, ctx) {
      return createCustomer(
        ctx.tx,
        ctx.actor,
        args as unknown as Parameters<typeof createCustomer>[2],
        ctx.locale ?? "en",
      );
    },
  },
  {
    name: "list_products",
    description: "List catalog products/services.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      return listProducts(ctx.tx);
    },
  },
  {
    name: "create_product",
    description: "Create a catalog product or service.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        unitPriceExclVatCents: { type: "integer" },
        vat: { type: "number" },
      },
      required: ["description", "unitPriceExclVatCents", "vat"],
    },
    async execute(args, ctx) {
      return createProduct(
        ctx.tx,
        ctx.actor,
        args as unknown as Parameters<typeof createProduct>[2],
        ctx.locale ?? "en",
      );
    },
  },
  {
    name: "list_projects",
    description: "List company projects.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      return listProjects(ctx.tx);
    },
  },
  {
    name: "save_project",
    description: "Create or update a project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        code: { type: "string" },
        address: { type: "string" },
        budgetExclVatCents: { type: "integer" },
        progress: { type: "number" },
        status: { type: "string", enum: ["planned", "active", "completed", "paused"] },
        notes: { type: "string" },
      },
      required: ["name", "code", "status"],
    },
    async execute(args, ctx) {
      const input = args as Partial<Parameters<typeof saveProject>[2]>;
      return saveProject(ctx.tx, ctx.actor, {
        address: "",
        budgetExclVatCents: 0,
        progress: 0,
        notes: "",
        name: String(input.name ?? ""),
        code: String(input.code ?? ""),
        status: input.status ?? "planned",
        ...(input.id ? { id: input.id } : {}),
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.budgetExclVatCents !== undefined ? { budgetExclVatCents: input.budgetExclVatCents } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    },
  },
  {
    name: "list_suppliers",
    description: "List suppliers in the current company.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      return listSuppliers(ctx.tx);
    },
  },
  {
    name: "list_employees",
    description: "List HR employees.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      return listEmployees(ctx.tx);
    },
  },
  {
    name: "request_absence",
    description: "Create an employee absence / paid leave request.",
    inputSchema: {
      type: "object",
      properties: {
        employeeId: { type: "string" },
        type: { type: "string" },
        startDate: { type: "string" },
        endDate: { type: "string" },
      },
      required: ["employeeId", "type", "startDate", "endDate"],
    },
    async execute(args, ctx) {
      return requestAbsence(ctx.tx, ctx.actor, args as Parameters<typeof requestAbsence>[2]);
    },
  },
  {
    name: "employee_leave_balance",
    description: "Calculate accrued and remaining paid leave balance for an employee.",
    inputSchema: {
      type: "object",
      properties: { employeeId: { type: "string" }, asOfDate: { type: "string" } },
      required: ["employeeId"],
    },
    async execute(args, ctx) {
      return employeeLeaveBalance(
        ctx.tx,
        String(args.employeeId),
        String(args.asOfDate ?? new Date().toISOString().slice(0, 10)),
      );
    },
  },
  {
    name: "export_fec",
    description: "Generate balanced French FEC statutory ledger for a date range.",
    inputSchema: {
      type: "object",
      properties: { startDate: { type: "string" }, endDate: { type: "string" } },
      required: ["startDate", "endDate"],
    },
    async execute(args, ctx) {
      const { sales, receipts } = await exportAccountingData(ctx.tx, String(args.startDate), String(args.endDate));
      const lines = [...sales.flatMap((s) => salesEntry(s)), ...receipts.flatMap((r) => paymentEntry(r))];
      return { rows: lines.length, fec: fec(lines) };
    },
  },
  {
    name: "search_workspace",
    description: "Search across documents, received invoices, and projects.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(args, ctx) {
      return searchWorkspace(ctx.tx, String(args.query), ctx.locale ?? "en");
    },
  },
  {
    name: "list_automations",
    description: "List workflows and available node types.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      return { catalog: WORKFLOW_NODE_CATALOG, workflows: await listAutomations(ctx.tx) };
    },
  },
  {
    name: "save_automation",
    description: "Create or update a DAG workflow automation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        active: { type: "boolean" },
        definition: { type: "object" },
      },
      required: ["name", "definition"],
    },
    async execute(args, ctx) {
      const def = validateWorkflow(args.definition);
      return saveAutomation(ctx.tx, ctx.actor, {
        id: args.id as string | undefined,
        name: String(args.name),
        active: Boolean(args.active ?? true),
        definition: def,
      });
    },
  },
  {
    name: "run_automation",
    description: "Execute a saved automation workflow by id with optional JSON input.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, input: { type: "object" } },
      required: ["id"],
    },
    async execute(args, ctx) {
      const all = await listAutomations(ctx.tx);
      const wf = all.find((w) => w.id === args.id);
      if (!wf) throw new Error("Automation not found");
      const def = validateWorkflow(wf.definition);
      const res = await executeWorkflow(def, args.input ?? {}, { tx: ctx.tx });
      await recordAutomationRun(ctx.tx, {
        automationId: wf.id,
        status: res.status,
        triggerType: "agent",
        steps: res.steps,
        output: [res.output],
        error: res.error,
      });
      return res;
    },
  },
] as const;

export function findTool(name: string): AutoTool | undefined {
  return AUTO_TOOLS.find((tool) => tool.name === name);
}

export function asOpenAiTools(): LlmTool[] {
  return AUTO_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export async function handleMcpJsonRpc(
  req: JsonRpcRequest,
  executeFn: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  if (req.method === "notifications/initialized") return null;
  const id = req.id ?? null;
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "auto-mcp", version: "2026.11.5" },
      },
    };
  }
  if (req.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: AUTO_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }
  if (req.method === "tools/call") {
    const name = String(req.params?.name ?? "");
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await executeFn(name, args);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}

export async function runAgentTurn(
  prompt: string,
  opts: {
    llm: LlmClient;
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    history?: LlmMessage[];
    locale?: Locale;
    maxTurns?: number;
  },
): Promise<{ reply: string; messages: LlmMessage[]; toolsCalled: string[] }> {
  const locale = opts.locale ?? "en";
  const messages: LlmMessage[] = [
    ...(opts.history ?? [
      {
        role: "system",
        content: t(locale, "You are the Auto assistant. Use the provided tools accurately and concisely."),
      },
    ]),
    { role: "user", content: prompt },
  ];
  const tools = asOpenAiTools();
  const toolsCalled: string[] = [];
  const limit = opts.maxTurns ?? 8;

  for (let step = 0; step < limit; step++) {
    const res = await opts.llm.complete({ messages, tools });
    messages.push({
      role: "assistant",
      content: res.content,
      ...(res.tool_calls ? { tool_calls: res.tool_calls } : {}),
    });
    if (!res.tool_calls?.length) {
      return { reply: res.content ?? "", messages, toolsCalled };
    }
    for (const call of res.tool_calls) {
      toolsCalled.push(call.function.name);
      let result: unknown;
      try {
        const parsedArgs = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        result = await opts.execute(call.function.name, parsedArgs);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: t(locale, "Maximum tool turns reached."), messages, toolsCalled };
}

// Safe DAG workflow engine for both Cloudflare Workflows and Bun self-hosted workers:
// validates graphs (Kahn topological sort, cycle detection), translates legacy n8n exports,
// runs pure AST/JSON transformations without dynamic eval(), and guards HTTP requests against SSRF.
import { chunkText, nearestVectors, renderPdf } from "@aphrody/auto-native";
import type { Tx } from "@aphrody/auto-platform";
import type { LlmClient } from "@aphrody/auto-platform/llm";
import { listKnowledgeChunks, saveKnowledgeDocument, StoreError } from "@aphrody/auto-store";
import { assertSafeWebhookUrl } from "./events";
import type { Mailer } from "./mail";

export type WorkflowNodeType =
  | "trigger.manual"
  | "trigger.webhook"
  | "trigger.schedule"
  | "trigger.event"
  | "condition.if"
  | "transform.map"
  | "code.run"
  | "http.request"
  | "mail.send"
  | "ai.complete"
  | "knowledge.index"
  | "knowledge.search"
  | "doc.render_pdf"
  | "delay.wait";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label?: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: "true" | "false" | "always";
}

export interface WorkflowDefinition {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowStepResult {
  nodeId: string;
  type: WorkflowNodeType;
  status: "ok" | "skipped" | "error";
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface WorkflowRunResult {
  status: "success" | "error";
  steps: WorkflowStepResult[];
  output: unknown;
  error?: string;
}

export interface WorkflowServices {
  tx?: Tx;
  mailer?: Mailer | null;
  llm?: LlmClient | null;
  fetcher?: typeof fetch;
  allowPrivateUrls?: boolean;
  companyId?: string;
  secrets?: Record<string, string>;
}

export const WORKFLOW_NODE_CATALOG: { type: WorkflowNodeType; category: string; description: string }[] = [
  { type: "trigger.manual", category: "trigger", description: "Start workflow manually via API, UI, or CLI" },
  { type: "trigger.webhook", category: "trigger", description: "Trigger workflow from an HTTP webhook payload" },
  { type: "trigger.schedule", category: "trigger", description: "Trigger workflow on a cron expression" },
  { type: "trigger.event", category: "trigger", description: "Trigger workflow from a domain outbox event" },
  { type: "condition.if", category: "flow", description: "Branch execution using a safe predicate" },
  { type: "transform.map", category: "transform", description: "Project fields using $json / $node paths" },
  { type: "code.run", category: "transform", description: "Safe deterministic expression evaluator (no eval/I/O)" },
  { type: "http.request", category: "network", description: "SSRF-guarded outbound HTTP JSON request" },
  { type: "mail.send", category: "communication", description: "Send email via active tenant/operator mailer" },
  { type: "ai.complete", category: "ai", description: "Complete prompt via configured OpenAI / Workers AI" },
  { type: "knowledge.index", category: "ai", description: "Chunk and store text in workspace knowledge base" },
  { type: "knowledge.search", category: "ai", description: "Search workspace knowledge chunks" },
  { type: "doc.render_pdf", category: "documents", description: "Render a JSON invoice/quote to PDF" },
  { type: "delay.wait", category: "flow", description: "Pause workflow step (bounded in-process or Durable alarm)" },
];

export function resolveTemplatePath(pathExpr: string, scope: Record<string, unknown>): unknown {
  const parts = pathExpr.replace(/^\$?/, "").split(".").filter(Boolean);
  let cur: unknown = scope;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function interpolateObject(
  value: unknown,
  scope: Record<string, unknown>,
  secrets: Record<string, string> = {},
): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([^}]+)\s*\}\}$/.exec(value);
    if (exact) {
      const expr = exact[1]!.trim();
      if (expr.startsWith("$secret.")) return secrets[expr.slice(8)] ?? "";
      return resolveTemplatePath(expr, scope);
    }
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
      const clean = expr.trim();
      if (clean.startsWith("$secret.")) return secrets[clean.slice(8)] ?? "";
      const v = resolveTemplatePath(clean, scope);
      return v === undefined || v === null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateObject(item, scope, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateObject(v, scope, secrets);
    return out;
  }
  return value;
}

function compareCondition(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "contains":
      return String(left ?? "").includes(String(right ?? ""));
    case "exists":
      return left !== undefined && left !== null && left !== "";
    default:
      return Boolean(left);
  }
}

/** Validate DAG structure and return topological node execution order. */
export function topologicalOrder(def: WorkflowDefinition): WorkflowNode[] {
  if (!def || !Array.isArray(def.nodes) || !Array.isArray(def.edges)) {
    throw new StoreError("Workflow definition must include nodes and edges arrays", [], 400);
  }
  const byId = new Map<string, WorkflowNode>();
  for (const node of def.nodes) {
    if (!node.id || !node.type) throw new StoreError("Workflow node requires id and type", [], 400);
    if (byId.has(node.id)) throw new StoreError(`Duplicate workflow node id: ${node.id}`, [], 400);
    byId.set(node.id, node);
  }
  if (!def.nodes.some((n) => n.type.startsWith("trigger."))) {
    throw new StoreError("Workflow requires at least one trigger node", [], 400);
  }

  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of def.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const edge of def.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      throw new StoreError(`Edge references unknown node: ${edge.from} -> ${edge.to}`, [], 400);
    }
    adj.get(edge.from)!.push(edge.to);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }

  const queue = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const ordered: WorkflowNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const next of adj.get(id) ?? []) {
      const deg = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (ordered.length !== def.nodes.length) {
    throw new StoreError("Workflow graph contains a cycle", [], 400);
  }
  return ordered;
}

export function validateWorkflow(raw: unknown): WorkflowDefinition {
  const def = raw as WorkflowDefinition;
  topologicalOrder(def);
  return { version: 1, nodes: def.nodes, edges: def.edges };
}

/** Convert legacy n8n JSON exports (`nodes`, `connections`) into a canonical Auto WorkflowDefinition. */
export function importLegacyN8nWorkflow(raw: {
  nodes?: { id?: string; name: string; type?: string; parameters?: Record<string, unknown> }[];
  connections?: Record<string, { main?: { node: string }[][] }>;
}): WorkflowDefinition {
  const srcNodes = raw.nodes ?? [];
  const nameToId = new Map<string, string>();
  const nodes: WorkflowNode[] = srcNodes.map((n, idx) => {
    const id = n.id || `node_${idx + 1}`;
    nameToId.set(n.name, id);
    const kind = (n.type ?? "").toLowerCase();
    let type: WorkflowNodeType = "transform.map";
    if (kind.includes("webhook")) type = "trigger.webhook";
    else if (kind.includes("cron") || kind.includes("schedule")) type = "trigger.schedule";
    else if (kind.includes("trigger")) type = "trigger.manual";
    else if (kind.includes("httprequest") || kind.includes("http")) type = "http.request";
    else if (kind.includes("code") || kind.includes("function")) type = "code.run";
    else if (kind.includes("if")) type = "condition.if";
    else if (kind.includes("mail") || kind.includes("email")) type = "mail.send";
    return { id, type, label: n.name, config: n.parameters ?? {} };
  });
  const edges: WorkflowEdge[] = [];
  for (const [sourceName, conns] of Object.entries(raw.connections ?? {})) {
    const from = nameToId.get(sourceName);
    if (!from) continue;
    for (const group of conns.main ?? []) {
      for (const target of group) {
        const to = nameToId.get(target.node);
        if (to) edges.push({ from, to });
      }
    }
  }
  return validateWorkflow({ version: 1, nodes, edges });
}

/** Deterministic, sandboxed expression evaluator supporting arithmetic, JSON projection, and field lookups (no eval/Function). */
function evaluateSafeExpression(expr: string, scope: Record<string, unknown>): unknown {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return interpolateObject(JSON.parse(trimmed), scope);
  }
  const addMatch = /^(\$[A-Za-z0-9_.]+)\s*([+\-*])\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (addMatch) {
    const left = Number(resolveTemplatePath(addMatch[1]!, scope) ?? 0);
    const right = Number(addMatch[3]!);
    if (addMatch[2] === "+") return left + right;
    if (addMatch[2] === "-") return left - right;
    return left * right;
  }
  if (trimmed.startsWith("$")) return resolveTemplatePath(trimmed, scope);
  return trimmed;
}

export async function executeWorkflow(
  def: WorkflowDefinition,
  triggerInput: unknown,
  services: WorkflowServices = {},
): Promise<WorkflowRunResult> {
  const ordered = topologicalOrder(def);
  const steps: WorkflowStepResult[] = [];
  const outputs = new Map<string, unknown>();
  const activeBranch = new Set<string>();

  for (const node of ordered) {
    const incomingEdges = def.edges.filter((e) => e.to === node.id);
    if (incomingEdges.length > 0 && !incomingEdges.some((e) => activeBranch.has(`${e.from}:${e.to}`))) {
      steps.push({ nodeId: node.id, type: node.type, status: "skipped", durationMs: 0 });
      continue;
    }

    const start = Date.now();
    const lastOutput = incomingEdges.length ? outputs.get(incomingEdges[0]!.from) : triggerInput;
    const scope: Record<string, unknown> = {
      json: lastOutput ?? triggerInput,
      input: triggerInput,
      node: Object.fromEntries(outputs),
    };

    try {
      const cfg = interpolateObject(node.config, scope, services.secrets) as Record<string, unknown>;
      let out: unknown = lastOutput;
      let passedBranch: "true" | "false" | undefined;

      switch (node.type) {
        case "trigger.manual":
        case "trigger.webhook":
        case "trigger.schedule":
        case "trigger.event":
          out = triggerInput ?? {};
          break;
        case "condition.if": {
          const matched = compareCondition(cfg.left, String(cfg.op ?? "eq"), cfg.right);
          passedBranch = matched ? "true" : "false";
          out = { matched, input: lastOutput };
          break;
        }
        case "transform.map":
          out = cfg.mapping ?? cfg;
          break;
        case "code.run":
          out = evaluateSafeExpression(String(cfg.expression ?? "$json"), scope);
          break;
        case "http.request": {
          const safe = assertSafeWebhookUrl(String(cfg.url ?? ""), services.allowPrivateUrls);
          const method = String(cfg.method ?? "GET").toUpperCase();
          const res = await (services.fetcher ?? fetch)(safe.toString(), {
            method,
            headers: (cfg.headers as Record<string, string> | undefined) ?? { "content-type": "application/json" },
            ...(method !== "GET" && cfg.body !== undefined ? { body: JSON.stringify(cfg.body) } : {}),
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          out = { status: res.status, ok: res.ok, body };
          break;
        }
        case "mail.send": {
          if (!services.mailer) throw new Error("Mailer service unavailable");
          out = await services.mailer.send({
            to: String(cfg.to ?? ""),
            subject: String(cfg.subject ?? "Notification"),
            text: String(cfg.text ?? ""),
          });
          break;
        }
        case "ai.complete": {
          if (!services.llm) throw new Error("LLM service unavailable");
          out = await services.llm.complete({
            messages: [{ role: "user", content: String(cfg.prompt ?? "") }],
          });
          break;
        }
        case "knowledge.index": {
          if (!services.tx) throw new Error("Store transaction unavailable");
          const chunks = chunkText(String(cfg.source ?? node.id), String(cfg.text ?? ""));
          const docId = await saveKnowledgeDocument(
            services.tx,
            String(cfg.source ?? node.id),
            String(cfg.title ?? "Note"),
            chunks,
          );
          out = { docId, chunks: chunks.length };
          break;
        }
        case "knowledge.search": {
          if (!services.tx) throw new Error("Store transaction unavailable");
          const all = await listKnowledgeChunks(services.tx);
          const q = String(cfg.query ?? "").toLowerCase();
          const hits = all.filter((c) => c.content.toLowerCase().includes(q)).slice(0, Number(cfg.limit ?? 5));
          out = { hits, totalIndexed: all.length, vectorsReady: nearestVectors !== undefined };
          break;
        }
        case "doc.render_pdf": {
          const pdf = renderPdf(cfg.document);
          out = { bytesLength: pdf.byteLength };
          break;
        }
        case "delay.wait": {
          const ms = Math.min(2000, Math.max(0, Number(cfg.ms ?? 0)));
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
          out = lastOutput;
          break;
        }
      }

      outputs.set(node.id, out);
      steps.push({ nodeId: node.id, type: node.type, status: "ok", output: out, durationMs: Date.now() - start });
      for (const edge of def.edges.filter((e) => e.from === node.id)) {
        if (!edge.condition || edge.condition === "always" || edge.condition === passedBranch) {
          activeBranch.add(`${edge.from}:${edge.to}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ nodeId: node.id, type: node.type, status: "error", error: msg, durationMs: Date.now() - start });
      return { status: "error", steps, output: null, error: msg };
    }
  }

  const lastOk = [...steps].reverse().find((s) => s.status === "ok");
  return { status: "success", steps, output: lastOk?.output ?? triggerInput };
}

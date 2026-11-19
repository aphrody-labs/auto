// Transactional outbox emission and SSRF-guarded HMAC-SHA256 webhook delivery.
import type { Tx } from "@aphrody/auto-platform";
import { claimOutboxBatch, completeOutbox, enqueueOutbox, reqCompany, StoreError } from "@aphrody/auto-store";

export type EventType =
  | "document.issued"
  | "document.status_changed"
  | "payment.recorded"
  | "absence.requested"
  | "absence.decided"
  | "reminder.due"
  | "einvoice.status"
  | "einvoice.received"
  | "mail.received"
  | "mail.invoice_received"
  | "subscription.renewal_soon"
  | "export.monthly"
  | "invitation.created"
  | `${string}.${string}`;

export interface AutoEvent {
  id: string;
  type: EventType;
  companyId: string;
  occurredAt: string;
  data: unknown;
}

export type EventEmitter = (tx: Tx, type: EventType, data: unknown) => Promise<{ id: string }>;

export const outbox: EventEmitter = (tx, type, data) => enqueueOutbox(tx, type, data);

export const SIGNATURE_HEADER = "x-auto-signature";
export const EVENT_ID_HEADER = "x-auto-event-id";
export const EVENT_TYPE_REGEX = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

const PRIVATE_IP_RE = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd]/i,
  /^\[?fe80:/i,
];

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || PRIVATE_IP_RE.some((re) => re.test(h));
}

/** Validate an outbound webhook URL against SSRF rules. */
export function assertSafeWebhookUrl(
  rawUrl: string,
  allowPrivate = typeof process !== "undefined" && process.env.NODE_ENV !== "production",
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new StoreError("Invalid webhook URL", [], 400);
  }
  if (parsed.username || parsed.password) {
    throw new StoreError("Embedded credentials in URL are forbidden", [], 400);
  }
  const priv = isPrivateHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(allowPrivate && parsed.protocol === "http:")) {
    throw new StoreError("HTTPS URL is required", [], 400);
  }
  if (!allowPrivate && priv) {
    throw new StoreError("Private network URLs are blocked in production", [], 400);
  }
  return parsed;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhookPayload(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, body)}`;
}

export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = await signWebhookPayload(secret, body);
  return timingSafeEqualStr(signatureHeader, expected);
}

export interface WebhookTarget {
  url: string;
  secret: string;
  events?: string[];
  timeoutMs?: number;
}

export async function deliverWebhook(
  target: WebhookTarget,
  eventId: string,
  body: string,
  opts: { allowPrivate?: boolean; signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<void> {
  const safe = assertSafeWebhookUrl(target.url, opts.allowPrivate);
  const signature = await signWebhookPayload(target.secret, body);
  const timeout = AbortSignal.timeout(target.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await (opts.fetcher ?? fetch)(safe.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signature,
      [EVENT_ID_HEADER]: eventId,
    },
    body,
    redirect: "error",
    signal,
  });
  if (!res.ok) throw new Error(`Webhook delivery failed with HTTP ${res.status}`);
}

export function webhookFromEnv(env: Record<string, string | undefined> = process.env): WebhookTarget | null {
  const url = env.AUTO_WEBHOOK_URL ?? env.N8N_WEBHOOK_URL;
  if (!url) return null;
  const secret = env.AUTO_WEBHOOK_SECRET ?? env.N8N_WEBHOOK_SECRET;
  if (!secret) throw new Error("AUTO_WEBHOOK_SECRET is required when AUTO_WEBHOOK_URL is configured");
  return { url, secret };
}

export async function dispatchOutboxBatch(
  tx: Tx,
  extraTargets: WebhookTarget[] = [],
  opts: { limit?: number; allowPrivate?: boolean; fetcher?: typeof fetch } = {},
): Promise<{ delivered: number; failed: number }> {
  const companyId = reqCompany(tx);
  const dbHooks = await tx<{ url: string; secret: string; events_json: string }[]>`
    SELECT url, secret, events_json FROM webhook_endpoint WHERE company_id = ${companyId} AND active = 1`;
  const targets: WebhookTarget[] = [
    ...extraTargets,
    ...dbHooks.map((h) => ({ url: h.url, secret: h.secret, events: JSON.parse(h.events_json) as string[] })),
  ];
  const batch = await claimOutboxBatch(tx, opts.limit ?? 20);
  let delivered = 0;
  let failed = 0;
  for (const item of batch) {
    const payload: AutoEvent = {
      id: item.id,
      type: item.type as EventType,
      companyId,
      occurredAt: new Date().toISOString(),
      data: JSON.parse(item.payload_json),
    };
    const body = JSON.stringify(payload);
    try {
      for (const target of targets) {
        if (target.events && !target.events.includes("*") && !target.events.includes(item.type)) continue;
        await deliverWebhook(target, item.id, body, { allowPrivate: opts.allowPrivate, fetcher: opts.fetcher });
      }
      await completeOutbox(tx, item.id);
      delivered++;
    } catch (err) {
      await completeOutbox(tx, item.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }
  return { delivered, failed };
}

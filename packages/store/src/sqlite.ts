// SQLite utility primitives shared across @aphrody/auto-store (D1, CompanyDO SQLite, bun:sqlite).
import type { Tx } from "@aphrody/auto-platform";

export type CompanyTx = Tx & {
  readonly companyId?: string;
  readonly worker?: boolean;
  readonly mailboxUserId?: string;
};

export class StoreError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    readonly status = 400,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function requireUuid(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new StoreError(`Invalid ${label}`, [], 400);
  }
  return value;
}

export function reqCompany(tx: Tx): string {
  const id = (tx as CompanyTx).companyId;
  if (!id) throw new StoreError("Operation requires a company transaction (withCompany)", [], 500);
  return id;
}

export const asBool = (v: unknown): boolean => v === true || v === 1 || v === "1";
export const asNum = (v: unknown, def = 0): number => (v === null || v === undefined ? def : Number(v));

export function asJson<T>(v: unknown, def?: T): T {
  if (v === null || v === undefined) return def as T;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

export function asBytes(v: unknown): Uint8Array<ArrayBuffer> {
  if (v instanceof Uint8Array) {
    const out = new Uint8Array(v.byteLength);
    out.set(v);
    return out;
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (Array.isArray(v)) return new Uint8Array(v);
  if (typeof v === "string") {
    const raw = atob(v);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  return new Uint8Array();
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function likePattern(query: string): string {
  return `%${query
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, "\\$&")}%`;
}

export function buildSet(values: Record<string, unknown>): { sql: string; params: unknown[] } {
  const cols: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(values)) {
    if (val === undefined) continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`Invalid SQLite column: ${key}`);
    cols.push(`${key} = ?`);
    if (val instanceof Date) params.push(val.toISOString());
    else if (typeof val === "boolean") params.push(val ? 1 : 0);
    else if (val !== null && typeof val === "object" && !(val instanceof Uint8Array) && !(val instanceof ArrayBuffer)) {
      params.push(JSON.stringify(val));
    } else params.push(val);
  }
  return { sql: cols.join(", "), params };
}

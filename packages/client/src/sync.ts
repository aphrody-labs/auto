// Browser/Bun/Edge-compatible Hybrid Logical Clock (HLC) & bidirectional WebSocket/HTTP delta sync client.
export interface ParsedHlc {
  wallMs: number;
  counter: number;
  site: string;
}

export function formatHlc(wallMs: number, counter: number, site: string): string {
  const w = Math.max(0, Math.floor(wallMs)).toString(16).padStart(12, "0");
  const c = Math.max(0, Math.min(0xffff, Math.floor(counter)))
    .toString(16)
    .padStart(4, "0");
  return `${w}-${c}-${site}`;
}

export function parseHlc(hlc: string): ParsedHlc {
  const i1 = hlc.indexOf("-");
  const i2 = hlc.indexOf("-", i1 + 1);
  if (i1 <= 0 || i2 <= i1 + 1) return { wallMs: 0, counter: 0, site: hlc };
  return {
    wallMs: Number.parseInt(hlc.slice(0, i1), 16) || 0,
    counter: Number.parseInt(hlc.slice(i1 + 1, i2), 16) || 0,
    site: hlc.slice(i2 + 1),
  };
}

export function tickHlc(prevHlc: string | null, site: string, nowMs = Date.now()): string {
  const prev = prevHlc ? parseHlc(prevHlc) : { wallMs: 0, counter: 0, site };
  if (nowMs > prev.wallMs) return formatHlc(nowMs, 0, site);
  return formatHlc(prev.wallMs, prev.counter + 1, site);
}

export function mergeHlc(localHlc: string | null, remoteHlc: string, site: string, nowMs = Date.now()): string {
  const l = localHlc ? parseHlc(localHlc) : { wallMs: 0, counter: 0, site };
  const r = parseHlc(remoteHlc);
  const wall = Math.max(nowMs, l.wallMs, r.wallMs);
  if (wall === l.wallMs && wall === r.wallMs) return formatHlc(wall, Math.max(l.counter, r.counter) + 1, site);
  if (wall === l.wallMs) return formatHlc(wall, l.counter + 1, site);
  if (wall === r.wallMs) return formatHlc(wall, r.counter + 1, site);
  return formatHlc(wall, 0, site);
}

export interface SyncOpWire {
  tableName: string;
  pk: string;
  op: "upsert" | "delete";
  columns: Record<string, unknown>;
  hlc: string;
  site: string;
}

export type WsSyncWire =
  | { type: "hello"; site: string; sinceSeq: number; lastHlc?: string }
  | { type: "ops"; ops: SyncOpWire[]; nextSeq?: number }
  | { type: "ack"; applied: number; latestHlc: string }
  | { type: "pull"; sinceSeq: number }
  | { type: "error"; message: string };

export interface AutoSyncOptions {
  wsUrl: string;
  site: string;
  companyId?: string;
  token?: string;
  initialSeq?: number;
  initialHlc?: string | null;
  onRemoteOps: (ops: SyncOpWire[]) => Promise<void> | void;
  onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
  httpFallback?: {
    pull: (sinceSeq: number) => Promise<{ changes: SyncOpWire[]; nextSeq: number }>;
    push: (ops: SyncOpWire[]) => Promise<{ applied: number; skipped: number }>;
  };
}

export class AutoSyncClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private queue: SyncOpWire[] = [];
  private seq: number;
  private lastHlc: string | null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: AutoSyncOptions) {
    this.seq = opts.initialSeq ?? 0;
    this.lastHlc = opts.initialHlc ?? null;
  }

  get currentHlc(): string | null {
    return this.lastHlc;
  }

  get currentSeq(): number {
    return this.seq;
  }

  connect(): void {
    if (this.closed) return;
    this.opts.onStateChange?.("connecting");
    const url = new URL(this.opts.wsUrl);
    if (this.opts.companyId) url.searchParams.set("companyId", this.opts.companyId);
    if (this.opts.token) url.searchParams.set("token", this.opts.token);

    const sock = new WebSocket(url.toString());
    this.ws = sock;

    sock.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.opts.onStateChange?.("connected");
      const hello: WsSyncWire = {
        type: "hello",
        site: this.opts.site,
        sinceSeq: this.seq,
        ...(this.lastHlc ? { lastHlc: this.lastHlc } : {}),
      };
      sock.send(JSON.stringify(hello));
      if (this.queue.length) {
        const pending = this.queue.splice(0, this.queue.length);
        sock.send(JSON.stringify({ type: "ops", ops: pending } satisfies WsSyncWire));
      }
    });

    sock.addEventListener("message", async (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsSyncWire;
        if (msg.type === "ops" && msg.ops.length) {
          for (const op of msg.ops) {
            this.lastHlc = mergeHlc(this.lastHlc, op.hlc, this.opts.site);
          }
          if (msg.nextSeq !== undefined && msg.nextSeq > this.seq) {
            this.seq = msg.nextSeq;
          }
          await this.opts.onRemoteOps(msg.ops);
        } else if (msg.type === "ack" && msg.latestHlc) {
          this.lastHlc = mergeHlc(this.lastHlc, msg.latestHlc, this.opts.site);
        }
      } catch {
        // Ignore malformed sync frame
      }
    });

    sock.addEventListener("close", () => {
      this.ws = null;
      this.opts.onStateChange?.("disconnected");
      if (!this.closed) {
        const delayMs = Math.min(15_000, 300 * 2 ** this.reconnectAttempt++);
        this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
      }
    });
  }

  enqueueLocal(op: Omit<SyncOpWire, "hlc" | "site">): SyncOpWire {
    this.lastHlc = tickHlc(this.lastHlc, this.opts.site);
    const full: SyncOpWire = { ...op, hlc: this.lastHlc, site: this.opts.site };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ops", ops: [full] } satisfies WsSyncWire));
    } else {
      this.queue.push(full);
    }
    return full;
  }

  async flushViaHttp(): Promise<void> {
    if (!this.opts.httpFallback) return;
    if (this.queue.length) {
      const pending = this.queue.splice(0, this.queue.length);
      try {
        await this.opts.httpFallback.push(pending);
      } catch (err) {
        this.queue.unshift(...pending);
        throw err;
      }
    }
    const pulled = await this.opts.httpFallback.pull(this.seq);
    if (pulled.changes.length) {
      for (const op of pulled.changes) this.lastHlc = mergeHlc(this.lastHlc, op.hlc, this.opts.site);
      this.seq = pulled.nextSeq;
      await this.opts.onRemoteOps(pulled.changes);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

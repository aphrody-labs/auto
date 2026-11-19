// Hybrid Logical Clock (HLC) and bidirectional SQLite delta synchronization (`_changes` + SHA-256 blobs).
import type { Tx } from "@aphrody/auto-platform";
import { asJson, nowIso, StoreError } from "./sqlite";

export interface SyncChange {
  seq?: number;
  tableName: string;
  pk: string;
  op: "upsert" | "delete";
  columns: Record<string, unknown>;
  hlc: string;
  site: string;
  createdAt?: string;
}

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
  const idx1 = hlc.indexOf("-");
  const idx2 = hlc.indexOf("-", idx1 + 1);
  if (idx1 <= 0 || idx2 <= idx1 + 1) {
    return { wallMs: 0, counter: 0, site: hlc };
  }
  const wallMs = Number.parseInt(hlc.slice(0, idx1), 16) || 0;
  const counter = Number.parseInt(hlc.slice(idx1 + 1, idx2), 16) || 0;
  return { wallMs, counter, site: hlc.slice(idx2 + 1) };
}

export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : 1;
}

export function nextHlc(prevHlc: string | null | undefined, site: string, physicalNowMs = Date.now()): string {
  const prev = prevHlc ? parseHlc(prevHlc) : { wallMs: 0, counter: 0, site };
  if (physicalNowMs > prev.wallMs) {
    return formatHlc(physicalNowMs, 0, site);
  }
  return formatHlc(prev.wallMs, prev.counter + 1, site);
}

export function mergeHlc(
  localHlc: string | null | undefined,
  remoteHlc: string,
  localSite: string,
  physicalNowMs = Date.now(),
): string {
  const local = localHlc ? parseHlc(localHlc) : { wallMs: 0, counter: 0, site: localSite };
  const remote = parseHlc(remoteHlc);
  const maxWall = Math.max(physicalNowMs, local.wallMs, remote.wallMs);
  if (maxWall === local.wallMs && maxWall === remote.wallMs) {
    return formatHlc(maxWall, Math.max(local.counter, remote.counter) + 1, localSite);
  }
  if (maxWall === local.wallMs) {
    return formatHlc(maxWall, local.counter + 1, localSite);
  }
  if (maxWall === remote.wallMs) {
    return formatHlc(maxWall, remote.counter + 1, localSite);
  }
  return formatHlc(maxWall, 0, localSite);
}

export async function tickHlc(tx: Tx, site: string, remoteHlc?: string): Promise<string> {
  const [row] = await tx<{ value: string }[]>`SELECT value FROM _sync_state WHERE key = ${"last_hlc"}`;
  const next = remoteHlc ? mergeHlc(row?.value, remoteHlc, site) : nextHlc(row?.value, site);
  await tx`INSERT INTO _sync_state (key, value) VALUES (${"last_hlc"}, ${next})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  return next;
}

export async function recordChange(
  tx: Tx,
  tableName: string,
  pk: string,
  op: "upsert" | "delete",
  columns: Record<string, unknown>,
  site: string,
  hlc?: string,
): Promise<string> {
  const clock = hlc ?? (await tickHlc(tx, site));
  await tx`INSERT INTO _changes (table_name, pk, op, columns, hlc, site)
    VALUES (${tableName}, ${pk}, ${op}, ${JSON.stringify(columns)}, ${clock}, ${site})`;
  return clock;
}

export async function pullChanges(
  tx: Tx,
  sinceSeq = 0,
  limit = 500,
): Promise<{ changes: SyncChange[]; nextSeq: number }> {
  const safeLimit = Math.max(1, Math.min(2000, limit));
  const rows = await tx<
    {
      seq: number;
      table_name: string;
      pk: string;
      op: "upsert" | "delete";
      columns: string;
      hlc: string;
      site: string;
      created_at: string;
    }[]
  >`SELECT seq, table_name, pk, op, columns, hlc, site, created_at FROM _changes
    WHERE seq > ${sinceSeq} ORDER BY seq ASC LIMIT ${safeLimit}`;

  const changes: SyncChange[] = rows.map((r) => ({
    seq: r.seq,
    tableName: r.table_name,
    pk: r.pk,
    op: r.op,
    columns: asJson<Record<string, unknown>>(r.columns, {}),
    hlc: r.hlc,
    site: r.site,
    createdAt: r.created_at,
  }));
  const nextSeq = rows.length ? rows[rows.length - 1]!.seq : sinceSeq;
  return { changes, nextSeq };
}

interface SyncTableSpec {
  pkColumn: string;
  columns: readonly string[];
}

const REPLICABLE_TABLES: Record<string, SyncTableSpec> = {
  customer: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "name",
      "tax_id",
      "address",
      "vat_number",
      "email",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  supplier: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "name",
      "address",
      "tax_id",
      "vat_number",
      "email",
      "phone",
      "contact",
      "notes",
      "archived",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  product: {
    pkColumn: "id",
    columns: ["id", "company_id", "description", "unit_price_excl_vat_cents", "vat", "unit", "updated_at", "_deleted"],
  },
  project: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "name",
      "code",
      "customer_id",
      "address",
      "budget_excl_vat_cents",
      "progress",
      "status",
      "start_date",
      "end_date",
      "notes",
      "archived",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  document: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "type",
      "status",
      "number",
      "series",
      "year",
      "seq",
      "customer_id",
      "data",
      "excl_vat_cents",
      "vat_cents",
      "incl_vat_cents",
      "portal_token",
      "issued_at",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  employee: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "last_name",
      "first_name",
      "email",
      "role",
      "contract",
      "start_date",
      "end_date",
      "working_time_percent",
      "gross_monthly_salary_cents",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  absence: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "employee_id",
      "type",
      "start_date",
      "end_date",
      "days",
      "status",
      "notes",
      "decided_at",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  automation: {
    pkColumn: "id",
    columns: [
      "id",
      "company_id",
      "name",
      "active",
      "version",
      "definition_json",
      "created_at",
      "updated_at",
      "_deleted",
    ],
  },
  template_config: {
    pkColumn: "company_id",
    columns: ["company_id", "color", "logo_mime", "logo_data_base64", "footer", "updated_at", "_deleted"],
  },
};

export async function applyRemoteChanges(
  tx: Tx,
  localSite: string,
  changes: readonly SyncChange[],
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const ch of changes) {
    const spec = REPLICABLE_TABLES[ch.tableName];
    if (!spec) {
      skipped++;
      continue;
    }

    await tickHlc(tx, localSite, ch.hlc);

    if (tx.exec) {
      const existing = await tx.exec<{ _hlc: string; status?: string }[]>(
        ch.tableName === "document"
          ? `SELECT _hlc, status FROM "${ch.tableName}" WHERE "${spec.pkColumn}" = ?`
          : `SELECT _hlc FROM "${ch.tableName}" WHERE "${spec.pkColumn}" = ?`,
        [ch.pk],
      );
      const localRow = existing[0];
      if (localRow && compareHlc(ch.hlc, localRow._hlc) <= 0) {
        skipped++;
        continue;
      }

      if (ch.op === "delete") {
        if (ch.tableName === "document" && localRow?.status && localRow.status !== "draft") {
          skipped++;
          continue;
        }
        await tx.exec(`UPDATE "${ch.tableName}" SET _deleted = 1, _hlc = ?, _site = ? WHERE "${spec.pkColumn}" = ?`, [
          ch.hlc,
          ch.site,
          ch.pk,
        ]);
        applied++;
        continue;
      }

      if (ch.tableName === "document" && localRow?.status && localRow.status !== "draft") {
        const nextStatus = typeof ch.columns.status === "string" ? ch.columns.status : localRow.status;
        await tx.exec(`UPDATE document SET status = ?, updated_at = ?, _hlc = ?, _site = ? WHERE id = ?`, [
          nextStatus,
          nowIso(),
          ch.hlc,
          ch.site,
          ch.pk,
        ]);
        applied++;
        continue;
      }

      const payload: Record<string, unknown> = {};
      for (const col of spec.columns) {
        if (col in ch.columns) payload[col] = ch.columns[col];
      }
      payload[spec.pkColumn] = payload[spec.pkColumn] ?? ch.pk;
      payload._hlc = ch.hlc;
      payload._site = ch.site;

      const keys = Object.keys(payload);
      const placeholders = keys.map(() => "?").join(", ");
      const colList = keys.map((k) => `"${k}"`).join(", ");
      const updateSet = keys
        .filter((k) => k !== spec.pkColumn)
        .map((k) => `"${k}" = excluded."${k}"`)
        .join(", ");
      const vals = keys.map((k) => {
        const v = payload[k];
        if (typeof v === "boolean") return v ? 1 : 0;
        if (v !== null && typeof v === "object") return JSON.stringify(v);
        return v ?? null;
      });

      await tx.exec(
        `INSERT INTO "${ch.tableName}" (${colList}) VALUES (${placeholders})
         ON CONFLICT ("${spec.pkColumn}") DO UPDATE SET ${updateSet}`,
        vals,
      );
      applied++;
    } else {
      throw new StoreError("SQLite adapter missing exec() for sync merge", [], 500);
    }
  }

  return { applied, skipped };
}

export async function diffBlobManifest(
  tx: Tx,
  remoteBlobs: readonly { key: string; sha256: string }[],
): Promise<{ missingLocal: string[]; extraRemote: string[] }> {
  const local = await tx<{ sha256: string; blob_key: string | null }[]>`
    SELECT sha256, blob_key FROM artifact WHERE blob_key IS NOT NULL
    UNION ALL
    SELECT sha256, blob_key FROM stored_file
  `;
  const localBySha = new Set(local.map((r) => r.sha256));
  const remoteBySha = new Set(remoteBlobs.map((r) => r.sha256));
  return {
    missingLocal: remoteBlobs.filter((r) => !localBySha.has(r.sha256)).map((r) => r.key),
    extraRemote: local.filter((l) => l.blob_key && !remoteBySha.has(l.sha256)).map((l) => l.blob_key!),
  };
}

import { expect, test } from "bun:test";
import { asAgentTools, AutoApiError, createAutoClient, type WsSyncWire } from "./index";

test("AutoClient failover load balancing across upstreams and typed requests", async () => {
  let primaryCalls = 0;
  let secondaryCalls = 0;

  const primary = Bun.serve({
    port: 0,
    fetch() {
      primaryCalls++;
      return Response.json({ error: "bad gateway" }, { status: 502 });
    },
  });
  const secondary = Bun.serve({
    port: 0,
    async fetch(req) {
      secondaryCalls++;
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          mode: "self-hosted",
          version: "2026.11.5",
          timestamp: "2026-11-18T00:00:00Z",
        });
      }
      if (url.pathname === "/v1/customers" && req.method === "POST") {
        const body = (await req.json()) as { name: string; address: string };
        return Response.json({ id: "c_1", ...body });
      }
      if (url.pathname === "/v1/error") {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  try {
    const client = createAutoClient({
      upstreams: [primary.url.origin, secondary.url.origin],
      strategy: "failover",
      token: "auto_tok_123",
      companyId: "comp_1",
    });

    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(1);

    // Primary is now circuit-broken for 10s, so subsequent call goes directly to secondary
    const tools = asAgentTools(client);
    const createCust = tools.find((t) => t.name === "auto_create_customer")!;
    const created = (await createCust.execute({ name: "Acme", address: "Paris" })) as { id: string; name: string };
    expect(created.id).toBe("c_1");
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(2);

    await expect(client.lookupDirectory("123")).rejects.toBeInstanceOf(AutoApiError);
  } finally {
    await primary.stop(true);
    await secondary.stop(true);
  }
});

test("AutoSyncClient WebSocket HLC convergence and offline outbox flush", async () => {
  const receivedByServer: unknown[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("ok");
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as WsSyncWire;
        if (msg.type === "hello") {
          ws.send(
            JSON.stringify({
              type: "ops",
              nextSeq: 12,
              ops: [
                {
                  tableName: "customer",
                  pk: "c_remote",
                  op: "upsert",
                  columns: { name: "Remote SAS" },
                  hlc: "019a95000000-0001-cloud",
                  site: "cloud",
                },
              ],
            } satisfies WsSyncWire),
          );
        } else if (msg.type === "ops") {
          receivedByServer.push(...msg.ops);
          ws.send(
            JSON.stringify({ type: "ack", applied: msg.ops.length, latestHlc: msg.ops[0]!.hlc } satisfies WsSyncWire),
          );
        }
      },
    },
  });

  const appliedRemotes: string[] = [];
  try {
    const client = createAutoClient({ baseUrl: srv.url.origin, companyId: "comp_1", token: "auto_tok" });
    const sync = client.connectSync({
      site: "desktop-1",
      onRemoteOps(ops) {
        for (const op of ops) appliedRemotes.push(op.pk);
      },
    });
    sync.enqueueLocal({ tableName: "customer", pk: "c_local", op: "upsert", columns: { name: "Local" } });
    await Bun.sleep(150);
    sync.close();
    expect(appliedRemotes).toEqual(["c_remote"]);
    expect(receivedByServer).toHaveLength(1);
    expect(sync.currentSeq).toBe(12);
    expect(sync.currentHlc).toBeTruthy();
  } finally {
    await srv.stop(true);
  }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  bacMock,
  b2brouter,
  chiffrer,
  dechiffrer,
  ENTETE_B2BROUTER,
  hmac,
  plateforme,
  sirenValide,
  STATUTS,
  type IdentifiantsB2brouter,
} from "./index";

const MAITRE = "m".repeat(32);
const PDF = new TextEncoder().encode("%PDF-1.7 factur-x");

test("statuts XP Z12-012 : codes 200 à 214", () => {
  expect(STATUTS.deposee).toBe(200);
  expect(STATUTS.refusee).toBe(210);
  expect(STATUTS.encaissee).toBe(212);
  expect(STATUTS.rejetee).toBe(213);
});

test("chiffrement AES-GCM par tenant", async () => {
  const c = await chiffrer(MAITRE, "t1", { cleApi: "secret" });
  expect(new TextDecoder().decode(c)).not.toContain("secret");
  expect(await dechiffrer(MAITRE, "t1", c)).toEqual({ cleApi: "secret" });
  // Autre tenant, autre secret maître ou chiffré altéré : refus.
  await expect(dechiffrer(MAITRE, "t2", c)).rejects.toThrow();
  await expect(dechiffrer("x".repeat(32), "t1", c)).rejects.toThrow();
  const altere = c.slice();
  altere[20]! ^= 1;
  await expect(dechiffrer(MAITRE, "t1", altere)).rejects.toThrow();
  await expect(chiffrer("court", "t1", {})).rejects.toThrow("32 caractères");
});

test("mock déterministe : dépôt, doublon, rejet, statuts, entrantes, annuaire, webhook", async () => {
  bacMock.vider("c1");
  const horloge = () => new Date("2026-10-22T10:00:00Z");
  const p = plateforme("mock", { compte: "c1", secretWebhook: "s" }, { horloge });
  const d = await p.deposer({ facturx: PDF, numero: "F-2026-0001" });
  expect(d).toEqual({ idPa: "MOCK-000001", statut: "deposee", motif: undefined });
  expect((await p.deposer({ facturx: PDF, numero: "F-2026-0001" })).motif).toBe("DOUBLON");
  expect((await p.deposer({ facturx: new Uint8Array([1]), numero: "X" })).statut).toBe("rejetee");

  bacMock.avancer("c1", d.idPa, "refusee", "2026-10-23T00:00:00.000Z", "CMD_ERR");
  await p.signaler(d.idPa, "encaissee");
  expect((await p.statuts(d.idPa)).map((s) => s.statut)).toEqual(["deposee", "refusee", "encaissee"]);

  const e = bacMock.livrer("c1", PDF, "2026-10-24T00:00:00.000Z");
  expect(await p.entrantes("2026-10-24")).toEqual([{ idPa: e.idPa, date: "2026-10-24T00:00:00.000Z" }]);
  expect(await p.entrantes("2026-10-25")).toEqual([]);
  expect(await p.telecharger(e.idPa)).toEqual(PDF);

  expect(sirenValide("732829320")).toBe(true);
  expect(await p.annuaire("732829320")).toEqual({ siren: "732829320", plateforme: "mock" });
  expect(await p.annuaire("123456789")).toBeNull();
  expect((await p.ereporting({ nature: "b2c", periode: "2026-10", lignes: [] })).statut).toBe("deposee");
  const m = { siren: "732829320", signataire: "A", qualite: "gérant", date: "2026-10-22", perimetre: [] };
  expect((await p.mandater(m)).reference).toBe("MOCK-MANDAT-732829320-2026-10-22");

  const w = bacMock.webhook("s", [e]);
  expect(await p.webhook(w.corps, new Headers(w.entetes))).toEqual([e]);
  expect(await p.webhook(w.corps + " ", new Headers(w.entetes))).toBeNull();
  expect(await p.webhook(w.corps, new Headers())).toBeNull();
});

// Serveur Bun.serve qui simule l'API B2Brouter (chemins et formats de la documentation publique).
let api: ReturnType<typeof Bun.serve>;
const recu: {
  methode: string;
  chemin: string;
  cle: string | null;
  version: string | null;
  mime: string | null;
  corps?: string;
}[] = [];
let sondages = 0;

beforeAll(() => {
  const trace = async (req: Request) => {
    const u = new URL(req.url);
    recu.push({
      methode: req.method,
      chemin: u.pathname + u.search,
      cle: req.headers.get("x-b2b-api-key"),
      version: req.headers.get("x-b2b-api-version"),
      mime: req.headers.get("content-type"),
      corps: req.method === "POST" ? await req.text() : undefined,
    });
    if (req.headers.get("x-b2b-api-key") !== "test_cle")
      throw Response.json({ error: "unauthorized" }, { status: 401 });
  };
  const route =
    (fn: (req: Request & { params: Record<string, string> }) => Response | Promise<Response>) =>
    async (req: Request & { params: Record<string, string> }) => {
      try {
        await trace(req);
        return await fn(req);
      } catch (r) {
        if (r instanceof Response) return r;
        throw r;
      }
    };
  api = Bun.serve({
    port: 0,
    routes: {
      "/accounts/:a/invoices/import": {
        POST: route(() => Response.json({ invoice: { id: 85373, state: "sending" } }, { status: 201 })),
      },
      "/invoices/:id": {
        GET: route((req) =>
          req.params.id === "85373"
            ? Response.json({ invoice: { id: 85373, state: "paid", state_updated_at: "2026-10-25T08:00:00Z" } })
            : Response.json({ error: "not found" }, { status: 404 }),
        ),
      },
      "/invoices/:id/mark_as": { POST: route(() => Response.json({ invoice: { id: 85373, state: "paid" } })) },
      "/invoices/:id/as/original": {
        GET: route(() => new Response(PDF, { headers: { "content-type": "application/pdf" } })),
      },
      "/accounts/:a/invoices": {
        GET: route(() =>
          Response.json({
            invoices: [{ id: 9001, type: "ReceivedInvoice", created_at: "2026-10-24T09:00:00Z" }],
            meta: { total_count: 1, offset: 0, limit: 500 },
          }),
        ),
      },
      "/directory/0002/:siren": {
        GET: route((req) => {
          if (req.params.siren === "999999999") return Response.json({ error: "not found" }, { status: 404 });
          if (sondages++ === 0)
            return Response.json(
              { status: "pending", message: "lookup", polling_url: `${api.url}directory/0002/${req.params.siren}` },
              { status: 202 },
            );
          return Response.json({ name: "Client SAS", information_flags: [] });
        }),
      },
      "/accounts/:a/ledgers/import": {
        POST: route(() => Response.json({ ledger: { id: 42, type: "DgfipFlux10", state: "new" } }, { status: 201 })),
      },
    },
    fetch: () => new Response("404", { status: 404 }),
  });
});

afterAll(() => api.stop(true));

const IDS: IdentifiantsB2brouter = { cleApi: "test_cle", compte: "78234", secretWebhook: "whsec" };
const maintenant = new Date("2026-10-25T08:00:00Z");
const b2b = (ids = IDS) =>
  plateforme("b2brouter", ids, { horloge: () => maintenant, b2brouter: { base: api.url.href, attenteMs: 1 } });

test("B2Brouter désactivé sans identifiants", () => {
  expect(() => b2b({ cleApi: "", compte: "1", secretWebhook: "s" })).toThrow("désactivé");
});

test("B2Brouter : dépôt, statuts, mark_as, réception, annuaire, e-reporting", async () => {
  const p = b2b();
  const d = await p.deposer({ facturx: PDF, numero: "F-2026-0001" });
  expect(d).toEqual({ idPa: "85373", statut: "deposee" });
  const depot = recu.find((r) => r.chemin.startsWith("/accounts/78234/invoices/import"))!;
  expect(depot.chemin).toContain("send_after_import=true");
  expect(depot.cle).toBe("test_cle");
  expect(depot.version).toBe("2026-06-26");
  expect(depot.corps).toBe("%PDF-1.7 factur-x");
  expect(depot.mime).toBe("application/pdf");

  expect(await p.statuts("85373")).toEqual([{ idPa: "85373", statut: "encaissee", date: "2026-10-25T08:00:00.000Z" }]);
  await expect(p.statuts("1")).rejects.toThrow("introuvable");
  await p.signaler("85373", "encaissee");
  expect(JSON.parse(recu.find((r) => r.chemin.endsWith("/mark_as"))!.corps!)).toEqual({ state: "paid", reason: null });
  await expect(p.signaler("85373", "deposee")).rejects.toThrow("non transmissible");

  expect(await p.entrantes("2026-10-24T00:00:00Z")).toEqual([{ idPa: "9001", date: "2026-10-24T09:00:00Z" }]);
  expect(
    recu.some((r) => r.chemin.includes("type=ReceivedInvoice") && r.chemin.includes("updated_at_from=2026-10-24")),
  ).toBe(true);
  expect(await p.telecharger("9001")).toEqual(PDF);

  expect(await p.annuaire("732829320")).toEqual({ siren: "732829320", nom: "Client SAS", plateforme: null });
  expect(sondages).toBe(2);
  expect(await p.annuaire("999999999")).toBeNull();

  await expect(
    p.ereporting({
      nature: "b2c",
      periode: "2026-10",
      lignes: [{ tva: 200, htCents: 10000, tvaCents: 2000 }],
    }),
  ).rejects.toMatchObject({ status: 503 });
  expect(recu.some((r) => r.chemin.endsWith("/ledgers/import"))).toBe(false);

  await expect(b2b({ ...IDS, cleApi: "mauvaise" }).deposer({ facturx: PDF, numero: "F" })).rejects.toThrow("HTTP 401");
});

test("B2Brouter : statuts alignés sur le cycle de vie France documenté", async () => {
  for (const [state, statut] of [
    ["sent", "deposee"],
    ["registered", "recue"],
    ["read", "prise_en_charge"],
  ] as const) {
    const p = b2brouter(IDS, {
      horloge: () => maintenant,
      fetch: (async () => Response.json({ invoice: { state } })) as unknown as typeof fetch,
    });
    expect(await p.statuts("1")).toEqual([{ idPa: "1", statut, date: maintenant.toISOString() }]);
  }
});

test("B2Brouter : le suivi d'annuaire et les redirections ne divulguent pas la clé", async () => {
  let fuites = 0;
  const tiers = Bun.serve({
    port: 0,
    fetch: () => {
      fuites++;
      return Response.json({ name: "tiers" });
    },
  });
  let redirection = false;
  const source = Bun.serve({
    port: 0,
    fetch: () =>
      redirection ? Response.redirect(tiers.url, 302) : Response.json({ polling_url: tiers.url.href }, { status: 202 }),
  });
  try {
    const p = b2brouter(IDS, { base: source.url.href, attenteMs: 0 });
    await expect(p.annuaire("732829320")).rejects.toThrow("origine autorisée");
    redirection = true;
    await expect(p.annuaire("732829320")).rejects.toThrow();
    expect(fuites).toBe(0);
  } finally {
    await source.stop(true);
    await tiers.stop(true);
  }
});

test("B2Brouter : webhook signé t=…,s=… (HMAC-SHA256 de « t.corps »)", async () => {
  const p = b2b();
  const t = Math.floor(maintenant.getTime() / 1000);
  const corps = JSON.stringify({
    code: "issued_invoice.state_change",
    triggered_at: t,
    data: { account_id: 78234, invoice_id: 85373, event_id: 1, state: "refused", notes: "CMD_ERR" },
  });
  const h = (sig: string) => new Headers({ [ENTETE_B2BROUTER]: sig });
  expect(await p.webhook(corps, h(`t=${t},s=${hmac("whsec", `${t}.${corps}`)}`))).toEqual([
    { type: "statut", idPa: "85373", statut: "refusee", date: maintenant.toISOString(), motif: "CMD_ERR" },
  ]);
  expect(await p.webhook(corps, h(`t=${t},s=${hmac("autre", `${t}.${corps}`)}`))).toBeNull();
  // Horodatage hors tolérance : rejeu refusé.
  const vieux = t - 3600;
  expect(await p.webhook(corps, h(`t=${vieux},s=${hmac("whsec", `${vieux}.${corps}`)}`))).toBeNull();

  const recue = JSON.stringify({ code: "received_invoice.created", triggered_at: t, data: { invoice_id: 9001 } });
  expect(await p.webhook(recue, h(`t=${t},s=${hmac("whsec", `${t}.${recue}`)}`))).toEqual([
    { type: "recue", idPa: "9001", date: maintenant.toISOString() },
  ]);
});

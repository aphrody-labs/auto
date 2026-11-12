import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let stripe: ReturnType<typeof Bun.serve>;
const evenements: { type: string; data: unknown }[] = [];
const sessions = new Map<string, { montant: number; doc: string; tenant: string; paye: boolean }>();
let cleRecue = "";

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  // Faux Stripe : compte, création et lecture de sessions Checkout.
  stripe = Bun.serve({
    port: 0,
    routes: {
      "/v1/account": (req) => {
        cleRecue = req.headers.get("authorization") ?? "";
        return cleRecue.endsWith("refusee0000")
          ? Response.json({ error: { message: "Invalid API Key" } }, { status: 401 })
          : Response.json({ id: "acct_1" });
      },
      "/v1/checkout/sessions": {
        POST: async (req) => {
          const f = new URLSearchParams(await req.text());
          const id = `cs_test_${sessions.size + 1}`;
          sessions.set(id, {
            montant: Number(f.get("line_items[0][price_data][unit_amount]")),
            doc: f.get("client_reference_id")!,
            tenant: f.get("metadata[tenant_id]")!,
            paye: false,
          });
          return Response.json({ id, url: `https://checkout.stripe.test/${id}` });
        },
      },
      "/v1/checkout/sessions/:id": (req) => {
        const s = sessions.get(req.params.id);
        if (!s) return Response.json({ error: { message: "No such session" } }, { status: 404 });
        return Response.json({
          payment_status: s.paye ? "paid" : "unpaid",
          amount_total: s.montant,
          currency: "eur",
          client_reference_id: s.doc,
          metadata: { tenant_id: s.tenant, document_id: s.doc },
        });
      },
    },
  });
  Bun.env.AUTO_STRIPE_API = stripe.url.toString();
  const routes = creerApp(sql, async (_tx, type, data) => {
    evenements.push({ type, data });
    return { id: crypto.randomUUID() };
  });
  server = Bun.serve({ port: 0, routes, fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  delete Bun.env.AUTO_STRIPE_API;
  await server.stop(true);
  await stripe.stop(true);
  await drop();
});

async function api(path: string, token?: string, body?: unknown, method?: string) {
  const res = await fetch(new URL(path, server.url), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { status: res.status, body: t && res.headers.get("content-type")?.includes("json") ? JSON.parse(t) : t };
}

test("paiement en ligne : clé vérifiée, session du reste dû, confirmation unique, facture soldée", async () => {
  const a = await api("/v1/auth/inscription", undefined, {
    email: "vendeur@exemple.fr",
    motDePasse: "un mot de passe long",
    entreprise: { nom: "Atelier Morel", siret: "73282932000074", adresse: "1 rue A, Paris" },
  });
  const s = a.body.session as string;
  const d = await api("/v1/documents", s, {
    type: "facture",
    client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 100000, tva: 200 }],
    datePrestation: "2026-10-15",
    echeance: "2026-11-21",
  });
  await api(`/v1/documents/${d.body.id}/emettre`, s, {});
  await api(`/v1/documents/${d.body.id}/paiements`, s, { date: "2026-10-20", montantCents: 20000, mode: "virement" });

  // Sans clé : pas de lien de paiement.
  expect((await api(`/v1/documents/${d.body.id}/lien-paiement`, s, {})).status).toBe(409);
  expect((await api("/v1/parametres/encaissement", s, { cle: "pas-une-cle" }, "PUT")).status).toBe(422);
  expect((await api("/v1/parametres/encaissement", s, { cle: "sk_test_refusee0000" }, "PUT")).status).toBe(502);
  expect((await api("/v1/parametres/encaissement", s, { cle: "sk_test_abcdefghij1234" }, "PUT")).status).toBe(204);
  expect(cleRecue).toBe("Bearer sk_test_abcdefghij1234");
  const etat = await api("/v1/parametres/encaissement", s);
  expect(etat.body).toEqual({ actif: true, fournisseur: "stripe", apercu: "…1234" });
  expect(JSON.stringify(await sql`SELECT cle_chiffree FROM encaissement`)).not.toContain("abcdefghij");

  const l = await api(`/v1/documents/${d.body.id}/lien-paiement`, s, {});
  expect(l.status).toBe(201);
  const v = await api(`/v1/public/factures/${l.body.jeton}`);
  expect(v.body).toMatchObject({ emetteur: "Atelier Morel", resteCents: 100000, payable: true });

  const p = await api(`/v1/public/factures/${l.body.jeton}/paiement`, undefined, {});
  expect(p.body.url).toStartWith("https://checkout.stripe.test/cs_test_");
  const id = p.body.url.split("/").at(-1)!;
  expect(sessions.get(id)!.montant).toBe(100000); // reste dû, pas le TTC

  // Retour sans paiement : rien n'est enregistré.
  const nonPaye = await api(`/v1/public/factures/${l.body.jeton}/confirmation`, undefined, { session: id });
  expect(nonPaye.body).toMatchObject({ enregistre: false, resteCents: 100000 });

  sessions.get(id)!.paye = true;
  const ok = await api(`/v1/public/factures/${l.body.jeton}/confirmation`, undefined, { session: id });
  expect(ok.body).toMatchObject({ enregistre: true, resteCents: 0, statut: "paye", payable: false });
  expect(evenements.at(-1)).toMatchObject({ type: "paiement.enregistre", data: { mode: "carte", canal: "en_ligne" } });
  const rejoue = await api(`/v1/public/factures/${l.body.jeton}/confirmation`, undefined, { session: id });
  expect(rejoue.body).toMatchObject({ enregistre: false, resteCents: 0 });
  const paiements = await api(`/v1/documents/${d.body.id}/paiements`, s);
  expect(paiements.body.paiements ?? paiements.body).toHaveLength(2);

  // Session d'une autre facture ou inventée : refusée.
  expect((await api(`/v1/public/factures/${l.body.jeton}/confirmation`, undefined, { session: "cs_x" })).status).toBe(
    502,
  );
  expect((await api("/v1/parametres/encaissement", s, undefined, "DELETE")).status).toBe(204);
});

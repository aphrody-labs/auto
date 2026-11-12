// Better Auth de bout en bout par HTTP : routes /api/auth (session, bearer, organisation, clés d'API,
// limitation de débit), serveur MCP distant protégé par OAuth 2.1 (inscription dynamique du client, PKCE,
// consentement, jeton lié à l'entreprise), isolation de deux entreprises en REST et en MCP.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "./app";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

const vide = () => Response.json({ erreur: "route inconnue" }, { status: 404 });

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  // L'origine publique doit être connue de Better Auth (émetteur OAuth, ressource /mcp) : port d'abord.
  server = Bun.serve({ port: 0, fetch: vide });
  base = server.url.origin;
  server.reload({ routes: creerApp(sql, undefined, { auth: { baseURL: base } }), fetch: vide });
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

const MDP = "un mot de passe long";

async function http(chemin: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", base);
  const res = await fetch(new URL(chemin, base), {
    ...init,
    headers,
    redirect: "manual",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const texte = await res.text();
  let corps: any = null;
  try {
    corps = texte ? JSON.parse(texte) : null;
  } catch {
    corps = texte;
  }
  return { status: res.status, headers: res.headers, corps };
}

const cookieDe = (h: Headers) =>
  h
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");

async function entreprise(email: string, nom: string) {
  const r = await http("/v1/auth/inscription", {
    method: "POST",
    json: { email, motDePasse: MDP, entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Lyon" } },
  });
  expect(r.status).toBe(201);
  return { ...(r.corps as { userId: string; tenantId: string; session: string }), cookie: cookieDe(r.headers) };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test("routes Better Auth : connexion, session par cookie et par bearer, organisation active, clé d'API", async () => {
  const a = await entreprise("ba@alpha.fr", "Alpha");
  expect((await http("/api/auth/ok")).corps).toEqual({ ok: true });

  // Connexion directe par Better Auth : cookie et jeton (plugin bearer).
  const s = await http("/api/auth/sign-in/email", { method: "POST", json: { email: "ba@alpha.fr", password: MDP } });
  expect(s.status).toBe(200);
  expect(s.headers.getSetCookie().join()).toContain("auto.session_token=");
  const jeton = s.headers.get("set-auth-token")!;
  expect(jeton).toBeTruthy();
  const session = await http("/api/auth/get-session", { headers: bearer(jeton) });
  expect(session.corps.user.email).toBe("ba@alpha.fr");
  expect(session.corps.session.activeOrganizationId).toBe(a.tenantId);
  expect((await http("/v1/moi", { headers: bearer(jeton) })).corps.tenantId).toBe(a.tenantId);
  expect((await http("/v1/moi", { headers: { cookie: cookieDe(s.headers) } })).status).toBe(200);

  // Organisation : liste, membres, rôle personnalisé du contrôle d'accès.
  const orgs = await http("/api/auth/organization/list", { headers: bearer(jeton) });
  expect(orgs.corps.map((o: { id: string; name: string }) => o.name)).toEqual(["Alpha"]);
  const perm = await http("/api/auth/organization/has-permission", {
    method: "POST",
    headers: bearer(jeton),
    json: { permissions: { auto: ["rh"], apiKey: ["create"] } },
  });
  expect(perm.corps.success).toBe(true);

  // Clé d'API d'entreprise créée par le client Better Auth, utilisée par x-api-key et par Bearer.
  const k = await http("/api/auth/api-key/create", {
    method: "POST",
    headers: bearer(jeton),
    json: { name: "client", organizationId: a.tenantId, metadata: { userId: a.userId } },
  });
  expect(k.status).toBe(200);
  expect(k.corps.key).toStartWith("auto_");
  expect((await http("/v1/moi", { headers: { "x-api-key": k.corps.key } })).corps.role).toBe("owner");
  expect((await http("/v1/moi", { headers: bearer(k.corps.key) })).corps.tenantId).toBe(a.tenantId);

  // Déconnexion : le jeton ne sert plus.
  await http("/api/auth/sign-out", { method: "POST", headers: bearer(jeton), json: {} });
  expect((await http("/v1/moi", { headers: bearer(jeton) })).status).toBe(401);
});

test("limitation de débit des connexions (activée comme en production)", async () => {
  const s = Bun.serve({ port: 0, fetch: vide });
  const { sql: sql2, drop: drop2 } = await testDb();
  s.reload({ routes: creerApp(sql2, undefined, { auth: { baseURL: s.url.origin, limiteDebit: true } }), fetch: vide });
  try {
    const statuts: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await fetch(new URL("/api/auth/sign-in/email", s.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin: s.url.origin },
        body: JSON.stringify({ email: "inconnu@x.fr", password: "mauvais mot de passe" }),
      });
      statuts.push(r.status);
    }
    expect(statuts.slice(0, 5).every((x) => x === 401)).toBe(true);
    expect(statuts.at(-1)).toBe(429);
  } finally {
    await s.stop(true);
    await drop2();
  }
});

/** PKCE (RFC 7636) : vérificateur aléatoire, défi S256. */
async function pkce() {
  const verificateur = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
  const empreinte = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verificateur)));
  return { verificateur, defi: empreinte.toBase64({ alphabet: "base64url", omitPadding: true }) };
}

/** Client MCP de test : découverte, inscription dynamique, autorisation PKCE, consentement, jeton. */
async function jetonMcp(cookie: string) {
  // Sans jeton : 401 et défi RFC 9728 qui désigne les métadonnées de la ressource.
  const refus = await http("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "ping" } });
  expect(refus.status).toBe(401);
  expect(refus.headers.get("www-authenticate")).toContain("resource_metadata=");

  const ressource = await http("/.well-known/oauth-protected-resource/mcp");
  expect(ressource.corps.resource).toBe(`${base}/mcp`);
  const serveurAuth = await http(
    `/.well-known/oauth-authorization-server${new URL(ressource.corps.authorization_servers[0]).pathname}`,
  );
  const meta = serveurAuth.corps as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    code_challenge_methods_supported: string[];
  };
  expect(meta.code_challenge_methods_supported).toContain("S256");

  const retour = "http://127.0.0.1:48123/callback";
  const inscrit = await http(meta.registration_endpoint, {
    method: "POST",
    json: {
      client_name: "Client MCP de test",
      application_type: "native",
      redirect_uris: [retour],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(inscrit.status).toBe(201);
  const clientId = inscrit.corps.client_id as string;

  const { verificateur, defi } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: retour,
    scope: "openid profile email offline_access",
    state: "etat-123",
    code_challenge: defi,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  });
  const auto = await http(`${meta.authorization_endpoint}?${q}`, { headers: { cookie } });
  expect(auto.status).toBe(302);
  const consentement = new URL(auto.headers.get("location")!, base);
  expect(consentement.pathname).toBe("/app/autorisation");
  expect(consentement.searchParams.get("client_id")).toBe(clientId);

  const accord = await http("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { cookie },
    json: { accept: true, oauth_query: consentement.search.slice(1) },
  });
  expect(accord.status).toBe(200);
  const rappel = new URL(accord.corps.url as string);
  expect(`${rappel.origin}${rappel.pathname}`).toBe(retour);
  expect(rappel.searchParams.get("state")).toBe("etat-123");

  const jeton = await http(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: rappel.searchParams.get("code")!,
      redirect_uri: retour,
      client_id: clientId,
      code_verifier: verificateur,
      resource: `${base}/mcp`,
    }).toString(),
  });
  expect(jeton.status).toBe(200);
  expect(jeton.corps.token_type.toLowerCase()).toBe("bearer");
  expect(jeton.corps.refresh_token).toBeTruthy();
  return jeton.corps.access_token as string;
}

async function mcp(jeton: string, method: string, params: object = {}) {
  const r = await http("/mcp", {
    method: "POST",
    headers: bearer(jeton),
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
  expect(r.status).toBe(200);
  return r.corps.result;
}

test("MCP distant : OAuth de bout en bout, outils, isolation de deux entreprises", async () => {
  const a = await entreprise("mcp@alpha.fr", "Alpha MCP");
  const b = await entreprise("mcp@beta.fr", "Beta MCP");
  const d = await http("/v1/documents", {
    method: "POST",
    headers: bearer(a.session),
    json: {
      type: "devis",
      client: { nom: "Client SAS", adresse: "2 rue B, Lyon" },
      lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 50000, tva: 200 }],
    },
  });
  expect(d.status).toBe(201);

  const ja = await jetonMcp(a.cookie);
  const jb = await jetonMcp(b.cookie);

  const init = await mcp(ja, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  expect(init.serverInfo.name).toBe("auto");
  const outils = await mcp(ja, "tools/list");
  expect(outils.tools.map((o: { name: string }) => o.name)).toContain("lister_documents");
  const notif = await http("/mcp", {
    method: "POST",
    headers: bearer(ja),
    json: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(notif.status).toBe(202);

  // A voit son devis ; B, avec son propre jeton, ne le voit ni ne le lit.
  const listeA = await mcp(ja, "tools/call", { name: "lister_documents", arguments: {} });
  expect(listeA.isError).toBe(false);
  expect(listeA.content[0].text).toContain(d.corps.id);
  const listeB = await mcp(jb, "tools/call", { name: "lister_documents", arguments: {} });
  expect(listeB.content[0].text).not.toContain(d.corps.id);
  const lectureB = await mcp(jb, "tools/call", { name: "lire_document", arguments: { id: d.corps.id } });
  expect(lectureB.isError).toBe(true);

  // Le jeton OAuth vaut aussi pour le REST, avec la même entreprise et le même rôle.
  expect((await http("/v1/moi", { headers: bearer(ja) })).corps).toMatchObject({ tenantId: a.tenantId, role: "owner" });
  expect((await http(`/v1/documents/${d.corps.id}`, { headers: bearer(jb) })).status).toBe(404);

  // Jeton altéré ou membre retiré : refusé.
  expect(
    (await http("/mcp", { method: "POST", headers: bearer(`${ja}x`), json: { jsonrpc: "2.0", id: 2, method: "ping" } }))
      .status,
  ).toBe(401);
  await sql`UPDATE tenant SET suspendu_at = now() WHERE id = ${a.tenantId}`;
  expect(
    (await http("/mcp", { method: "POST", headers: bearer(ja), json: { jsonrpc: "2.0", id: 3, method: "ping" } }))
      .status,
  ).toBe(403);
  await sql`UPDATE tenant SET suspendu_at = NULL WHERE id = ${a.tenantId}`;
});

test("REST : isolation de deux entreprises par session, clé d'API et invitation", async () => {
  const a = await entreprise("iso@alpha.fr", "Iso A");
  const b = await entreprise("iso@beta.fr", "Iso B");
  const cle = (await http("/v1/jetons", { method: "POST", headers: bearer(a.session), json: { nom: "n8n" } })).corps
    .jeton;
  const doc = await http("/v1/documents", {
    method: "POST",
    headers: bearer(cle),
    json: {
      type: "devis",
      client: { nom: "Client", adresse: "1 rue" },
      lignes: [{ designation: "X", quantite: 1, prixUnitaireHtCents: 100, tva: 200 }],
    },
  });
  expect(doc.status).toBe(201);
  expect((await http(`/v1/documents/${doc.corps.id}`, { headers: bearer(b.session) })).status).toBe(404);
  expect((await http("/v1/jetons", { headers: bearer(b.session) })).corps).toEqual([]);
  const jetonsA = (await http("/v1/jetons", { headers: bearer(a.session) })).corps;
  expect((await http(`/v1/jetons/${jetonsA[0].id}`, { method: "DELETE", headers: bearer(b.session) })).status).toBe(
    404,
  );

  // B invite le propriétaire de A : après acceptation, il choisit son entreprise active.
  const inv = await http("/v1/invitations", {
    method: "POST",
    headers: bearer(b.session),
    json: { email: "iso@alpha.fr", role: "lecture" },
  });
  expect(inv.status).toBe(201);
  const acc = await http("/api/auth/organization/accept-invitation", {
    method: "POST",
    headers: bearer(a.session),
    json: { invitationId: inv.corps.id },
  });
  expect(acc.status).toBe(200);
  expect((await http("/v1/moi", { headers: bearer(a.session) })).corps.entreprises).toHaveLength(2);
  await http("/api/auth/organization/set-active", {
    method: "POST",
    headers: bearer(a.session),
    json: { organizationId: b.tenantId },
  });
  const moi = (await http("/v1/moi", { headers: bearer(a.session) })).corps;
  expect(moi).toMatchObject({ tenantId: b.tenantId, role: "lecture" });
  expect((await http(`/v1/documents/${doc.corps.id}`, { headers: bearer(a.session) })).status).toBe(404);
  expect((await http("/v1/documents", { method: "POST", headers: bearer(a.session), json: {} })).status).toBe(403);
});

test("plugin admin : opérateur (owner du tenant opérateur), liste des comptes, bannissement", async () => {
  const o = await entreprise("op@aphrody.fr", "Opérateur");
  const c = await entreprise("client@gamma.fr", "Gamma");
  const { synchroniserOperateurs } = await import("@auto/tenancy");
  await synchroniserOperateurs(sql, o.tenantId);
  expect((await http("/api/auth/admin/list-users", { headers: bearer(c.session) })).status).toBe(403);
  const liste = await http("/api/auth/admin/list-users?limit=100", { headers: bearer(o.session) });
  expect(liste.status).toBe(200);
  expect(liste.corps.users.map((u: { email: string }) => u.email)).toContain("client@gamma.fr");
  const ban = await http("/api/auth/admin/ban-user", {
    method: "POST",
    headers: bearer(o.session),
    json: { userId: c.userId, banReason: "impayé" },
  });
  expect(ban.status).toBe(200);
  // Sessions révoquées par le bannissement, nouvelle connexion refusée.
  expect((await http("/v1/moi", { headers: bearer(c.session) })).status).toBe(401);
  const r = await http("/v1/auth/connexion", { method: "POST", json: { email: "client@gamma.fr", motDePasse: MDP } });
  expect(r.status).toBe(403);
});

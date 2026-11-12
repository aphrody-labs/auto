import { beforeAll, afterAll, expect, test } from "bun:test";
import { testDb, type Sql } from "@auto/store";
import { creerApp } from "../app";
let sql: Sql, drop: () => Promise<void>, server: ReturnType<typeof Bun.serve>, cookieA: string, cookieB: string;
const avantAppareil = Bun.env.AUTO_CONNEXION_APPAREIL;
async function api(path: string, body?: unknown, cookie = "") {
  const r = await fetch(new URL("/api/auth" + path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
const poll = (device: string, client = "auto-native") =>
  api("/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device,
    client_id: client,
  });
beforeAll(async () => {
  Bun.env.AUTO_CONNEXION_APPAREIL = "1";
  ({ sql, drop } = await testDb());
  server = Bun.serve({
    port: 0,
    routes: creerApp(sql, undefined, {
      auth: { limiteDebit: false, secret: "secret-test-device-flow-0123456789abcdef" },
    }),
    fetch: () => new Response("404", { status: 404 }),
  });
  const creer = async (email: string) => {
    const r = await api("/sign-up/email", { email, password: "mot-de-passe-test-appareil", name: "Appareil QA" });
    if (r.status !== 200) throw Error("Inscription QA échouée");
    return r.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
  };
  cookieA = await creer("device-a@example.test");
  cookieB = await creer("device-b@example.test");
}, 30000);
afterAll(async () => {
  if (avantAppareil === undefined) delete Bun.env.AUTO_CONNEXION_APPAREIL;
  else Bun.env.AUTO_CONNEXION_APPAREIL = avantAppareil;
  await server?.stop(true);
  await drop?.();
});
test("Appareil : client autorisé, attente/poll borné, approbation liée et cookie HttpOnly sans jeton URL", async () => {
  expect((await api("/device/code", { client_id: "inconnu" })).status).toBe(400);
  const c = await api("/device/code", { client_id: "auto-native" });
  expect(c.status).toBe(200);
  expect(c.body.device_code.length).toBeGreaterThanOrEqual(40);
  expect(c.body.expires_in).toBe(600);
  expect(c.body.interval).toBe(5);
  const url = new URL(c.body.verification_uri_complete);
  expect(url.pathname).toBe("/app/verification-appareil");
  expect(url.searchParams.get("user_code")).toBe(c.body.user_code);
  expect(url.href).not.toContain(c.body.device_code);
  expect((await poll(c.body.device_code)).body.error).toBe("authorization_pending");
  expect((await poll(c.body.device_code)).body.error).toBe("slow_down");
  expect((await api("/device/approve", { userCode: c.body.user_code })).status).toBe(401);
  expect((await api(`/device?user_code=${c.body.user_code}`, undefined, cookieA)).status).toBe(200);
  expect((await api("/device/approve", { userCode: c.body.user_code }, cookieB)).status).toBeGreaterThanOrEqual(400);
  expect((await api("/device/approve", { userCode: c.body.user_code }, cookieA)).status).toBe(200);
  await sql`UPDATE device_code SET last_polled_at=now()-interval '1 minute' WHERE device_code=${c.body.device_code}`;
  expect((await poll(c.body.device_code, "autre-client")).status).toBe(400);
  await sql`UPDATE device_code SET last_polled_at=now()-interval '1 minute' WHERE device_code=${c.body.device_code}`;
  const token = await poll(c.body.device_code);
  expect(token.status).toBe(200);
  const cookies = token.headers.getSetCookie();
  expect(cookies.some((x) => x.includes("session_token=") && /httponly/i.test(x))).toBe(true);
  const session = await api("/get-session", undefined, cookies.map((x) => x.split(";")[0]).join("; "));
  expect(session.body.user.email).toBe("device-a@example.test");
  expect((await poll(c.body.device_code)).status).toBe(400);
});
test("Appareil : refus et expiration ne créent aucune session", async () => {
  const c = (await api("/device/code", { client_id: "auto-native" })).body;
  await api(`/device?user_code=${c.user_code}`, undefined, cookieA);
  expect((await api("/device/deny", { userCode: c.user_code }, cookieA)).status).toBe(200);
  const refuse = await poll(c.device_code);
  expect(refuse.body.error).toBe("access_denied");
  expect(refuse.headers.getSetCookie().some((x) => x.includes("session_token="))).toBe(false);
  const expire = (await api("/device/code", { client_id: "auto-native" })).body;
  await sql`UPDATE device_code SET expires_at=now()-interval '1 second' WHERE device_code=${expire.device_code}`;
  expect((await poll(expire.device_code)).body.error).toBe("expired_token");
});
test("Appareil : une approbation ne peut être consommée que par un seul poll concurrent", async () => {
  const c = (await api("/device/code", { client_id: "auto-native" })).body;
  await api(`/device?user_code=${c.user_code}`, undefined, cookieA);
  await api("/device/approve", { userCode: c.user_code }, cookieA);
  const resultats = await Promise.all([poll(c.device_code), poll(c.device_code)]);
  expect(resultats.filter((r) => r.status === 200).length).toBe(1);
  expect(resultats.filter((r) => r.headers.getSetCookie().some((c) => c.includes("session_token="))).length).toBe(1);
});

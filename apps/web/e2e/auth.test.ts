// Authentification dans Chrome (Better Auth par le proxy du front) : connexion avec second facteur, sécurité du
// compte, invitation reçue par mail puis acceptée, consentement OAuth d'un client MCP de test.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { brancherEnvoyeur, depuisBase32, totp, type MessageMail } from "@auto/tenancy";
import { chrome, demarrerBanc, MDP, type Banc } from "./support";

const executable = chrome();
let b: Banc;
const boite: MessageMail[] = [];

beforeAll(async () => {
  if (!executable) return;
  b = await demarrerBanc(executable);
  brancherEnvoyeur(async (m) => {
    boite.push(m);
  });
}, 60_000);
afterAll(async () => {
  await b?.arreter();
}, 30_000);

const json = (session: string) => ({ "content-type": "application/json", authorization: `Bearer ${session}` });

test.skipIf(!executable)(
  "connexion avec double authentification, puis sécurité du compte",
  async () => {
    const s = await b.inscrire("2fa@exemple.fr", "Atelier 2FA");
    const api = (c: string, corps: unknown) =>
      fetch(new URL(c, b.api.url), { method: "POST", headers: json(s), body: JSON.stringify(corps) }).then((r) =>
        r.json(),
      );
    const e = (await api("/v1/2fa/enrolement", { motDePasse: MDP })) as { secret: string };
    const brut = depuisBase32(e.secret);
    await api("/v1/2fa/confirmation", { code: await totp(brut) });

    const ctx = await b.navigateur.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR" });
    const page = await ctx.newPage();
    await page.goto(b.url("/app/connexion"));
    await page.getByLabel("E-mail").fill("2fa@exemple.fr");
    await page.getByLabel("Mot de passe").fill(MDP);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("heading", { name: "Double authentification" }).waitFor();
    await page.getByLabel("Code").fill("000000");
    await page.getByRole("button", { name: "Valider" }).click();
    await page.getByText("Code invalide.").waitFor();
    await page.getByLabel("Code").fill(await totp(brut));
    await page.getByRole("button", { name: "Valider" }).click();
    await page.waitForURL((u) => u.pathname === "/app");

    await page.goto(b.url("/app/parametres"));
    await page.getByRole("heading", { name: "Sécurité" }).waitFor();
    await page.getByText("Active : un code de votre application").waitFor();
    await page.getByRole("heading", { name: "Sessions actives" }).waitFor();
    await page.getByText("cette session").waitFor();
    await ctx.close();
  },
  90_000,
);

test.skipIf(!executable)(
  "invitation envoyée depuis les paramètres, acceptée par le lien reçu",
  async () => {
    const s = await b.inscrire("patron@exemple.fr", "Atelier Equipe");
    const ctx = await b.connecte(s);
    const page = await ctx.newPage();
    await page.goto(b.url("/app/parametres"));
    await page.getByRole("heading", { name: "Membres" }).waitFor();
    await page.getByText("patron@exemple.fr").waitFor();
    const form = page.locator("form", { has: page.getByRole("heading", { name: "Inviter un membre" }) });
    await form.getByLabel("E-mail").fill("recrue@exemple.fr");
    await form.getByLabel("Rôle").selectOption("rh");
    await form.getByRole("button", { name: "Inviter" }).click();
    await page.getByText("Invitation envoyée à recrue@exemple.fr").waitFor();
    const lien = boite.findLast((m) => m.a === "recrue@exemple.fr")!.donnees.lien!;
    expect(new URL(lien).pathname).toBe("/app/invitation");
    await ctx.close();

    const invite = await b.navigateur.newContext({ viewport: { width: 375, height: 800 }, locale: "fr-FR" });
    const p = await invite.newPage();
    await p.goto(lien);
    await p.getByRole("heading", { name: "Rejoindre une entreprise" }).waitFor();
    await p.getByLabel("Mot de passe").fill(MDP);
    await p.getByRole("button", { name: "Rejoindre" }).click();
    await p.waitForURL((u) => u.pathname === "/app");
    // Rôle rh : les employés sont accessibles, pas les paramètres de l'entreprise.
    const moi = await p.evaluate(() => fetch("/v1/moi").then((r) => r.json()));
    expect(moi).toMatchObject({ role: "rh", email: "recrue@exemple.fr", entreprise: { nom: "Atelier Equipe" } });
    await invite.close();
  },
  90_000,
);

test.skipIf(!executable)(
  "consentement OAuth d'un client MCP : choix de l'entreprise, retour au client avec un code",
  async () => {
    const s = await b.inscrire("oauth@exemple.fr", "Atelier OAuth");
    const base = b.web.url.origin;
    const retour = "http://127.0.0.1:48124/callback";
    const client = await fetch(new URL("/api/auth/oauth2/register", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude de test",
        application_type: "native",
        redirect_uris: [retour],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    }).then((r) => r.json() as Promise<{ client_id: string }>);
    const ctx = await b.connecte(s);
    const page = await ctx.newPage();
    // Le navigateur ne suit pas la redirection finale vers le client : elle est capturée ici.
    const { promise: rappel, resolve } = Promise.withResolvers<string>();
    await page.route("http://127.0.0.1:48124/**", (r) => {
      resolve(r.request().url());
      return r.fulfill({ body: "ok" });
    });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: retour,
      scope: "openid profile",
      state: "s1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: `${base}/mcp`,
    });
    await page.goto(`${base}/api/auth/oauth2/authorize?${q}`);
    await page.getByRole("heading", { name: "Autoriser Claude de test" }).waitFor();
    await page.getByLabel("Entreprise").waitFor();
    await page.getByRole("button", { name: "Autoriser" }).click();
    const u = new URL(await rappel);
    expect(`${u.origin}${u.pathname}`).toBe(retour);
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("code")).toBeTruthy();
    await ctx.close();
  },
  90_000,
);

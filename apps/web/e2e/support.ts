// Outillage commun des parcours Chrome : navigateur, base jetable, API et web locaux, comptes et factures de test.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { testDb, type Sql } from "@auto/store";
import { chromium, type Browser } from "playwright-core";
import { creerApp } from "@auto/api/app";
import { demarrerWeb } from "../src/serveur";

export const MDP = "un mot de passe très long";

export function chrome(): string | null {
  if (Bun.env.AUTO_CHROME) return Bun.env.AUTO_CHROME;
  const racine =
    Bun.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(Bun.env.LOCALAPPDATA ?? join(Bun.env.HOME ?? "", ".cache"), "ms-playwright");
  for (const m of [
    "chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
    "chromium-*/chrome-win64/chrome.exe",
    "chromium-*/chrome-linux64/chrome",
  ])
    for (const f of existsSync(racine) ? new Bun.Glob(m).scanSync({ cwd: racine, onlyFiles: true }) : [])
      return join(racine, f);
  return null;
}

export type Banc = {
  sql: Sql;
  api: ReturnType<typeof Bun.serve>;
  web: ReturnType<typeof demarrerWeb>;
  navigateur: Browser;
  url: (chemin: string) => string;
  appel: (chemin: string, session: string, corps?: unknown) => Promise<any>;
  inscrire: (email: string, nom: string) => Promise<string>;
  facture: (session: string) => Promise<string>;
  connecte: (session: string, largeur?: number) => ReturnType<Browser["newContext"]>;
  arreter: () => Promise<void>;
};

export async function demarrerBanc(executablePath: string): Promise<Banc> {
  const { sql, drop } = await testDb();
  const api = Bun.serve({
    port: 0,
    routes: creerApp(sql),
    fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
  });
  // Sous Windows, port:0 peut attribuer des ports bas refusés par Chromium (1719 observé),
  // parfois toute une série consécutive. Choisir la plage haute, avec reprise d’une collision de bind.
  let web: ReturnType<typeof demarrerWeb>;
  try {
    web = (() => {
      for (let essai = 0; essai < 20; essai++) {
        const port = 30_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 30_000);
        try {
          return demarrerWeb({ api: api.url, port });
        } catch (e) {
          if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
        }
      }
      throw Error("Aucun port navigateur disponible");
    })();
  } catch (e) {
    api.stop(true);
    await drop();
    throw e;
  }
  // Better Auth sert l'origine du front (cookies, contrôle d'origine, liens) : routes rechargées avec elle.
  api.reload({
    routes: creerApp(sql, undefined, { auth: { baseURL: web.url.toString() } }),
    fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
  });
  /** Cookie de session signé posé par l'inscription, par jeton de session. */
  const cookies = new Map<string, { name: string; value: string }>();
  const navigateur = await chromium.launch({ executablePath });
  const url = (c: string) => new URL(c, web.url).toString();
  const appel = async (chemin: string, session: string, corps?: unknown) => {
    const r = await fetch(new URL(chemin, api.url), {
      method: corps === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
    });
    return r.json();
  };
  const inscrire = async (email: string, nom: string) => {
    const r = await fetch(new URL("/v1/auth/inscription", api.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        motDePasse: MDP,
        entreprise: { nom, siret: "73282932000074", adresse: "1 rue A, Lyon" },
      }),
    });
    const session = ((await r.json()) as { session: string }).session;
    const [kv] = r.headers
      .getSetCookie()
      .find((c) => c.includes("session_token="))!
      .split(";");
    const i = kv!.indexOf("=");
    cookies.set(session, { name: kv!.slice(0, i), value: kv!.slice(i + 1) });
    return session;
  };
  const facture = async (session: string) => {
    const d = await appel("/v1/documents", session, {
      type: "facture",
      client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon", email: "compta@client.fr" },
      lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 100000, tva: 200 }],
      datePrestation: "2026-10-15",
      echeance: "2026-11-21",
    });
    await appel(`/v1/documents/${d.id}/emettre`, session, {});
    return d.id as string;
  };
  const connecte = async (session: string, largeur = 1280) => {
    const ctx = await navigateur.newContext({ viewport: { width: largeur, height: 900 }, locale: "fr-FR" });
    const c = cookies.get(session);
    if (!c) throw new Error("session inconnue du banc : créée par inscrire()");
    await ctx.addCookies([{ ...c, url: web.url.toString() }]);
    return ctx;
  };
  const arreter = async () => {
    await navigateur.close();
    await web.stop(true);
    await api.stop(true);
    await drop();
  };
  return { sql, api, web, navigateur, url, appel, inscrire, facture, connecte, arreter };
}

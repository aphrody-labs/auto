import { expect, test } from "bun:test";
import { brancherEnvoyeur, type MessageMail } from "@auto/tenancy";
import { chrome, demarrerBanc, MDP } from "./support";
const executable = chrome();
(executable ? test : test.skip)(
  "équipe : même entreprise, sessions individuelles persistantes, reprise automatique et révocation isolée",
  async () => {
    const b = await demarrerBanc(executable!);
    const mails: MessageMail[] = [];
    brancherEnvoyeur(async (m) => {
      mails.push(m);
    });
    try {
      const proprietaire = await b.inscrire(`owner-equipe-${crypto.randomUUID()}@example.test`, "Entreprise commune");
      const entreprise = await b.appel("/v1/moi", proprietaire);
      const alice = `alice-${crypto.randomUUID()}@example.test`,
        bob = `bob-${crypto.randomUUID()}@example.test`;
      const rejoindre = async (email: string, role: string) => {
        await b.appel("/v1/invitations", proprietaire, { email, role });
        const lien = mails.findLast((m) => m.a === email)?.donnees.lien;
        if (!lien) throw Error("Invitation non reçue dans le relais de contrôle");
        const contexte = await b.navigateur.newContext();
        contexte.setDefaultTimeout(15_000);
        if (email === bob) {
          expect(
            (
              await contexte.request.post(b.url("/api/auth/sign-in/email"), {
                headers: { origin: b.web.url.origin },
                data: { email: alice, password: MDP },
              })
            ).status(),
          ).toBe(200);
        }
        const p = await contexte.newPage();
        await p.goto(b.url(new URL(lien).pathname + new URL(lien).search));
        if (email === bob) await p.getByRole("button", { name: "Utiliser un autre compte", exact: true }).click();
        await p.getByLabel("Mot de passe", { exact: false }).fill(MDP);
        await p.getByRole("button", { name: "Rejoindre", exact: true }).click();
        await p.getByRole("heading", { name: "Tableau de bord", exact: true }).waitFor();
        return contexte;
      };
      const a = await rejoindre(alice, "comptable"),
        c = await rejoindre(bob, "lecture");
      const moiA = await (await a.request.get(b.url("/v1/moi"))).json();
      const moiB = await (await c.request.get(b.url("/v1/moi"))).json();
      expect(moiA.tenantId).toBe(entreprise.tenantId);
      expect(moiB.tenantId).toBe(entreprise.tenantId);
      expect(moiA.userId === moiB.userId).toBe(false);
      expect(moiA.role).toBe("comptable");
      expect(moiB.role).toBe("lecture");
      expect(Number((await b.sql`SELECT count(*)::int AS n FROM tenant`)[0].n)).toBe(1);
      expect(
        (await c.request.post(b.url("/v1/clients"), { data: { nom: "Refusé", siret: "", adresse: "" } })).status(),
      ).toBe(403);
      const etat = await a.storageState();
      const cookie = etat.cookies.find((k) => k.name.includes("session_token"))!;
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.expires > Date.now() / 1000 + 29 * 86400).toBe(true);
      const [session] =
        await b.sql`SELECT token,expires_at FROM session WHERE user_id=${moiA.userId} ORDER BY created_at DESC LIMIT 1`;
      await b.sql`UPDATE session SET expires_at=now()+interval '28 days',updated_at=now()-interval '2 days' WHERE token=${session.token}`;
      const avant = new Date(
        (await b.sql`SELECT expires_at FROM session WHERE token=${session.token}`)[0].expires_at,
      ).getTime();
      expect((await b.appel("/v1/moi", session.token)).userId).toBe(moiA.userId);
      expect(
        new Date((await b.sql`SELECT expires_at FROM session WHERE token=${session.token}`)[0].expires_at).getTime(),
      ).toBe(avant);
      cookie.expires = Date.now() / 1000 + 86400;
      await a.close();
      const repris = await b.navigateur.newContext({ storageState: etat });
      repris.setDefaultTimeout(15_000);
      const page = await repris.newPage();
      await page.goto(b.url("/app/connexion?retour=%2Fapp%2Fclients"));
      await page.getByRole("heading", { name: "Clients", exact: true }).waitFor();
      expect((await (await repris.request.get(b.url("/v1/moi"))).json()).userId).toBe(moiA.userId);
      expect(
        (await repris.cookies()).find((k) => k.name.includes("session_token"))!.expires >
          Date.now() / 1000 + 29 * 86400,
      ).toBe(true);
      const autre = await b.navigateur.newContext();
      const connexion = await autre.request.post(b.url("/api/auth/sign-in/email"), {
        headers: { origin: b.web.url.origin },
        data: { email: alice, password: MDP, rememberMe: true },
      });
      expect(connexion.status()).toBe(200);
      const seconde = await (await autre.request.get(b.url("/api/auth/get-session"))).json();
      expect((await (await repris.request.get(b.url("/api/auth/list-sessions"))).json()).length).toBe(2);
      expect(
        (
          await repris.request.post(b.url("/api/auth/revoke-session"), {
            headers: { origin: b.web.url.origin },
            data: { token: seconde.session.token },
          })
        ).status(),
      ).toBe(200);
      expect((await autre.request.get(b.url("/v1/moi"))).status()).toBe(401);
      expect((await repris.request.get(b.url("/v1/moi"))).status()).toBe(200);
      expect((await c.request.get(b.url("/v1/moi"))).status()).toBe(200);
      const temporaire = await b.navigateur.newContext();
      temporaire.setDefaultTimeout(15_000);
      const connexionTemporaire = await temporaire.newPage();
      await connexionTemporaire.goto(b.url("/app/connexion"));
      await connexionTemporaire.getByLabel("E-mail", { exact: false }).fill(alice);
      await connexionTemporaire.getByLabel("Mot de passe", { exact: false }).fill(MDP);
      await connexionTemporaire
        .getByRole("checkbox", { name: "Rester connecté sur cet appareil", exact: true })
        .uncheck();
      await connexionTemporaire.getByRole("button", { name: "Se connecter", exact: true }).click();
      await connexionTemporaire.getByRole("heading", { name: "Tableau de bord", exact: true }).waitFor();
      expect((await temporaire.cookies()).find((k) => k.name.includes("session_token"))!.expires).toBe(-1);
      await temporaire.close();
      await autre.close();
      await repris.close();
      await c.close();
    } finally {
      await b.arreter();
    }
  },
  60000,
);

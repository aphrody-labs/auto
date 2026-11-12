import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDb, withTenant, type Sql } from "@auto/store";
import { symmetricDecrypt } from "better-auth/crypto";
import {
  accepterInvitation,
  authDe,
  authentifier,
  brancherEnvoyeur,
  chiffrer,
  cleTemporaire,
  confirmerTotp,
  connecter,
  creerJetonApi,
  depuisBase32,
  desactiverTotp,
  enrolerTotp,
  hash,
  inscrire,
  inviter,
  listerInvitations,
  listerJetons,
  migrerDeuxFacteurs,
  rechercherSiren,
  regenererCodesSecours,
  revoquerInvitation,
  revoquerJeton,
  totp,
  validerDeuxFacteurs,
  type Auth,
  type MessageMail,
} from "./index";

let sql: Sql;
let drop: () => Promise<void>;
const boite: MessageMail[] = [];
beforeAll(async () => {
  ({ sql, drop } = await testDb());
  brancherEnvoyeur(async (m) => {
    boite.push(m);
  });
});
afterAll(() => drop());

const MDP = "un mot de passe long";
const entreprise = { nom: "Alpha", siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" };

async function owner(email: string): Promise<Auth & { session: string }> {
  const r = await inscrire(sql, { email, motDePasse: MDP, entreprise });
  return { userId: r.userId, tenantId: r.tenantId, role: "owner", session: r.session };
}

const jetonRecu = () => boite.at(-1)!.donnees.jeton!;

test("inscription : utilisateur, entreprise (organization), owner ; mot de passe argon2id dans account", async () => {
  const a = await owner("inscrit@alpha.fr");
  expect(await authentifier(sql, a.session)).toEqual({ userId: a.userId, tenantId: a.tenantId, role: "owner" });
  const [acc] = await sql`SELECT password FROM account WHERE user_id = ${a.userId} AND provider_id = 'credential'`;
  expect(acc.password).toStartWith("$argon2id$");
  const [t] = await sql`SELECT nom, siren, tva_intracom, slug FROM tenant WHERE id = ${a.tenantId}`;
  expect(t).toMatchObject({ nom: "Alpha", siren: "732829320", tva_intracom: "FR44732829320" });
  await expect(inscrire(sql, { email: "inscrit@alpha.fr", motDePasse: MDP, entreprise })).rejects.toMatchObject({
    status: 409,
  });
  await expect(inscrire(sql, { email: "x@alpha.fr", motDePasse: "court", entreprise })).rejects.toThrow("invalide");
  expect(await authentifier(sql, "inconnu")).toBeNull();
  await expect(connecter(sql, "inscrit@alpha.fr", "faux mot de passe")).rejects.toMatchObject({ status: 401 });

  // Hachage historique Bun.password repris tel quel par Better Auth.
  await sql`UPDATE account SET password = ${await Bun.password.hash("ancien mot de passe")} WHERE user_id = ${a.userId}`;
  expect("session" in (await connecter(sql, "inscrit@alpha.fr", "ancien mot de passe"))).toBe(true);
});

test("clés d'API : entreprise, auteur, rôle relu, révocation, reprise des anciens jetons", async () => {
  const a = await owner("cles@alpha.fr");
  const cle = await creerJetonApi(sql, a, "agent");
  expect(cle).toStartWith("auto_");
  expect(await authentifier(sql, cle)).toEqual({ userId: a.userId, tenantId: a.tenantId, role: "owner" });
  const [l] = await listerJetons(sql, a);
  expect(l).toMatchObject({ nom: "agent", email: "cles@alpha.fr" });
  expect(JSON.stringify(await sql`SELECT * FROM apikey`)).not.toContain(cle);
  await expect(creerJetonApi(sql, { ...a, role: "comptable" }, "x")).rejects.toMatchObject({ status: 403 });

  // Rôle relu à chaque requête : rétrogradé, la clé n'a plus que les droits de lecture.
  await sql`UPDATE membership SET role = 'lecture' WHERE user_id = ${a.userId}`;
  expect((await authentifier(sql, cle))?.role).toBe("lecture");
  await sql`UPDATE membership SET role = 'owner' WHERE user_id = ${a.userId}`;

  // Entreprise suspendue : plus d'accès.
  await sql`UPDATE tenant SET suspendu_at = now() WHERE id = ${a.tenantId}`;
  expect(await authentifier(sql, cle)).toBeNull();
  await sql`UPDATE tenant SET suspendu_at = NULL WHERE id = ${a.tenantId}`;

  await revoquerJeton(sql, a, l!.id);
  expect(await authentifier(sql, cle)).toBeNull();

  // Ancien jeton `auto_…` (SHA-256 hexadécimal) : même empreinte, convertie en base64url par 020.
  const ancien = "auto_ancienjetonquivientdelacouchemaison";
  const b64 = Buffer.from(hash(ancien), "hex").toString("base64url");
  await sql`INSERT INTO apikey (reference_id, prefix, key, metadata) VALUES (${a.tenantId}, 'auto_', ${b64},
    ${JSON.stringify({ userId: a.userId })})`;
  expect(await authentifier(sql, ancien)).toMatchObject({ tenantId: a.tenantId });

  // Clé temporaire des workflows.
  const t = await cleTemporaire(sql, a.tenantId, a.userId, "automatisation:test");
  expect((await authentifier(sql, t.jeton))?.userId).toBe(a.userId);
  await t.revoquer();
  expect(await authentifier(sql, t.jeton)).toBeNull();
});

test("invitation : création, usage unique, révocation, rattachement d'un compte existant", async () => {
  const a = await owner("owner@alpha.fr");
  const inv = await inviter(sql, a, "Nouveau@Alpha.fr", "comptable");
  expect(inv).toMatchObject({ email: "nouveau@alpha.fr", role: "comptable", statut: "en_attente" });
  expect(Date.parse(inv.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400_000);
  expect(boite.at(-1)!.a).toBe("nouveau@alpha.fr");
  expect(boite.at(-1)!.de).toBe("contact@aphrody.com");
  expect(boite.at(-1)!.texte).toContain(`/app/invitation?id=${inv.id}`);

  // Un comptable ne peut pas inviter ; un admin ne peut pas nommer d'owner.
  const comptable: Auth = { ...a, role: "comptable" };
  await expect(inviter(sql, comptable, "x@alpha.fr", "lecture")).rejects.toThrow("membres");
  await expect(inviter(sql, { ...a, role: "admin" }, "x@alpha.fr", "owner")).rejects.toThrow("owner");

  // Acceptation : création du compte, puis lien consommé.
  const jeton = jetonRecu();
  await expect(accepterInvitation(sql, jeton, "court")).rejects.toThrow("12 caractères");
  const r = await accepterInvitation(sql, jeton, MDP);
  if (!("session" in r)) throw new Error("session attendue");
  expect(r.tenantId).toBe(a.tenantId);
  expect((await authentifier(sql, r.session))?.role).toBe("comptable");
  await expect(accepterInvitation(sql, jeton, MDP)).rejects.toThrow("déjà utilisée");
  await expect(inviter(sql, a, "nouveau@alpha.fr", "lecture")).rejects.toThrow("déjà membre");

  // Révocation : le lien ne sert plus.
  await inviter(sql, a, "revoque@alpha.fr", "rh");
  const revoque = jetonRecu();
  const [enCours] = (await listerInvitations(sql, a)).filter((i) => i.email === "revoque@alpha.fr");
  await revoquerInvitation(sql, a, enCours!.id);
  await expect(accepterInvitation(sql, revoque, MDP)).rejects.toThrow("invalide");
  await expect(revoquerInvitation(sql, a, enCours!.id)).rejects.toThrow("déjà close");

  // Compte existant d'une autre entreprise : rattaché, mot de passe du compte exigé.
  const b = await owner("owner@beta.fr");
  await inviter(sql, a, "owner@beta.fr", "admin");
  const jb = jetonRecu();
  await expect(accepterInvitation(sql, jb, "pas le bon mot de passe")).rejects.toThrow("identifiants");
  const rb = await accepterInvitation(sql, jb, MDP);
  if (!("session" in rb)) throw new Error("session attendue");
  expect(rb.tenantId).toBe(a.tenantId);
  expect((await connecter(sql, "owner@beta.fr", MDP, b.tenantId)) as { tenantId: string }).toMatchObject({
    tenantId: b.tenantId,
  });

  // Expiration : au-delà de 7 jours, refusée.
  await inviter(sql, a, "tard@alpha.fr", "lecture");
  const tard = jetonRecu();
  await sql`UPDATE invitation SET expires_at = now() - interval '1 second' WHERE email = 'tard@alpha.fr'`;
  await expect(accepterInvitation(sql, tard, MDP)).rejects.toThrow("expirée");

  // Ancienne invitation (jeton haché, lien `/invitation#…`) : toujours acceptée.
  const ancien = "i_ancienneinvitation";
  await sql`INSERT INTO invitation (tenant_id, email, role, token_hash, invite_par, expires_at)
    VALUES (${a.tenantId}, 'ancien@alpha.fr', 'lecture', ${hash(ancien)}, ${a.userId}, now() + interval '1 day')`;
  expect((await accepterInvitation(sql, ancien, MDP)) as { tenantId: string }).toMatchObject({
    tenantId: a.tenantId,
  });

  // Isolation : B ne liste ni ne révoque les invitations de A ; piste d'audit intacte.
  expect(await listerInvitations(sql, b)).toEqual([]);
  const [i] = await listerInvitations(sql, a);
  await expect(revoquerInvitation(sql, b, i!.id)).rejects.toThrow("introuvable");
  const actions = await withTenant(sql, a.tenantId, (tx) => tx`SELECT action, payload FROM audit ORDER BY id`);
  expect(actions.map((x: { action: string }) => x.action)).toContain("invitation.accepter");
  expect(actions.map((x: { action: string }) => x.action)).toContain("invitation.revoquer");
  expect(JSON.stringify(actions)).not.toContain("@");
});

test("2FA TOTP : enrôlement, confirmation, connexion en deux étapes, secours, désactivation", async () => {
  const a = await owner("totp@alpha.fr");
  await expect(enrolerTotp(sql, a, "mauvais")).rejects.toThrow("identifiants");
  const { secret, uri, codesSecours } = await enrolerTotp(sql, a, MDP);
  expect(uri).toContain(`secret=${secret}`);
  expect(codesSecours).toHaveLength(10);
  const brut = depuisBase32(secret);

  // Tant que la 2FA n'est pas confirmée, la connexion reste en une étape.
  expect("session" in (await connecter(sql, "totp@alpha.fr", MDP))).toBe(true);
  await expect(confirmerTotp(sql, a, "000000")).rejects.toThrow("code invalide");
  await confirmerTotp(sql, a, await totp(brut));

  // Étape 1 : défi, sans accès aux routes.
  const c = await connecter(sql, "totp@alpha.fr", MDP);
  if (!("defi" in c)) throw new Error("défi attendu");
  expect(await authentifier(sql, c.defi)).toBeNull();
  await expect(validerDeuxFacteurs(sql, c.defi, "000000")).rejects.toThrow("code invalide");
  const s = await validerDeuxFacteurs(sql, c.defi, await totp(brut));
  expect((await authentifier(sql, s.session))?.userId).toBe(a.userId);
  await expect(validerDeuxFacteurs(sql, c.defi, await totp(brut))).rejects.toThrow("défi");

  // Code de secours : à usage unique.
  const c2 = await connecter(sql, "totp@alpha.fr", MDP);
  if (!("defi" in c2)) throw new Error("défi attendu");
  await validerDeuxFacteurs(sql, c2.defi, codesSecours[0]!);
  const c3 = await connecter(sql, "totp@alpha.fr", MDP);
  if (!("defi" in c3)) throw new Error("défi attendu");
  await expect(validerDeuxFacteurs(sql, c3.defi, codesSecours[0]!)).rejects.toThrow("code invalide");

  // Nouveaux codes : les anciens ne servent plus.
  const { codesSecours: neufs } = await regenererCodesSecours(sql, a, MDP);
  await expect(validerDeuxFacteurs(sql, c3.defi, codesSecours[1]!)).rejects.toThrow();
  const c4 = await connecter(sql, "totp@alpha.fr", MDP);
  if (!("defi" in c4)) throw new Error("défi attendu");
  await validerDeuxFacteurs(sql, c4.defi, neufs[0]!);

  // Désactivation : mot de passe et code exigés.
  await expect(desactiverTotp(sql, a, MDP, "000000")).rejects.toThrow("code invalide");
  await expect(desactiverTotp(sql, a, "mauvais", await totp(brut))).rejects.toThrow("identifiants");
  await desactiverTotp(sql, a, MDP, await totp(brut));
  expect("session" in (await connecter(sql, "totp@alpha.fr", MDP))).toBe(true);
  expect(await sql`SELECT 1 FROM two_factor WHERE user_id = ${a.userId}`).toHaveLength(0);
});

test("reprise de l'ancienne 2FA : secret TOTP et codes de secours conservés", async () => {
  const a = await owner("ancienne2fa@alpha.fr");
  const brut = crypto.getRandomValues(new Uint8Array(20));
  await sql`UPDATE app_user SET totp_secret = ${await chiffrer(`totp:${a.userId}`, brut)}, totp_actif = true
    WHERE id = ${a.userId}`;
  await sql`INSERT INTO code_secours (user_id, hash) VALUES (${a.userId}, ${hash("abcdeabcde")})`;
  expect(await migrerDeuxFacteurs(sql, authDe(sql))).toBe(1);
  expect(await migrerDeuxFacteurs(sql, authDe(sql))).toBe(0);
  const [tf] = await sql`SELECT secret FROM two_factor WHERE user_id = ${a.userId}`;
  const { secretConfig } = await authDe(sql).$context;
  expect(await symmetricDecrypt({ key: secretConfig, data: tf.secret })).toStartWith("legacy:");

  // L'application d'authentification déjà enrôlée continue de servir.
  const c = await connecter(sql, "ancienne2fa@alpha.fr", MDP);
  if (!("defi" in c)) throw new Error("défi attendu");
  await expect(validerDeuxFacteurs(sql, c.defi, "000000")).rejects.toThrow("code invalide");
  expect((await validerDeuxFacteurs(sql, c.defi, await totp(brut))).userId).toBe(a.userId);

  // Ancien code de secours : accepté une fois.
  const c2 = await connecter(sql, "ancienne2fa@alpha.fr", MDP);
  if (!("defi" in c2)) throw new Error("défi attendu");
  expect((await validerDeuxFacteurs(sql, c2.defi, "ABCDE-ABCDE")).userId).toBe(a.userId);
  const c3 = await connecter(sql, "ancienne2fa@alpha.fr", MDP);
  if (!("defi" in c3)) throw new Error("défi attendu");
  await expect(validerDeuxFacteurs(sql, c3.defi, "abcde-abcde")).rejects.toThrow("code invalide");
});

test("Sirene : préremplissage depuis la réponse de recherche-entreprises (simulée)", async () => {
  const appels: string[] = [];
  const reponse = {
    results: [
      {
        siren: "732829320",
        nom_complet: "ENTREPRISE EXEMPLE (EXEMPLE)",
        nom_raison_sociale: "ENTREPRISE EXEMPLE",
        nature_juridique: "5710",
        activite_principale: "62.01Z",
        etat_administratif: "A",
        date_creation: "1973-01-01",
        siege: {
          siret: "73282932000074",
          adresse: "1 RUE DE LA PAIX 75002 PARIS",
          code_postal: "75002",
          libelle_commune: "PARIS",
        },
      },
    ],
    total_results: 1,
  };
  const fetcher = (async (url: string) => {
    appels.push(String(url));
    return Response.json(reponse);
  }) as unknown as typeof fetch;
  expect(await rechercherSiren("732 829 320", fetcher)).toEqual({
    siren: "732829320",
    nom: "ENTREPRISE EXEMPLE",
    siretSiege: "73282932000074",
    adresse: "1 RUE DE LA PAIX 75002 PARIS",
    codePostal: "75002",
    commune: "PARIS",
    naf: "62.01Z",
    natureJuridique: "5710",
    dateCreation: "1973-01-01",
    active: true,
    tvaIntracom: "FR44732829320",
  });
  expect(appels[0]).toBe("https://recherche-entreprises.api.gouv.fr/search?q=732829320&page=1&per_page=1");
  // SIRET accepté, SIREN invalide refusé, inconnu → null, annuaire en panne → 502.
  expect((await rechercherSiren("73282932000074", fetcher))?.siren).toBe("732829320");
  await expect(rechercherSiren("123456789", fetcher)).rejects.toThrow("siren invalide");
  const vide = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
  expect(await rechercherSiren("732829320", vide)).toBeNull();
  const panne = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await expect(rechercherSiren("732829320", panne)).rejects.toMatchObject({ status: 502 });
});

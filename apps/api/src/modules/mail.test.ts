import { afterAll, beforeAll, expect, test } from "bun:test";
import { envoyeurSmtp } from "@auto/mail";
import { boiteJetable, greenmailDisponible } from "@auto/mail/greenmail";
import { testDb, type Sql, majAbonnement, withTenant } from "@auto/store";
import { creerApp } from "../app";

Bun.env.AUTO_CLE_MAITRE ??= "cle-maitre-de-test-0123456789abcdef";
Bun.env.AUTO_MAIL_DEV = "1";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
const evenements: { type: string; tenantId: string; data: any }[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  server = Bun.serve({
    port: 0,
    routes: creerApp(sql, async (tx, type, data) => {
      const [r] = await tx<{ t: string }[]>`SELECT current_setting('app.tenant', true) AS t`;
      evenements.push({ type, tenantId: r!.t, data });
      return { id: crypto.randomUUID() };
    }),
    fetch: () => new Response("404", { status: 404 }),
  });
});

afterAll(async () => {
  await server?.stop(true);
  await drop?.();
});

async function api(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(new URL(path, server.url), {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Inscription, puis passage au plan Pro : le plan Gratuit n'inclut pas de boîte mail. */
const inscrire = async (email: string, nom: string) => {
  const r = (
    await api("/v1/auth/inscription", undefined, {
      body: {
        email,
        motDePasse: "un mot de passe long",
        entreprise: { nom, siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
      },
    })
  ).body as { session: string; tenantId: string };
  await withTenant(sql, r.tenantId, (tx) => majAbonnement(tx, { plan: "pro", statut: "active" }));
  return r.session;
};

/** Corps de connexion d'une boîte GreenMail (TLS implicite, certificat auto-signé). */
const corpsBoite = (b: ReturnType<typeof boiteJetable>, nom?: string) => ({
  adresse: b.adresse,
  nom,
  motDePasse: b.identifiants.motDePasse,
  imap: { hote: b.imap.hote, port: b.imap.port, securite: b.imap.securite },
  smtp: { hote: b.smtp.hote, port: b.smtp.port, securite: b.smtp.securite },
  certificatNonVerifie: true,
});

test.skipIf(!greenmailDisponible)(
  "boîte du tenant, envoi d'une facture, relève classée et idempotente, isolation",
  async () => {
    const vendeur = await inscrire(`v-${crypto.randomUUID()}@exemple.fr`, "Alpha");
    const client = await inscrire(`c-${crypto.randomUUID()}@exemple.fr`, "Beta");
    const bv = boiteJetable("alpha", true);
    const bc = boiteJetable("beta", true);

    expect((await api("/v1/mail/fournisseurs", vendeur)).body.map((f: { id: string }) => f.id)).toContain("ovh-mxplan");
    expect((await api("/v1/mail/boite", vendeur)).status).toBe(404);

    // Validation, test de connexion avant enregistrement, mode dev requis pour le clair.
    expect((await api("/v1/mail/boite", vendeur, { method: "PUT", body: { adresse: "x" } })).status).toBe(422);
    const ko = await api("/v1/mail/boite", vendeur, {
      method: "PUT",
      body: { ...corpsBoite(bv), imap: { ...corpsBoite(bv).imap, port: 1 } },
    });
    expect(ko.status).toBe(422);
    expect(ko.body.details[0]).toStartWith("IMAP : connexion impossible");
    Bun.env.AUTO_MAIL_DEV = "0";
    const prod = await api("/v1/mail/boite", vendeur, { method: "PUT", body: corpsBoite(bv) });
    expect(prod.body.details).toContain("certificat non vérifié refusé");
    Bun.env.AUTO_MAIL_DEV = "1";
    // Préréglage fournisseur : les serveurs viennent du préréglage, surchargeables.
    const pre = await api("/v1/mail/boite", vendeur, {
      method: "PUT",
      body: { fournisseur: "ovh-mxplan", adresse: bv.adresse, motDePasse: "x", imap: { hote: "-x" } },
    });
    expect(pre.body.details).toEqual(["IMAP : hôte invalide"]);

    const ok = await api("/v1/mail/boite", vendeur, { method: "PUT", body: corpsBoite(bv, "Alpha Compta") });
    expect(ok.status).toBe(200);
    expect(ok.body.test.smtp.ok).toBe(true);
    expect(JSON.stringify(ok.body)).not.toContain(bv.identifiants.motDePasse);
    expect((await api("/v1/mail/boite/test", vendeur, { body: {} })).body.imap.ok).toBe(true);
    // Identifiants chiffrés au repos.
    const [brut] = await sql<{ identifiants: Uint8Array }[]>`SELECT identifiants FROM boite_mail`;
    expect(new TextDecoder().decode(brut!.identifiants)).not.toContain(bv.identifiants.motDePasse);
    expect(new TextDecoder().decode(brut!.identifiants)).not.toContain(bv.adresse);

    expect((await api("/v1/mail/boite", client, { method: "PUT", body: corpsBoite(bc) })).status).toBe(200);

    // Facture émise puis envoyée depuis la boîte du vendeur au client.
    const cli = await api("/v1/clients", vendeur, {
      body: { nom: "Beta SAS", siret: "73282932000074", adresse: "2 rue B, Lyon", email: bc.adresse },
    });
    const brouillon = await api("/v1/documents", vendeur, {
      body: {
        type: "facture",
        date: "2026-10-22",
        clientId: cli.body.id,
        lignes: [{ designation: "Développement", quantite: 3, prixUnitaireHtCents: 60000, tva: 200 }],
        datePrestation: "2026-10-15",
        echeance: "2026-11-21",
      },
    });
    const id = brouillon.body.id;
    expect((await api(`/v1/documents/${id}/envoyer`, vendeur, { body: {} })).status).toBe(409);
    await api(`/v1/documents/${id}/emettre`, vendeur, { body: {} });
    const env = await api(`/v1/documents/${id}/envoyer`, vendeur, { body: {} });
    expect(env.status).toBe(200);
    expect(env.body.statut).toBe("envoye");
    expect(env.body.destinataires).toEqual([bc.adresse]);
    expect(evenements.some((e) => e.type === "document.statut" && e.data.statut === "envoye")).toBe(true);
    expect((await api(`/v1/documents/${id}`, vendeur)).body.statut).toBe("envoye");
    expect((await api(`/v1/documents/${id}/envoyer`, vendeur, { body: { a: ["pas-une-adresse"] } })).status).toBe(422);
    expect((await api("/v1/audit/verification", vendeur)).body.ok).toBe(true);

    // Un courrier ordinaire en plus.
    await envoyeurSmtp(bv.smtp, bv.adresse).envoyer({ a: [bc.adresse], sujet: "Rendez-vous", texte: "Mardi ?" });

    // Relève du client : facture Factur-X reconnue, courrier ordinaire.
    const r1 = await api("/v1/mail/releve", client, { body: {} });
    expect(r1.body).toEqual({ nouveaux: 2, factures: 1 });
    const recus = await api("/v1/mail/messages", client);
    expect(recus.body).toHaveLength(2);
    const facture = recus.body.find((m: { classement: string }) => m.classement === "facture");
    expect(facture.sujet).toBe("Facture F-2026-0001 — Alpha");
    expect(facture.expediteur).toBe(bv.adresse);
    expect(facture.extrait).toContain("F-2026-0001");
    expect(facture.pieces).toMatchObject([{ nom: "F-2026-0001.pdf", type: "application/pdf", facturx: true }]);
    expect((await api("/v1/mail/messages?classement=autre", client)).body[0].sujet).toBe("Rendez-vous");
    const types = evenements
      .filter((e) => e.type.startsWith("mail."))
      .map((e) => e.type)
      .sort();
    expect(types).toEqual(["mail.facture_recue", "mail.recu"]);
    // La facture reçue par mail est passée à l'ingestion (Factur-X lu directement).
    const recues = (await api("/v1/factures-recues", client)).body;
    expect(recues).toHaveLength(1);
    expect(recues[0]).toMatchObject({ canal: "mail", statut: "validee" });

    // Pièce jointe identique à l'exemplaire figé du vendeur.
    const piece = await fetch(new URL(`/v1/mail/pieces/${facture.pieces[0].id}`, server.url), {
      headers: { authorization: `Bearer ${client}` },
    });
    const original = await fetch(new URL(`/v1/documents/${id}/pdf`, server.url), {
      headers: { authorization: `Bearer ${vendeur}` },
    });
    expect(piece.headers.get("etag")).toBe(original.headers.get("etag"));
    expect(new Uint8Array(await piece.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));

    // Idempotence : nouvelle relève, puis reconnexion de la boîte (état remis à zéro).
    expect((await api("/v1/mail/releve", client, { body: {} })).body).toEqual({ nouveaux: 0, factures: 0 });
    await api("/v1/mail/boite", client, { method: "PUT", body: corpsBoite(bc) });
    expect((await api("/v1/mail/releve", client, { body: {} })).body).toEqual({ nouveaux: 0, factures: 0 });
    expect((await api("/v1/mail/boite", client)).body.dernierUid).toBeGreaterThan(0);
    expect((await api("/v1/audit/verification", client)).body.ok).toBe(true);

    // Isolation entre tenants.
    expect((await api("/v1/mail/messages", vendeur)).body).toEqual([]);
    expect((await api(`/v1/mail/pieces/${facture.pieces[0].id}`, vendeur)).status).toBe(404);

    expect((await api("/v1/mail/boite", vendeur, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/v1/documents/${id}/envoyer`, vendeur, { body: {} })).status).toBe(409);
  },
  60_000,
);

test("plan Gratuit : aucune boîte mail (402 explicite)", async () => {
  const r = await api("/v1/auth/inscription", undefined, {
    body: {
      email: "gratuit-mail@exemple.fr",
      motDePasse: "un mot de passe long",
      entreprise: { nom: "Gratuit", siret: "73282932000074", adresse: "1 rue A, Paris" },
    },
  });
  const res = await api("/v1/mail/boite", r.body.session, { method: "PUT", body: { adresse: "x" } });
  expect(res.status).toBe(402);
});

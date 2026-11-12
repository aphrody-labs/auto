import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  archiverFichiers,
  executerSuppressionsEchues,
  purgerConservationsEchues,
  testDb,
  withTenant,
  type Sql,
} from "@auto/store";
import { depuisBase32, totp, type MessageMail } from "@auto/tenancy";
import { creerApp } from "./app";
import type { TypeEvenement } from "@auto/services";
import { brancherEnvoyeur } from "./modules/comptes";
import { instrumenter, Metriques, type Journal } from "./observabilite";

let sql: Sql;
let drop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
const journaux: Journal[] = [];
const evenements: { type: TypeEvenement; data: unknown }[] = [];
const boite: MessageMail[] = [];

beforeAll(async () => {
  ({ sql, drop } = await testDb());
  brancherEnvoyeur(async (m) => {
    boite.push(m);
  });
  const routes = instrumenter(
    creerApp(sql, async (_tx, type, data) => {
      evenements.push({ type, data });
      return { id: crypto.randomUUID() };
    }),
    { journal: (j) => journaux.push(j), metriques: new Metriques(), jetonMetriques: "m" },
  );
  server = Bun.serve({ port: 0, routes, fetch: () => new Response("404", { status: 404 }) });
});

afterAll(async () => {
  await server.stop(true);
  await drop();
});

async function api(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(new URL(path, server.url), {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const MDP = "un mot de passe long";
const inscription = (email: string, nom: string) => ({
  email,
  motDePasse: MDP,
  entreprise: { nom, siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
});
const facture = {
  type: "facture",
  date: "2026-10-22",
  client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
  lignes: [{ designation: "Conseil", quantite: 1, prixUnitaireHtCents: 10000, tva: 200 }],
  datePrestation: "2026-10-15",
  echeance: "2026-11-21",
};

test("invitation et 2FA par l'API", async () => {
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("owner@alpha.fr", "Alpha") });
  const inv = await api("/v1/invitations", a.body.session, { body: { email: "compta@alpha.fr", role: "comptable" } });
  expect(inv.status).toBe(201);
  // Lien Better Auth : l'identifiant de l'invitation, envoyé seulement par mail au destinataire.
  expect(boite.at(-1)!.texte).toContain(`/app/invitation?id=${inv.body.id}`);
  expect(evenements.at(-1)).toMatchObject({ type: "invitation.creee", data: { id: inv.body.id } });
  expect((await api("/v1/invitations", a.body.session)).body).toHaveLength(1);

  const acc = await api("/v1/invitations/acceptation", undefined, {
    body: { jeton: boite.at(-1)!.donnees.jeton, motDePasse: MDP },
  });
  expect(acc.status).toBe(201);
  expect(acc.headers.get("set-cookie")).toContain("auto.session_token=");
  expect((await api("/v1/moi", acc.body.session)).body.role).toBe("comptable");
  // Un comptable ne gère pas les invitations.
  expect((await api("/v1/invitations", acc.body.session)).status).toBe(403);

  // 2FA : enrôlement, confirmation, connexion en deux étapes.
  expect((await api("/v1/2fa/enrolement", acc.body.session, { body: { motDePasse: "faux" } })).status).toBe(401);
  const e = await api("/v1/2fa/enrolement", acc.body.session, { body: { motDePasse: MDP } });
  expect(e.body.codesSecours).toHaveLength(10);
  const brut = depuisBase32(e.body.secret);
  const conf = await api("/v1/2fa/confirmation", acc.body.session, { body: { code: await totp(brut) } });
  expect(conf.body).toEqual({ actif: true });
  const c = await api("/v1/auth/connexion", undefined, { body: { email: "compta@alpha.fr", motDePasse: MDP } });
  expect(c.body).toEqual({ deuxFacteurs: true, defi: expect.any(String) });
  // Seul le cookie signé du défi est posé, jamais de session.
  expect(c.headers.get("set-cookie")).not.toMatch(/session_token=[^;]/);
  expect((await api("/v1/moi", c.body.defi)).status).toBe(401);
  const s = await api("/v1/auth/2fa", undefined, { body: { defi: c.body.defi, code: await totp(brut) } });
  expect(s.status).toBe(200);
  expect((await api("/v1/moi", s.body.session)).body.userId).toBe(acc.body.userId);
  const d = await api("/v1/2fa/desactivation", s.body.session, {
    body: { motDePasse: MDP, code: await totp(brut) },
  });
  expect(d.status).toBe(204);
});

test("observabilité : journaux JSON et /metrics sans données personnelles", async () => {
  const j = journaux.find((x) => x.route === "/v1/moi" && x.statut === 200)!;
  expect(j).toMatchObject({ niveau: "info", methode: "GET", tenant: expect.any(String) });
  expect(j.dureeMs).toBeGreaterThanOrEqual(0);
  expect(journaux.some((x) => x.route === "/v1/invitations/acceptation" && x.statut === 201)).toBe(true);
  expect(JSON.stringify(journaux)).not.toContain("@");

  expect((await fetch(new URL("/metrics", server.url))).status).toBe(401);
  const m = await (await fetch(new URL("/metrics", server.url), { headers: { authorization: "Bearer m" } })).text();
  expect(m).toContain('auto_http_requetes_total{route="/v1/moi",methode="GET",statut="200"}');
  expect(m).toContain('auto_http_duree_secondes_bucket{route="/v1/auth/connexion",methode="POST",le="+Inf"}');
  expect(m).toContain("# TYPE auto_http_duree_secondes histogram");
  expect(m).not.toContain("@");
});

test("export complet, suppression avec délai de grâce, conservation légale puis purge", async () => {
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("owner@gamma.fr", "Gamma") });
  const t = a.body.session;
  const d = await api("/v1/documents", t, { body: facture });
  expect((await api(`/v1/documents/${d.body.id}/emettre`, t, { body: {} })).status).toBe(200);
  await api("/v1/documents", t, { body: facture }); // brouillon
  await api("/v1/clients", t, { body: { nom: "Prospect", adresse: "3 rue C", email: "p@prospect.fr" } });
  await api("/v1/employes", t, {
    body: {
      nom: "Durand",
      prenom: "Léa",
      poste: "Développeuse",
      contrat: "cdi",
      dateEntree: "2026-01-05",
      tempsTravail: 100,
      salaireBrutMensuelCents: 300000,
    },
  });

  // Export : archive tar.gz, une table par JSON, exemplaire figé en fichier, sans secret.
  const res = await fetch(new URL("/v1/conformite/export", server.url), { headers: { authorization: `Bearer ${t}` } });
  expect(res.headers.get("content-type")).toBe("application/gzip");
  const fichiers = await new Bun.Archive(await res.bytes()).files();
  const lireJson = async (n: string) => JSON.parse(await fichiers.get(n)!.text());
  const manifeste = await lireJson("manifeste.json");
  expect(manifeste.tables.document).toBe(2);
  expect(manifeste.tables.employe).toBe(1);
  expect((await lireJson("membres.json"))[0].email).toBe("owner@gamma.fr");
  const pdf = [...fichiers.keys()].find((k) => k.startsWith("fichiers/fichier/"))!;
  expect(await fichiers.get(pdf)!.text()).toStartWith("%PDF-");
  expect(manifeste.fichiers[pdf]).toBe(
    new Bun.CryptoHasher("sha256").update(await fichiers.get(pdf)!.bytes()).digest("hex"),
  );
  expect((await lireJson("tables/fichier.json"))[0].contenu).toEqual({ fichier: pdf });
  const tout = (await Promise.all([...fichiers.values()].map((f) => f.text()))).join();
  expect(tout).not.toContain("password_hash");
  expect(tout).not.toContain("token_hash");

  // Suppression : owner, nom exact, mot de passe ; annulable.
  expect(
    (await api("/v1/conformite/suppression", t, { body: { confirmation: "gamma", motDePasse: MDP } })).status,
  ).toBe(422);
  expect(
    (await api("/v1/conformite/suppression", t, { body: { confirmation: "Gamma", motDePasse: "x" } })).status,
  ).toBe(401);
  const dem = await api("/v1/conformite/suppression", t, { body: { confirmation: "Gamma", motDePasse: MDP } });
  expect(dem.status).toBe(202);
  expect(Date.parse(dem.body.effectiveAt) - Date.now()).toBeGreaterThan(29 * 86400_000);
  expect((await api("/v1/conformite/suppression", t, { method: "DELETE" })).body.effectiveAt).toBeNull();
  await api("/v1/conformite/suppression", t, { body: { confirmation: "Gamma", motDePasse: MDP } });

  // Délai non écoulé : rien ; écoulé : exécution.
  expect(await executerSuppressionsEchues(sql)).not.toContain(a.body.tenantId);
  await sql`UPDATE tenant SET suppression_effective_at = now() - interval '1 second' WHERE id = ${a.body.tenantId}`;
  expect(await executerSuppressionsEchues(sql)).toEqual([a.body.tenantId]);
  expect((await api("/v1/moi", t)).status).toBe(401);
  expect(await sql`SELECT 1 FROM app_user WHERE email = 'owner@gamma.fr'`).toHaveLength(0);
  const reste = await withTenant(sql, a.body.tenantId, async (tx) => ({
    documents: await tx`SELECT statut FROM document`,
    fichiers: await tx`SELECT 1 FROM fichier`,
    employes: await tx`SELECT 1 FROM employe`,
    clients: await tx`SELECT nom, email FROM client`,
    audit: await tx`SELECT 1 FROM audit`,
  }));
  expect(reste.documents.map((x: { statut: string }) => x.statut)).toEqual(["emis"]);
  expect(reste.fichiers).toHaveLength(1);
  expect(reste.employes).toHaveLength(0);
  expect(reste.clients).toHaveLength(0);
  const [tn] = await sql`SELECT conservation_jusqua::text c FROM tenant WHERE id = ${a.body.tenantId}`;
  expect(tn.c).toBe("2036-12-31");

  // Immuabilité maintenue pendant la conservation, purge après son échéance.
  expect(await purgerConservationsEchues(sql)).toEqual([]);
  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.purge', ${a.body.tenantId}, true)`;
      await tx`DELETE FROM audit WHERE tenant_id = ${a.body.tenantId}`;
    }),
  ).rejects.toThrow("ajout seul");
  await sql`UPDATE tenant SET conservation_jusqua = current_date - 1 WHERE id = ${a.body.tenantId}`;
  expect(await purgerConservationsEchues(sql)).toEqual([a.body.tenantId]);
  expect(await sql`SELECT 1 FROM tenant WHERE id = ${a.body.tenantId}`).toHaveLength(0);
  expect(await sql`SELECT 1 FROM audit WHERE tenant_id = ${a.body.tenantId}`).toHaveLength(0);
});

// MinIO de compose.yaml (service minio) ; sans lui, test sauté explicitement.
const S3 = {
  endpoint: Bun.env.S3_ENDPOINT ?? "http://localhost:9010",
  bucket: Bun.env.S3_BUCKET ?? "auto-archives",
  accessKeyId: Bun.env.S3_ACCESS_KEY_ID ?? "auto",
  secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY ?? "auto-dev-minio",
};
const minio = await fetch(`${S3.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!minio) console.warn(`archivage S3 : MinIO absent (${S3.endpoint}), test sauté`);

test.skipIf(!minio)("archivage des exemplaires figés sur S3 (MinIO, verrou d'objet)", async () => {
  const s3 = new Bun.S3Client({ ...S3, region: "eu-west-3" });
  const a = await api("/v1/auth/inscription", undefined, { body: inscription("owner@delta.fr", "Delta") });
  const d = await api("/v1/documents", a.body.session, { body: facture });
  await api(`/v1/documents/${d.body.id}/emettre`, a.body.session, { body: {} });
  const r = await archiverFichiers(sql, a.body.tenantId, s3);
  expect(r).toHaveLength(1);
  expect(await archiverFichiers(sql, a.body.tenantId, s3)).toEqual([]);
  const octets = await s3.file(r[0]!.cle).bytes();
  expect(new Bun.CryptoHasher("sha256").update(octets).digest("hex")).toBe(r[0]!.sha256);
  const [arch] = await withTenant(sql, a.body.tenantId, (tx) => tx`SELECT conserver_jusqua::text c FROM archive_objet`);
  expect(arch.c).toBe("2036-12-31");
});

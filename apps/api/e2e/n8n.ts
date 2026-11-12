// Bout en bout API ↔ n8n : facture émise → outbox → worker → webhook signé → n8n relit le Factur-X via l'API → archive.
// Prérequis : Postgres de l'API (DATABASE_URL) et n8n (compose). Usage : bun apps/api/e2e/n8n.ts
import { testDb } from "@auto/store";
import { verifierPdfA } from "@auto/native";
import { creerApp } from "../src/app";
import { expediteur } from "../../worker/src/expediteur";
import { creerWorker } from "../../worker/src/worker";
import { N8N_URL, provisionner } from "../../../scripts/n8n";

const PORT = Number(Bun.env.AUTO_E2E_PORT ?? 3000); // AUTO_API_URL de n8n : host.docker.internal:3000
const SECRET = Bun.env.N8N_WEBHOOK_SECRET ?? "auto-dev-secret-webhook";
const ARCHIVES = new URL("../../../data/n8n/archives/", import.meta.url);

const { sql, drop } = await testDb();
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  routes: creerApp(sql),
  fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
});
// Livraison de l'outbox par le worker, dans ce processus.
const worker = creerWorker(sql, expediteur(sql, { url: `${N8N_URL}/webhook/auto-evenements`, secret: SECRET }), {
  intervalleMs: 200,
});
worker.demarrer();

async function api<T = any>(path: string, token?: string, body?: unknown): Promise<T> {
  const r = await fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} : HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

try {
  const a = await api("/v1/auth/inscription", undefined, {
    email: "e2e-n8n@exemple.fr",
    motDePasse: "un mot de passe long",
    entreprise: { nom: "E2E n8n SAS", siret: "73282932000074", adresse: "1 rue de la Paix, 75002 Paris" },
  });
  const { jeton } = await api("/v1/jetons", a.session, { nom: "n8n" });
  console.log(`n8n provisionné : ${(await provisionner(jeton)).join(", ")}`);

  const d = await api("/v1/documents", jeton, {
    type: "facture",
    client: { nom: "Client SAS", siret: "73282932000074", adresse: "2 rue B, Lyon" },
    lignes: [{ designation: "Automatisation", quantite: 2, prixUnitaireHtCents: 45000, tva: 200 }],
    datePrestation: new Date().toISOString().slice(0, 10),
    echeance: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
  });
  const e = await api(`/v1/documents/${d.id}/emettre`, jeton, {});
  console.log(`facture émise : ${e.numero}`);

  const archive = Bun.file(new URL(`${a.tenantId}_${e.numero}.pdf`, ARCHIVES));
  // Écriture par n8n via un montage : attendre une taille non nulle et stable.
  const fin = Date.now() + 60_000;
  let taille = -1;
  while (Date.now() < fin) {
    const f = Bun.file(archive.name!); // taille relue à chaque tour
    const t = (await f.exists()) ? f.size : -1;
    if (t > 0 && t === taille) break;
    taille = t;
    await Bun.sleep(1000);
  }
  if (taille <= 0) throw new Error(`archive absente : ${archive.name}`);

  const archivee = await archive.bytes();
  const officielle = new Uint8Array(
    await (
      await fetch(new URL(`/v1/documents/${d.id}/pdf`, server.url), { headers: { authorization: `Bearer ${jeton}` } })
    ).arrayBuffer(),
  );
  const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  if (sha(archivee) !== sha(officielle)) {
    const i = archivee.findIndex((o, k) => o !== officielle[k]);
    throw new Error(
      `archive différente du Factur-X de l'API : ${archivee.length} / ${officielle.length} octets, premier écart à ${i}`,
    );
  }
  const nonConformites = verifierPdfA(archivee);
  if (nonConformites.length) throw new Error(`archive non PDF/A-3b : ${nonConformites.join("; ")}`);
  await archive.delete();
  console.log(`OK : ${archive.name} (${archivee.length} octets, SHA-256 ${sha(archivee).slice(0, 16)}…, PDF/A-3b)`);
} finally {
  await worker.arreter();
  await server.stop(true);
  await drop();
}

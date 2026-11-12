// Worker : file de jobs Postgres (outbox des événements, tâches planifiées). Usage : bun run worker
import { webhookDepuisEnv } from "@auto/services";
import { connect } from "@auto/store";
import { automatisations } from "./automatisations";
import { abonnementsTenants, expediteur } from "./expediteur";
import { declencher, planifier, TACHES, tachesPlanifiees } from "./planification";
import { creerWorker } from "./worker";

const sql = connect();
const webhook = webhookDepuisEnv();
const planifies = tachesPlanifiees(sql);
const sourcesWorker = creerWorker(
  sql,
  { "sources.tenant": planifies["sources.tenant"]! },
  { bailMs: 15 * 60_000, lot: 1 },
);
delete planifies["sources.tenant"];
const courrierWorker = creerWorker(
  sql,
  { "courrier.compte": planifies["courrier.compte"]! },
  { bailMs: 10 * 60_000, lot: 1 },
);
delete planifies["courrier.compte"];
// Sans webhook, les événements restent dans l'outbox jusqu'à ce qu'un worker configuré les livre.
const worker = creerWorker(sql, {
  ...(webhook ? expediteur(sql, webhook) : {}),
  ...abonnementsTenants(sql),
  ...planifies,
  ...automatisations(sql),
});
// Les jobs serverless déclenchent une tâche explicite ou vident un nombre borné de lots.
const commande = process.argv[2];
if (commande === "--schedule") {
  const tache = TACHES.find((t) => t.nom === process.argv[3]);
  if (!tache) throw new Error(`Tâche inconnue : ${process.argv[3] ?? ""}`);
  try {
    await declencher(sql, tache);
  } finally {
    await sql.close();
  }
} else if (commande === "--once") {
  try {
    // Repasser sur les trois files : une tâche système peut créer des jobs dans une autre file.
    for (let tour = 0; tour < 100; tour++) {
      const nombres = await Promise.all([worker.traiterLot(), sourcesWorker.traiterLot(), courrierWorker.traiterLot()]);
      if (nombres.every((n) => n === 0)) break;
    }
  } finally {
    await sql.close();
  }
} else if (commande) {
  throw new Error(`Option worker inconnue : ${commande}`);
} else {
  const crons = Bun.env.AUTO_PLANIFICATION === "0" ? [] : planifier(sql);

  worker.demarrer();
  sourcesWorker.demarrer();
  courrierWorker.demarrer();
  console.log(
    `auto worker : livraison ${webhook ? webhook.url : "désactivée (N8N_WEBHOOK_URL absent)"}, ` +
      `${crons.length} tâches planifiées`,
  );

  async function arreter() {
    for (const c of crons) c.stop();
    await worker.arreter();
    await sourcesWorker.arreter();
    await courrierWorker.arreter();
    await sql.close();
    process.exit(0);
  }
  process.on("SIGINT", arreter);
  process.on("SIGTERM", arreter);
}

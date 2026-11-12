import { envoyeurDepuisEnv } from "@auto/mail";
import { connect, connectMigrations, migrate } from "@auto/store";
import { authDe, brancherEnvoyeur, migrerDeuxFacteurs, synchroniserOperateurs } from "@auto/tenancy";
import { creerApp } from "./app";
import { instrumenter } from "./observabilite";

const sql = connect();
const sqlMigrations = connectMigrations();
await migrate(sqlMigrations);
await sqlMigrations.close();

// Mails de Better Auth (invitations, liens magiques, réinitialisations) par le relais SMTP de l'opérateur.
const smtp = envoyeurDepuisEnv();
brancherEnvoyeur(async (m) => {
  await smtp.envoyer({ a: [m.a], sujet: m.sujet, texte: m.texte });
});

const routes = instrumenter(creerApp(sql));
// Reprise idempotente de l'ancienne 2FA et rôle global des opérateurs (plugin admin).
const repris = await migrerDeuxFacteurs(sql, authDe(sql));
if (repris) console.log(`2FA reprise pour ${repris} compte(s)`);
await synchroniserOperateurs(sql);

const server = Bun.serve({
  idleTimeout: 120,
  port: Number(Bun.env.PORT ?? 3000),
  hostname: Bun.env.AUTO_BIND_HOST ?? "0.0.0.0",
  // Événements écrits dans l'outbox ; livrés par le worker (bun run worker).
  routes,
  fetch: () => Response.json({ erreur: "route inconnue" }, { status: 404 }),
});

console.log(`auto api : ${server.url}`);

let arret = false;
async function arreter() {
  if (arret) return;
  arret = true;
  // Laisser finir les requêtes ; borner les connexions longues avant la limite Docker de 60 secondes.
  const limite = setTimeout(() => {
    void server.stop(true);
  }, 25_000);
  limite.unref();
  await server.stop();
  clearTimeout(limite);
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", arreter);
process.on("SIGTERM", arreter);

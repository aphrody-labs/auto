import { demarrerWeb } from "./serveur";

const server = demarrerWeb({
  api: Bun.env.AUTO_API_URL ?? "http://localhost:3000",
  port: Number(Bun.env.PORT ?? 3001),
  hostname: Bun.env.AUTO_BIND_HOST ?? "0.0.0.0",
  development: Bun.env.NODE_ENV !== "production",
});

console.log(`auto web : ${server.url}`);

let arret = false;
async function arreter() {
  if (arret) return;
  arret = true;
  const limite = setTimeout(() => {
    void server.stop(true);
  }, 25_000);
  limite.unref();
  await server.stop();
  clearTimeout(limite);
  process.exit(0);
}
process.on("SIGINT", arreter);
process.on("SIGTERM", arreter);

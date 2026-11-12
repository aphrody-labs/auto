import { demarrerAdmin } from "./serveur";

const server = demarrerAdmin({
  api: Bun.env.AUTO_API_URL ?? "http://localhost:3000",
  port: Number(Bun.env.PORT ?? 3002),
  development: Bun.env.NODE_ENV !== "production",
});

console.log(`auto admin : ${server.url}`);

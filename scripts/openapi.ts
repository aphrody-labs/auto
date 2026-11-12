// Écrit docs/openapi.json depuis apps/api/src/openapi.ts et le plugin openAPI de Better Auth. Usage, à la racine du dépôt : bun run openapi
import type { SQL } from "bun";
import { creerAuth } from "../packages/tenancy/src/auth";
import { specificationComplete } from "../apps/api/src/openapi";

const CIBLE = "docs/openapi.json";
// Aucune base ici : toute requête (amorçage des ressources OAuth au démarrage) reçoit un résultat vide.
const vide = async () => Object.assign([], { count: 0, command: "SELECT" });
const BASE_VIDE = { unsafe: vide, reserve: async () => ({ unsafe: vide, release() {} }) } as unknown as SQL;
await Bun.write(
  CIBLE,
  `${JSON.stringify(await specificationComplete(() => creerAuth(BASE_VIDE, { baseURL: "https://auto.aphrody.com", validerSchema: false }).api.generateOpenAPISchema()), null, 2)}\n`,
);
const p = Bun.spawnSync([process.execPath, "fmt", CIBLE], { stdout: "inherit", stderr: "inherit" });
if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
console.log(`écrit : ${CIBLE}`);

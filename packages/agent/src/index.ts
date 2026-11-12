// Agent et serveur MCP de l'API auto : outils typés sur /v1 avec le jeton de l'utilisateur, boucle d'agent LLM,
// serveur MCP stdio. Utilisés par la CLI (apps/cli) et le plugin (apps/plugin).
export { appelerOutil, executerAgent } from "./agent";
export { ApiAuto, apiDepuisEnv, ErreurApi } from "./api";
export { ServeurMcp } from "./mcp";
export { outil, OUTILS, type Outil } from "./outils";

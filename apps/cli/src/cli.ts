#!/usr/bin/env bun
// CLI `auto` : `auto agent [demande]` (boucle d'agent), `auto mcp` (serveur MCP stdio) et `auto flux` (workflows).
import { clientOpenAi, configLlmDepuisEnv, type Message } from "@auto/ingest/llm";
import { apiDepuisEnv, executerAgent, outil, OUTILS, ServeurMcp } from "@auto/agent";

const AIDE = `auto : agent et serveur MCP de l'API Auto

Usage :
  auto agent [demande…]   exécute une demande (sans demande : conversation sur l'entrée standard)
  auto mcp                serveur MCP sur stdio (pour Claude Code, Claude Desktop, etc.)
  auto outils             liste les outils
  auto flux               liste les workflows d'automatisation
  auto flux importer <fichier.json>   crée un workflow depuis sa définition ou un export n8n
  auto flux lancer <id> [json]        exécute un workflow, données d'entrée facultatives
  auto flux catalogue     types de nœuds et modèles

Variables :
  AUTO_API_URL   URL de l'API (défaut https://auto.aphrody.com ; http://localhost:3000 en développement)
  AUTO_TOKEN     jeton API de l'utilisateur (POST /v1/jetons) — obligatoire
  AUTO_LLM_URL   API compatible OpenAI pour \`auto agent\` (ex. http://localhost:8080/v1)
  AUTO_LLM_MODEL, AUTO_LLM_KEY, AUTO_LLM_TIMEOUT_MS`;

const erreur = (m: string): never => {
  console.error(`auto : ${m}`);
  process.exit(1);
};

async function agent(demande: string[]) {
  const api = apiDepuisEnv();
  const c = configLlmDepuisEnv() ?? erreur("AUTO_LLM_URL manquant (llama-server, Ollama…)");
  const llm = clientOpenAi(c);
  const surOutil = (nom: string, _args: unknown, ok: boolean) => console.error(`  · ${nom}${ok ? "" : " (erreur)"}`);
  if (demande.length) {
    console.log((await executerAgent(demande.join(" "), { llm, api, surOutil })).reponse);
    return;
  }
  let historique: Message[] = [];
  process.stderr.write("> ");
  for await (const ligne of console) {
    if (ligne.trim()) {
      const t = await executerAgent(ligne, { llm, api, historique, surOutil });
      historique = t.messages;
      console.log(t.reponse);
    }
    process.stderr.write("> ");
  }
}

/** Workflows : mêmes outils que le serveur MCP (un seul propriétaire des appels). */
async function flux([action, ...args]: string[]) {
  const api = apiDepuisEnv();
  const lancer = (nom: string, a: Record<string, unknown> = {}) => outil(nom)!.executer(api, a);
  let r: unknown;
  if (!action) r = await lancer("lister_automatisations");
  else if (action === "catalogue") r = await lancer("catalogue_automatisation");
  else if (action === "importer") {
    const chemin = args[0] ?? erreur("fichier manquant : auto flux importer <fichier.json>");
    const f = Bun.file(chemin);
    if (!(await f.exists())) erreur(`fichier introuvable : ${chemin}`);
    const j = (await f.json()) as Record<string, unknown>;
    // Export n8n reconnu à sa forme (nodes, connections) : converti par l'API.
    r =
      Array.isArray(j.nodes) && j.connections
        ? await lancer("importer_n8n", { workflow: j })
        : await lancer("creer_automatisation", "definition" in j ? j : { nom: chemin, definition: j });
  } else if (action === "lancer") {
    const id = args[0] ?? erreur("identifiant manquant : auto flux lancer <id> [json]");
    r = await lancer("executer_automatisation", { id, donnees: args[1] ? JSON.parse(args[1]) : undefined });
  } else erreur(`action inconnue : flux ${action}`);
  console.log(JSON.stringify(r, null, 2));
}

const [commande, ...reste] = Bun.argv.slice(2);
switch (commande) {
  case "agent":
    await agent(reste);
    break;
  case "mcp": {
    const s = new ServeurMcp(apiDepuisEnv());
    await s.servir(Bun.stdin.stream(), (l) => process.stdout.write(`${l}\n`));
    break;
  }
  case "flux":
    await flux(reste);
    break;
  case "outils":
    for (const o of OUTILS) console.log(`${o.nom.padEnd(24)} ${o.description}`);
    break;
  case undefined:
  case "aide":
  case "--help":
  case "-h":
    console.log(AIDE);
    break;
  default:
    erreur(`commande inconnue : ${commande}\n\n${AIDE}`);
}

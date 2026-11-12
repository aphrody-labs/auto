// Boucle d'agent : LLM compatible OpenAI avec appels d'outils, outils exécutés contre l'API /v1.
import type { ClientLlm, Message, OutilLlm } from "@auto/ingest/llm";
import { ErreurApi, type ApiAuto } from "./api";
import { OUTILS, type Outil } from "./outils";

export const SYSTEME = `Tu es l'assistant de gestion d'une entreprise française (devis, factures, paiements, relances, absences).
Tu agis uniquement par les outils fournis, avec les droits de l'utilisateur. Montants en centimes, TVA en dixièmes de pourcent.
Avant d'émettre un document ou d'enregistrer un paiement, vérifie l'identifiant avec un outil de lecture.
N'invente aucune donnée : si une information manque, demande-la. Réponds en français, brièvement.`;

export const versLlm = (outils: Outil[]): OutilLlm[] =>
  outils.map((o) => ({
    type: "function",
    function: { name: o.nom, description: o.description, parameters: o.schema },
  }));

/** Exécute un outil ; une erreur est renvoyée au modèle (et à l'appelant MCP) comme résultat en erreur. */
export async function appelerOutil(
  api: ApiAuto,
  outils: Outil[],
  nom: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; texte: string; valeur?: unknown }> {
  const o = outils.find((x) => x.nom === nom);
  if (!o) return { ok: false, texte: JSON.stringify({ erreur: `outil inconnu : ${nom}` }) };
  try {
    const v = await o.executer(api, args);
    return { ok: true, texte: typeof v === "string" ? v : JSON.stringify(v), valeur: v };
  } catch (e) {
    const err =
      e instanceof ErreurApi
        ? { erreur: e.message, status: e.status, details: e.details }
        : { erreur: (e as Error).message ?? String(e) };
    return { ok: false, texte: JSON.stringify(err) };
  }
}

export interface OptionsAgent {
  llm: ClientLlm;
  api: ApiAuto;
  outils?: Outil[];
  /** Historique d'une conversation en cours (sans le message système). */
  historique?: Message[];
  maxEtapes?: number;
  /** Trace des appels d'outils (CLI : affichage sur stderr). */
  surOutil?: (nom: string, args: unknown, ok: boolean) => void;
}

export interface Tour {
  reponse: string;
  messages: Message[];
  appels: { nom: string; args: Record<string, unknown>; ok: boolean }[];
}

export async function executerAgent(demande: string, o: OptionsAgent): Promise<Tour> {
  const outils = o.outils ?? OUTILS;
  const messages: Message[] = [...(o.historique ?? []), { role: "user", content: demande }];
  const appels: Tour["appels"] = [];
  const tools = versLlm(outils);
  for (let etape = 0; etape < (o.maxEtapes ?? 10); etape++) {
    const r = await o.llm.completer({ messages: [{ role: "system", content: SYSTEME }, ...messages], tools });
    messages.push({ role: "assistant", content: r.content, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) });
    if (!r.tool_calls?.length) return { reponse: r.content ?? "", messages, appels };
    for (const c of r.tool_calls) {
      let args: Record<string, unknown> = {};
      let res: Awaited<ReturnType<typeof appelerOutil>>;
      try {
        args = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
        res = await appelerOutil(o.api, outils, c.function.name, args);
      } catch {
        res = { ok: false, texte: JSON.stringify({ erreur: "arguments JSON invalides" }) };
      }
      appels.push({ nom: c.function.name, args, ok: res.ok });
      o.surOutil?.(c.function.name, args, res.ok);
      messages.push({ role: "tool", tool_call_id: c.id, content: res.texte });
    }
  }
  return { reponse: "Nombre maximal d'étapes atteint sans réponse finale.", messages, appels };
}

// Serveur MCP (Model Context Protocol) sur stdio : JSON-RPC 2.0, un message JSON par ligne.
// Méthodes : initialize, ping, tools/list, tools/call ; notifications ignorées sans réponse.
import { appelerOutil } from "./agent";
import type { ApiAuto } from "./api";
import { OUTILS, type Outil } from "./outils";

export const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const NOM = "auto";
const VERSION = "0.1.0";

type Id = string | number | null;
interface Requete {
  jsonrpc?: string;
  id?: Id;
  method?: unknown;
  params?: Record<string, unknown>;
}

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const ko = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export class ServeurMcp {
  constructor(
    private readonly api: ApiAuto,
    private readonly outils: Outil[] = OUTILS,
  ) {}

  /** Traite un message (ou un lot) ; null pour une notification. */
  async traiter(m: unknown): Promise<object | null> {
    if (Array.isArray(m)) {
      if (!m.length) return ko(null, -32600, "lot vide");
      const r = (await Promise.all(m.map((x) => this.traiter(x)))).filter((x) => x !== null);
      return r.length ? r : null;
    }
    const q = m as Requete;
    if (!q || typeof q !== "object" || q.jsonrpc !== "2.0" || typeof q.method !== "string")
      return ko(q && typeof q === "object" && "id" in q ? (q.id ?? null) : null, -32600, "requête JSON-RPC invalide");
    if (!("id" in q) || q.id === undefined) return null; // notification (notifications/initialized…)
    const id = q.id;
    const p = q.params ?? {};
    switch (q.method) {
      case "initialize": {
        const demandee = String(p.protocolVersion ?? "");
        return ok(id, {
          protocolVersion: VERSIONS.includes(demandee) ? demandee : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NOM, title: "Auto (automatisation et gestion)", version: VERSION },
          instructions:
            "Outils de gestion (devis, factures, paiements, relances, absences) exécutés avec le jeton API de l'utilisateur. Montants en centimes.",
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: this.outils.map((o) => ({
            name: o.nom,
            description: o.description,
            inputSchema: o.schema,
            annotations: { readOnlyHint: o.lecture, destructiveHint: false, openWorldHint: false },
          })),
        });
      case "tools/call": {
        const nom = p.name;
        if (typeof nom !== "string" || !this.outils.some((o) => o.nom === nom))
          return ko(id, -32602, `outil inconnu : ${String(nom)}`);
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== "object" || Array.isArray(args)) return ko(id, -32602, "arguments : objet attendu");
        const r = await appelerOutil(this.api, this.outils, nom, args);
        const structure = r.ok && r.valeur && typeof r.valeur === "object" && !Array.isArray(r.valeur);
        return ok(id, {
          content: [{ type: "text", text: r.texte }],
          ...(structure ? { structuredContent: r.valeur } : {}),
          isError: !r.ok,
        });
      }
      default:
        return ko(id, -32601, `méthode inconnue : ${q.method}`);
    }
  }

  /** Lit des lignes JSON sur `entree`, écrit les réponses sur `ecrire` ; se termine à la fin du flux. */
  async servir(entree: ReadableStream<Uint8Array>, ecrire: (ligne: string) => void): Promise<void> {
    const dec = new TextDecoder();
    const enCours = new Set<Promise<void>>();
    let tampon = "";
    const ligne = (l: string) => {
      if (!l.trim()) return;
      const t = (async () => {
        let m: unknown;
        try {
          m = JSON.parse(l);
        } catch {
          ecrire(JSON.stringify(ko(null, -32700, "JSON invalide")));
          return;
        }
        const r = await this.traiter(m).catch((e: Error) => ko((m as Requete)?.id ?? null, -32603, e.message));
        if (r) ecrire(JSON.stringify(r));
      })();
      enCours.add(t);
      void t.finally(() => enCours.delete(t));
    };
    for await (const morceau of entree) {
      tampon += dec.decode(morceau, { stream: true });
      let i: number;
      while ((i = tampon.indexOf("\n")) >= 0) {
        ligne(tampon.slice(0, i));
        tampon = tampon.slice(i + 1);
      }
    }
    ligne(tampon);
    await Promise.all(enCours);
  }
}

// Observabilité : un journal JSON par requête et des métriques Prometheus par route.
//
// Pas de données personnelles : la route est le motif (`/v1/documents/:id`), jamais l'URL réelle ;
// ni requête, ni corps, ni IP, ni email. Le tenant est un identifiant opaque (uuid), posé par la route
// authentifiée via `noterTenant` (aucune requête de plus).
import { AsyncLocalStorage } from "node:async_hooks";

export interface Journal {
  niveau: "info" | "erreur";
  date: string;
  methode: string;
  route: string;
  statut: number;
  dureeMs: number;
  tenant?: string;
}

const contexte = new AsyncLocalStorage<{ tenant?: string }>();

/** Appelée par la route authentifiée une fois l'appelant résolu. */
export function noterTenant(tenantId: string) {
  const c = contexte.getStore();
  if (c) c.tenant = tenantId;
}

const SEUILS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Serie {
  requetes: Map<number, number>;
  buckets: number[];
  somme: number;
  total: number;
}

export class Metriques {
  private series = new Map<string, Serie>();

  observer(methode: string, route: string, statut: number, secondes: number) {
    const k = `${methode} ${route}`;
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { requetes: new Map(), buckets: SEUILS.map(() => 0), somme: 0, total: 0 }));
    s.requetes.set(statut, (s.requetes.get(statut) ?? 0) + 1);
    SEUILS.forEach((le, i) => {
      if (secondes <= le) s.buckets[i]!++;
    });
    s.somme += secondes;
    s.total++;
  }

  /** Format d'exposition texte Prometheus 0.0.4. */
  texte(): string {
    const l = (v: string) => v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const req = [
      "# HELP auto_http_requetes_total Requêtes HTTP par route, méthode et statut.",
      "# TYPE auto_http_requetes_total counter",
    ];
    const dur = [
      "# HELP auto_http_duree_secondes Durée des requêtes HTTP par route et méthode.",
      "# TYPE auto_http_duree_secondes histogram",
    ];
    for (const [k, s] of [...this.series].sort(([a], [b]) => a.localeCompare(b))) {
      const [methode, route] = k.split(" ") as [string, string];
      const base = `route="${l(route)}",methode="${methode}"`;
      for (const [statut, n] of [...s.requetes].sort(([a], [b]) => a - b))
        req.push(`auto_http_requetes_total{${base},statut="${statut}"} ${n}`);
      SEUILS.forEach((le, i) => dur.push(`auto_http_duree_secondes_bucket{${base},le="${le}"} ${s.buckets[i]}`));
      dur.push(`auto_http_duree_secondes_bucket{${base},le="+Inf"} ${s.total}`);
      dur.push(`auto_http_duree_secondes_sum{${base}} ${s.somme}`);
      dur.push(`auto_http_duree_secondes_count{${base}} ${s.total}`);
    }
    return `${req.join("\n")}\n${dur.join("\n")}\n`;
  }
}

type Gestionnaire = (req: Request, server?: unknown) => Response | Promise<Response>;

export interface OptionsObservabilite {
  journal?: (j: Journal) => void;
  metriques?: Metriques;
  /** Jeton Bearer exigé sur /metrics (`AUTO_METRICS_JETON`) ; sans jeton, /metrics est ouvert (dev). */
  jetonMetriques?: string;
}

/** Enveloppe chaque route (`Bun.serve({ routes })`) et ajoute `GET /metrics`. */
export function instrumenter<T extends Record<string, unknown>>(
  routes: T,
  {
    journal = (j) => console.log(JSON.stringify(j)),
    metriques = new Metriques(),
    jetonMetriques = Bun.env.AUTO_METRICS_JETON,
  }: OptionsObservabilite = {},
): T {
  const envelopper =
    (route: string, methode: string | null, fn: Gestionnaire): Gestionnaire =>
    (req, server) => {
      const debut = Bun.nanoseconds();
      const c: { tenant?: string } = {};
      const fin = (statut: number) => {
        const secondes = (Bun.nanoseconds() - debut) / 1e9;
        const m = methode ?? req.method;
        metriques.observer(m, route, statut, secondes);
        journal({
          niveau: statut >= 500 ? "erreur" : "info",
          date: new Date().toISOString(),
          methode: m,
          route,
          statut,
          dureeMs: Math.round(secondes * 1e6) / 1e3,
          ...(c.tenant ? { tenant: c.tenant } : {}),
        });
      };
      return contexte.run(c, async () => {
        try {
          const r = await fn(req, server);
          fin(r.status);
          return r;
        } catch (e) {
          fin(500);
          throw e;
        }
      });
    };

  const sortie: Record<string, unknown> = {};
  for (const [route, h] of Object.entries(routes)) {
    if (typeof h === "function") sortie[route] = envelopper(route, null, h as Gestionnaire);
    else if (h && typeof h === "object" && !(h instanceof Response))
      sortie[route] = Object.fromEntries(
        Object.entries(h).map(([m, f]) => [m, typeof f === "function" ? envelopper(route, m, f as Gestionnaire) : f]),
      );
    else sortie[route] = h;
  }
  sortie["/metrics"] = {
    GET: (req: Request) => {
      if (jetonMetriques && req.headers.get("authorization") !== `Bearer ${jetonMetriques}`)
        return new Response("non authentifié\n", { status: 401 });
      return new Response(metriques.texte(), { headers: { "content-type": "text/plain; version=0.0.4" } });
    },
  };
  return sortie as T;
}

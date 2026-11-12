// Import d'un workflow exporté de n8n (JSON « nodes » + « connections ») vers une définition auto. Les nœuds
// courants sont convertis (déclencheurs, HTTP, Si, Définir, Filtrer, Trier, Limiter, Attendre, RSS, HTML,
// Discord, Telegram, mail…) ; les expressions n8n réduites à des chemins (`$json.x`, `$('Nœud').item.json.x`)
// sont traduites. Le reste est signalé dans les avertissements, jamais deviné.
import type { Connexion, Definition, Noeud } from "./schema";

interface NoeudN8n {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  position?: [number, number];
  disabled?: boolean;
  continueOnFail?: boolean;
  onError?: string;
  retryOnFail?: boolean;
  /** Essais au total (n8n : 3 par défaut). */
  maxTries?: number;
  waitBetweenTries?: number;
}

/** « Retry On Fail » de n8n : essais au total → nouveaux essais d'auto (5 au plus), attente reprise. */
const essais = (n: NoeudN8n) =>
  n.retryOnFail
    ? {
        tentatives: Math.min(5, Math.max(0, (n.maxTries ?? 3) - 1)),
        delaiEssaiMs: Math.min(60_000, Math.max(0, n.waitBetweenTries ?? 1000)),
      }
    : { tentatives: 0, delaiEssaiMs: 1000 };

interface WorkflowN8n {
  name?: string;
  nodes: NoeudN8n[];
  connections: Record<string, { main?: ({ node: string; index?: number }[] | null)[] }>;
}

export interface ImportN8n {
  nom: string;
  definition: Definition;
  avertissements: string[];
  /** n8n admet plusieurs déclencheurs par workflow : chaque déclencheur supplémentaire donne un workflow. */
  autres: { nom: string; definition: Definition }[];
}

export const estN8n = (j: unknown): j is WorkflowN8n =>
  !!j &&
  typeof j === "object" &&
  Array.isArray((j as WorkflowN8n).nodes) &&
  typeof (j as WorkflowN8n).connections === "object";

const slug = (s: string, pris: Set<string>) => {
  const base =
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34) || "noeud";
  let id = base;
  for (let i = 2; pris.has(id); i++) id = `${base}-${i}`;
  pris.add(id);
  return id;
};

const OPERATIONS: Record<string, string> = {
  equals: "egal",
  notEquals: "different",
  contains: "contient",
  notContains: "ne_contient_pas",
  startsWith: "commence_par",
  gt: "superieur",
  gte: "superieur",
  lt: "inferieur",
  lte: "inferieur",
  empty: "vide",
  notEmpty: "non_vide",
  exists: "non_vide",
  notExists: "vide",
  true: "vrai",
  false: "faux",
  regex: "correspond",
};

const INTERVALLES: Record<string, (v: number) => string> = {
  minutes: (v) => `*/${v} * * * *`,
  hours: (v) => `0 */${v} * * *`,
  days: () => "0 0 * * *",
  weeks: () => "0 0 * * 1",
  months: () => "0 0 1 * *",
};

export function importerN8n(w: WorkflowN8n): ImportN8n {
  const avertissements: string[] = [];
  const pris = new Set<string>();
  const ids = new Map<string, string>();
  for (const n of w.nodes) ids.set(n.name, slug(n.name, pris));

  /** Expression n8n → expression auto ; les expressions JavaScript non réductibles sont signalées. */
  const expr = (v: unknown, ou: string): unknown => {
    if (typeof v !== "string" || !v.startsWith("=")) return v;
    const s = v
      .slice(1)
      .replace(/\$\(\s*['"]([^'"]+)['"]\s*\)\.(?:item|first\(\)|last\(\))\.json/g, (_, nom: string) =>
        ids.has(nom) ? `$noeud.${ids.get(nom)}.json` : `$noeud.${nom}.json`,
      )
      .replace(/\$node\[\s*['"]([^'"]+)['"]\s*\]\.json/g, (_, nom: string) => `$noeud.${ids.get(nom) ?? nom}.json`)
      .replace(/\$now\b/g, "$maintenant")
      .replace(/\$today\b/g, "$aujourdhui");
    for (const m of s.matchAll(/\{\{([\s\S]+?)\}\}/g))
      if (!/^\s*\$[a-z]+(\.[\p{L}\p{N}_$-]+|\[\d+\]|\["[^"]*"\])*\s*$/iu.test(m[1]!))
        avertissements.push(`${ou} : expression à revoir ({{${m[1]}}}), seuls les chemins sont pris en charge`);
    return s;
  };
  const tout = (o: unknown, ou: string): unknown =>
    Array.isArray(o)
      ? o.map((x) => tout(x, ou))
      : o && typeof o === "object"
        ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, tout(x, ou)]))
        : expr(o, ou);

  const conditions = (p: Record<string, unknown>, ou: string) => {
    const c = (p.conditions ?? {}) as { conditions?: Record<string, unknown>[]; combinator?: string };
    const liste = (c.conditions ?? []).map((x) => {
      const op = (x.operator as { operation?: string } | undefined)?.operation ?? "equals";
      if (!OPERATIONS[op]) avertissements.push(`${ou} : opérateur ${op} remplacé par « égal »`);
      return { gauche: expr(x.leftValue, ou), operateur: OPERATIONS[op] ?? "egal", droite: expr(x.rightValue, ou) };
    });
    if (!liste.length) avertissements.push(`${ou} : conditions de l'ancien format à ressaisir`);
    return {
      conditions: liste.length ? liste : [{ gauche: "", operateur: "non_vide" }],
      combinaison: c.combinator === "or" ? "ou" : "et",
    };
  };

  const noeuds: Noeud[] = [];
  for (const n of w.nodes) {
    const ou = `« ${n.name} »`;
    const p = (n.parameters ?? {}) as Record<string, unknown>;
    const court = n.type.replace(/^n8n-nodes-base\./, "");
    let type: string | null = null;
    let parametres: Record<string, unknown> = {};
    let note: string | undefined;
    switch (court) {
      case "manualTrigger":
      case "executeWorkflowTrigger":
        type = "declencheur.manuel";
        break;
      case "webhook":
      case "formTrigger":
        type = "declencheur.webhook";
        parametres = { reponse: p.responseMode === "lastNode" ? "fin" : "immediate" };
        break;
      case "scheduleTrigger":
      case "cron": {
        type = "declencheur.planifie";
        const i = ((p.rule as { interval?: Record<string, unknown>[] })?.interval ?? [])[0] ?? {};
        let cron = typeof i.expression === "string" ? i.expression : null;
        if (!cron && typeof i.field === "string" && INTERVALLES[i.field])
          cron = INTERVALLES[i.field]!(Number(i[`${i.field}Interval`] ?? 1));
        if (cron && cron.trim().split(/\s+/).length === 6) cron = cron.trim().split(/\s+/).slice(1).join(" ");
        if (!cron) avertissements.push(`${ou} : planification non reconnue, toutes les heures par défaut`);
        parametres = { cron: cron ?? "0 * * * *", fuseau: "Europe/Paris" };
        break;
      }
      case "httpRequest": {
        type = "reseau.http";
        const paires = (k: string) =>
          (((p[k] as { parameters?: { name: string; value: unknown }[] }) ?? {}).parameters ?? []).map((x) => ({
            nom: x.name,
            valeur: expr(x.value, ou),
          }));
        let corps: unknown;
        if (p.sendBody) {
          if (typeof p.jsonBody === "string") {
            const brut = expr(p.jsonBody, ou);
            try {
              corps = JSON.parse(String(brut));
            } catch {
              corps = brut;
            }
          } else corps = Object.fromEntries(paires("bodyParameters").map((x) => [x.nom, x.valeur]));
        }
        parametres = {
          methode: String(p.method ?? "GET").toUpperCase(),
          url: expr(p.url, ou),
          entetes: p.sendHeaders ? paires("headerParameters") : [],
          requete: p.sendQuery ? paires("queryParameters") : [],
          ...(corps === undefined ? {} : { corps }),
        };
        if (p.authentication && p.authentication !== "none")
          avertissements.push(`${ou} : authentification n8n à remplacer par un en-tête utilisant {{ $secret.nom }}`);
        break;
      }
      case "if":
        type = "logique.si";
        parametres = conditions(p, ou);
        break;
      case "filter":
        type = "donnees.filtrer";
        parametres = conditions(p, ou);
        break;
      case "set": {
        type = "donnees.definir";
        const a = ((p.assignments as { assignments?: { name: string; value: unknown }[] }) ?? {}).assignments ?? [];
        parametres = {
          champs: a.map((x) => ({ nom: x.name, valeur: expr(x.value, ou) })),
          conserver: Boolean(p.includeOtherFields ?? false),
        };
        if (!a.length) avertissements.push(`${ou} : champs de l'ancien format à ressaisir`);
        if (!a.length) parametres.champs = [{ nom: "champ", valeur: "" }];
        break;
      }
      case "wait":
        type = "logique.attendre";
        parametres = { secondes: Math.min(60, Number(p.amount ?? 1) * (p.unit === "minutes" ? 60 : 1)) };
        if (Number(p.amount ?? 1) * (p.unit === "minutes" ? 60 : 1) > 60)
          avertissements.push(`${ou} : attente ramenée à 60 secondes`);
        break;
      case "limit":
        type = "donnees.limiter";
        parametres = { max: Number(p.maxItems ?? 1) };
        break;
      case "sort": {
        type = "donnees.trier";
        const f = ((p.sortFieldsUi as { sortField?: { fieldName: string; order?: string }[] }) ?? {}).sortField?.[0];
        parametres = { champ: f?.fieldName ?? "id", ordre: f?.order === "descending" ? "decroissant" : "croissant" };
        break;
      }
      case "removeDuplicates":
        type = "donnees.dedoublonner";
        parametres = {
          champ:
            String(p.fieldsToCompare ?? "id")
              .split(",")[0]!
              .trim() || "id",
        };
        break;
      case "splitOut":
        type = "donnees.separer";
        parametres = { champ: String(p.fieldToSplitOut ?? "") };
        break;
      case "aggregate":
        type = "donnees.agreger";
        parametres = { champ: "elements" };
        break;
      case "rssFeedRead":
        type = "reseau.flux";
        parametres = { url: expr(p.url, ou), max: 50 };
        break;
      case "stopAndError":
        type = "logique.arreter";
        parametres = { message: String(expr(p.errorMessage, ou) ?? "erreur") || "erreur" };
        break;
      case "discord":
        type = "communication.discord";
        parametres = { webhook: "{{ $secret.discord }}", texte: expr(p.content ?? p.text, ou) };
        avertissements.push(`${ou} : webhook Discord à fournir dans le secret « discord »`);
        break;
      case "telegram":
        type = "communication.telegram";
        parametres = { jeton: "{{ $secret.telegram_bot }}", chat: expr(p.chatId, ou), texte: expr(p.text, ou) };
        avertissements.push(`${ou} : jeton du bot à fournir dans le secret « telegram_bot »`);
        break;
      case "emailSend":
        type = "communication.mail";
        parametres = { a: expr(p.toEmail, ou), sujet: expr(p.subject, ou), texte: expr(p.text ?? p.html, ou) };
        break;
      case "slack":
        type = "communication.slack";
        parametres = { webhook: "{{ $secret.slack }}", texte: expr(p.text, ou) };
        avertissements.push(`${ou} : message envoyé par webhook entrant (secret « slack »), canal fixé par ce webhook`);
        break;
      case "noOp":
        type = "logique.passer";
        break;
      case "code": {
        type = "donnees.code";
        const js = String(p.jsCode ?? "");
        parametres = {
          mode: p.mode === "runOnceForEachItem" ? "element" : "lot",
          code: js.replace(/\$\(\s*(['"])([^'"]+)\1\s*\)/g, (m, q: string, nom: string) =>
            ids.has(nom) ? `$(${q}${ids.get(nom)}${q})` : m,
          ),
        };
        if (p.language && p.language !== "javaScript") {
          type = "logique.passer";
          parametres = {};
          note = `À remplacer : code ${String(p.language)} non pris en charge`;
          avertissements.push(`${ou} : code ${String(p.language)} non pris en charge, laissé en « Laisser passer »`);
        } else if (/this\.helpers|\$binary|\brequire\(|\$env|\$vars|\bfetch\(/.test(js))
          avertissements.push(
            `${ou} : le code utilise des fonctions de n8n absentes du bac à sable (helpers, binaire, require, réseau) : à adapter`,
          );
        // Le code JavaScript ne passe pas par les expressions {{ }}.
        noeuds.push({
          id: ids.get(n.name)!,
          type,
          nom: n.name.slice(0, 80),
          parametres,
          position: [n.position?.[0] ?? 0, n.position?.[1] ?? 0],
          desactive: Boolean(n.disabled),
          continuerSurErreur: Boolean(n.continueOnFail) || n.onError === "continueRegularOutput",
          ...essais(n),
          ...(note ? { note } : {}),
        });
        continue;
      }
      case "stickyNote":
        // Note d'annotation du canevas : sans effet sur l'exécution.
        break;
      default:
        // Emplacement gardé dans le graphe (connexions intactes), à remplacer dans l'éditeur.
        type = "logique.passer";
        note = `À remplacer : nœud n8n ${n.type}`;
        avertissements.push(`${ou} : nœud ${n.type} non pris en charge, laissé en « Laisser passer » à remplacer`);
    }
    if (!type) continue;
    noeuds.push({
      id: ids.get(n.name)!,
      type,
      nom: n.name.slice(0, 80),
      parametres: tout(parametres, ou) as Record<string, unknown>,
      position: [n.position?.[0] ?? 0, n.position?.[1] ?? 0],
      desactive: Boolean(n.disabled),
      continuerSurErreur: Boolean(n.continueOnFail) || n.onError === "continueRegularOutput",
      ...essais(n),
      ...(note ? { note } : {}),
    });
  }

  const presents = new Set(noeuds.map((n) => n.id));
  const connexions: Connexion[] = [];
  for (const [source, sorties] of Object.entries(w.connections ?? {}))
    for (const [sortie, liste] of (sorties.main ?? []).entries())
      for (const c of liste ?? []) {
        const de = ids.get(source);
        const vers = ids.get(c.node);
        if (de && vers && presents.has(de) && presents.has(vers)) connexions.push({ de, sortie, vers });
      }

  // Un graphe par déclencheur (nœuds atteignables) ; les nœuds atteints par aucun déclencheur reconnu
  // reçoivent un lancement manuel.
  const suivants = new Map<string, string[]>();
  for (const c of connexions) suivants.set(c.de, [...(suivants.get(c.de) ?? []), c.vers]);
  const atteints = (depart: string) => {
    const vus = new Set([depart]);
    for (const file = [depart]; file.length;)
      for (const v of suivants.get(file.shift()!) ?? [])
        if (!vus.has(v)) {
          vus.add(v);
          file.push(v);
        }
    return vus;
  };
  const graphe = (ids: Set<string>): Definition => ({
    noeuds: noeuds.filter((n) => ids.has(n.id)),
    connexions: connexions.filter((c) => ids.has(c.de) && ids.has(c.vers)),
  });
  const nom = (w.name ?? "Workflow importé de n8n").slice(0, 100);
  const declencheurs = noeuds.filter((n) => n.type.startsWith("declencheur."));
  const parties = declencheurs.map((d) => ({
    nom: declencheurs.length > 1 ? `${nom} : ${d.nom}` : nom,
    ids: atteints(d.id),
  }));
  const couverts = new Set(parties.flatMap((p) => [...p.ids]));
  const orphelins = noeuds.filter((n) => !couverts.has(n.id));
  if (orphelins.length) {
    const ids = new Set(orphelins.map((n) => n.id));
    const cibles = new Set(connexions.filter((c) => ids.has(c.de) && ids.has(c.vers)).map((c) => c.vers));
    const manuel: Noeud = {
      id: slug("declencheur", pris),
      type: "declencheur.manuel",
      nom: "Lancement manuel",
      parametres: {},
      position: [Math.min(0, ...orphelins.map((n) => n.position[0])) - 280, orphelins[0]!.position[1]],
      desactive: false,
      continuerSurErreur: false,
      tentatives: 0,
      delaiEssaiMs: 1000,
    };
    noeuds.push(manuel);
    for (const r of orphelins.filter((n) => !cibles.has(n.id)))
      connexions.push({ de: manuel.id, sortie: 0, vers: r.id });
    ids.add(manuel.id);
    parties.push({ nom: parties.length ? `${nom} : lancement manuel` : nom, ids });
    avertissements.push(
      parties.length > 1
        ? `${orphelins.length} nœuds sans déclencheur reconnu : lancement manuel ajouté`
        : "aucun déclencheur reconnu : lancement manuel ajouté",
    );
  }
  if (parties.length > 1)
    avertissements.push(`${parties.length} déclencheurs : importé en ${parties.length} workflows`);
  const [premier, ...autres] = parties.map((p) => ({ nom: p.nom.slice(0, 120), definition: graphe(p.ids) }));
  return { ...premier!, avertissements, autres };
}

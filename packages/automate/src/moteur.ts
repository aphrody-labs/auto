// Moteur d'exécution : parcourt le graphe depuis le déclencheur, résout les expressions de chaque nœud
// sur ses éléments, applique ses sorties aux connexions et consigne chaque étape. Bornes : nombre d'étapes,
// d'éléments par nœud et durée totale, pour qu'un workflow d'une entreprise ne monopolise pas le worker.
import { ErreurExpression, resoudre, type Portee } from "./expressions";
import { CATALOGUE, sortiesDe, type Contexte, type Services, type Sorties, type TypeNoeud } from "./noeuds";
import { Definition, estDeclencheur, type Element, type Noeud } from "./schema";

export interface Etape {
  noeud: string;
  nom: string;
  type: string;
  debut: string;
  dureeMs: number;
  entree: number;
  /** Nombre d'éléments par sortie. */
  sorties: number[];
  /** Aperçu des premiers éléments produits (tronqué). */
  apercu: Element[];
  erreur?: string;
}

export interface Resultat {
  statut: "succes" | "erreur";
  etapes: Etape[];
  erreur?: { noeud: string; message: string };
  /** Éléments produits par les derniers nœuds atteints. */
  sortie: Element[];
}

export interface OptionsExecution {
  services: Services;
  workflow: { id: string; nom: string };
  executionId: string;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  maxEtapes?: number;
  maxElements?: number;
  dureeMaxMs?: number;
}

export class ErreurDefinition extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/** Validation complète : schéma, types connus, paramètres, connexions, un déclencheur, aucun cycle. */
export function valider(brute: unknown): Definition {
  const r = Definition.safeParse(brute);
  if (!r.success)
    throw new ErreurDefinition(
      "définition invalide",
      r.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`),
    );
  const d = r.data;
  const details: string[] = [];
  const ids = new Set<string>();
  for (const n of d.noeuds) {
    if (ids.has(n.id)) details.push(`nœud ${n.id} : identifiant en double`);
    ids.add(n.id);
    const type = CATALOGUE.get(n.type);
    if (!type) {
      details.push(`nœud ${n.id} : type inconnu ${n.type}`);
      continue;
    }
    // Les expressions ne sont connues qu'à l'exécution : seuls les paramètres sans expression sont vérifiés ici.
    if (!JSON.stringify(n.parametres).includes("{{")) {
      const p = type.parametres.safeParse(n.parametres);
      if (!p.success)
        for (const i of p.error.issues)
          details.push(`nœud ${n.id} : ${i.path.join(".") || "paramètres"} : ${i.message}`);
    }
  }
  const declencheurs = d.noeuds.filter((n) => estDeclencheur(n.type));
  if (declencheurs.length !== 1) details.push("un et un seul déclencheur par workflow");
  for (const c of d.connexions) {
    if (!ids.has(c.de) || !ids.has(c.vers)) details.push(`connexion ${c.de} → ${c.vers} : nœud absent`);
    else if (estDeclencheur(d.noeuds.find((n) => n.id === c.vers)!.type))
      details.push(`connexion ${c.de} → ${c.vers} : un déclencheur n'a pas d'entrée`);
  }
  if (!details.length && aUnCycle(d)) details.push("le graphe contient un cycle");
  if (details.length) throw new ErreurDefinition("définition invalide", details);
  return d;
}

function aUnCycle(d: Definition): boolean {
  const suivants = new Map<string, string[]>();
  for (const c of d.connexions) suivants.set(c.de, [...(suivants.get(c.de) ?? []), c.vers]);
  const etat = new Map<string, 1 | 2>();
  const visiter = (id: string): boolean => {
    if (etat.get(id) === 1) return true;
    if (etat.get(id) === 2) return false;
    etat.set(id, 1);
    for (const s of suivants.get(id) ?? []) if (visiter(s)) return true;
    etat.set(id, 2);
    return false;
  };
  return d.noeuds.some((n) => visiter(n.id));
}

export const declencheurDe = (d: Definition): Noeud => d.noeuds.find((n) => estDeclencheur(n.type))!;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function apercu(els: Element[]): Element[] {
  return els.slice(0, 5).map((e) => {
    const s = JSON.stringify(e.json);
    return s.length <= 4000 ? e : { json: { apercu: `${s.slice(0, 4000)}…`, tronque: true } };
  });
}

/**
 * Appel d'un nœud avec ses nouveaux essais (`tentatives`, attente `delaiEssaiMs` doublée à chaque fois). Une erreur
 * de paramètres ou d'expression ne se répare pas en réessayant : elle n'est pas reprise.
 */
export async function essayer<T>(noeud: Noeud, signal: AbortSignal, appel: () => Promise<T>): Promise<T> {
  for (let essai = 0; ; essai++) {
    try {
      return await appel();
    } catch (e) {
      if (essai >= noeud.tentatives || signal.aborted || e instanceof ErreurExpression) throw e;
      await new Promise<void>((ok, ko) => {
        const t = setTimeout(ok, noeud.delaiEssaiMs * 2 ** essai);
        signal.addEventListener("abort", () => (clearTimeout(t), ko(signal.reason)), { once: true });
      });
    }
  }
}

async function lancerNoeud(
  type: TypeNoeud,
  noeud: Noeud,
  els: Element[],
  portee: (el: Element, i: number) => Portee,
  ctx: Contexte,
): Promise<Sorties> {
  const parametres = (el: Element, i: number) => {
    const resolus = resoudre(noeud.parametres, portee(el, i));
    const p = type.parametres.safeParse(resolus);
    if (!p.success)
      throw new ErreurExpression(
        p.error.issues.map((x) => `${x.path.join(".") || "paramètres"} : ${x.message}`).join(" ; "),
      );
    return p.data;
  };
  if (type.lot) {
    const p = parametres(els[0] ?? { json: {} }, 0);
    return essayer(noeud, ctx.signal, () => type.lot!(p, els, ctx));
  }
  const nb = sortiesDe(type, noeud.parametres).length;
  const sorties: Sorties = [];
  for (const [i, el] of els.entries()) {
    if (ctx.signal.aborted) throw new Error("exécution interrompue (durée maximale atteinte)");
    let r: Sorties;
    try {
      const p = parametres(el, i);
      r = await essayer(noeud, ctx.signal, () => type.element!(p, el, ctx));
    } catch (e) {
      if (!noeud.continuerSurErreur) throw e;
      r = [[{ json: { ...el.json, erreur: message(e) } }]];
    }
    for (const [s, liste] of r.entries()) (sorties[s] ??= []).push(...liste);
  }
  while (sorties.length < nb) sorties.push([]);
  return sorties;
}

/** Exécute un workflow validé avec les éléments du déclencheur. */
export async function executer(def: Definition, entree: Element[], o: OptionsExecution): Promise<Resultat> {
  const { maxEtapes = 500, maxElements = 5000, dureeMaxMs = 5 * 60_000 } = o;
  const signal = AbortSignal.any([AbortSignal.timeout(dureeMaxMs), ...(o.signal ? [o.signal] : [])]);
  const vus: Record<string, Record<string, unknown>> = {};
  const ctx: Contexte = {
    services: o.services,
    signal,
    noeud: "",
    vus,
    execution: { id: o.executionId },
    workflow: o.workflow,
  };
  const parId = new Map(def.noeuds.map((n) => [n.id, n]));
  const sortants = new Map<string, { sortie: number; vers: string }[]>();
  for (const c of def.connexions) sortants.set(c.de, [...(sortants.get(c.de) ?? []), c]);

  const etapes: Etape[] = [];
  const terminaux: Element[] = [];
  const file: { id: string; els: Element[] }[] = [
    { id: declencheurDe(def).id, els: entree.length ? entree : [{ json: {} }] },
  ];

  const portee = (el: Element, index: number): Portee => ({
    json: el.json,
    noeuds: vus,
    secrets: o.secrets ?? {},
    execution: { id: o.executionId },
    workflow: o.workflow,
    index,
  });

  while (file.length) {
    const { id, els } = file.shift()!;
    const noeud = parId.get(id)!;
    const type = CATALOGUE.get(noeud.type)!;
    if (etapes.length >= maxEtapes)
      return { statut: "erreur", etapes, erreur: { noeud: id, message: `plus de ${maxEtapes} étapes` }, sortie: [] };
    const debut = new Date();
    let sorties: Sorties;
    try {
      if (signal.aborted) throw new Error("exécution interrompue (durée maximale atteinte)");
      if (els.length > maxElements) throw new Error(`plus de ${maxElements} éléments en entrée`);
      sorties =
        estDeclencheur(noeud.type) || noeud.desactive
          ? [els]
          : await lancerNoeud(type, noeud, els, portee, { ...ctx, noeud: id });
    } catch (e) {
      etapes.push({
        noeud: id,
        nom: noeud.nom,
        type: noeud.type,
        debut: debut.toISOString(),
        dureeMs: Date.now() - debut.getTime(),
        entree: els.length,
        sorties: [],
        apercu: [],
        erreur: message(e),
      });
      return { statut: "erreur", etapes, erreur: { noeud: id, message: message(e) }, sortie: [] };
    }
    etapes.push({
      noeud: id,
      nom: noeud.nom,
      type: noeud.type,
      debut: debut.toISOString(),
      dureeMs: Date.now() - debut.getTime(),
      entree: els.length,
      sorties: sorties.map((s) => s.length),
      apercu: apercu(sorties.find((s) => s.length) ?? []),
    });
    const premier = sorties.find((s) => s.length)?.[0];
    if (premier) vus[id] = premier.json;
    const suite = sortants.get(id) ?? [];
    if (!suite.length) terminaux.push(...sorties.flat());
    for (const c of suite) {
      const liste = sorties[c.sortie] ?? [];
      if (liste.length) file.push({ id: c.vers, els: liste });
    }
  }
  return { statut: "succes", etapes, sortie: terminaux.slice(0, 100) };
}

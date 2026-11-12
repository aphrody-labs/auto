// Conversion entre la définition d'un workflow (moteur `@auto/automate`) et l'état du canevas React Flow.
// Une connexion `{ de, sortie, vers }` devient une arête dont la poignée source vaut `s<sortie>` ; l'aller-retour
// est sans perte (positions arrondies au pixel).
import type { Connexion, Definition, Noeud } from "@auto/automate";
import type { Etape, TypeNoeudApi } from "@auto/client";
import type { Edge, Node, XYPosition } from "@xyflow/react";
import { valeursInitiales } from "./formulaire";

export interface DonneesEtape extends Record<string, unknown> {
  noeud: Noeud;
  /** Étape de la dernière exécution affichée (essai ou historique). */
  resultat?: Etape;
}

export type NoeudFlux = Node<DonneesEtape, "etape">;
export type AreteFlux = Edge;

export const estDeclencheur = (type: string) => type.startsWith("declencheur.");

export const poignee = (sortie: number) => `s${sortie}`;
export const sortieDePoignee = (h: string | null | undefined) => (h && /^s\d+$/.test(h) ? Number(h.slice(1)) : 0);
export const idArete = (c: Connexion) => `${c.de}:${c.sortie}>${c.vers}`;

/** Libellés des sorties d'un nœud : fixes, ou déduits des cas d'un aiguillage. */
export function sortiesNoeud(noeud: Pick<Noeud, "parametres">, type: TypeNoeudApi | undefined): string[] {
  if (!type) return ["principale"];
  if (Array.isArray(type.sorties)) return type.sorties;
  const cas = noeud.parametres.cas;
  if (Array.isArray(cas)) return [...cas.map((c, i) => String(c ?? "").trim() || `cas ${i + 1}`), "autre"];
  return ["principale"];
}

export function areteDe(c: Connexion): AreteFlux {
  return { id: idArete(c), source: c.de, sourceHandle: poignee(c.sortie), target: c.vers };
}

export function versFlux(def: Definition): { nodes: NoeudFlux[]; edges: AreteFlux[] } {
  return {
    nodes: def.noeuds.map((n) => ({
      id: n.id,
      type: "etape" as const,
      position: { x: n.position[0], y: n.position[1] },
      data: { noeud: n },
      deletable: true,
    })),
    edges: def.connexions.map(areteDe),
  };
}

export function versDefinition(nodes: NoeudFlux[], edges: AreteFlux[]): Definition {
  const ids = new Set(nodes.map((n) => n.id));
  const vues = new Set<string>();
  const connexions: Connexion[] = [];
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const c = { de: e.source, sortie: sortieDePoignee(e.sourceHandle), vers: e.target };
    if (vues.has(idArete(c))) continue;
    vues.add(idArete(c));
    connexions.push(c);
  }
  return {
    noeuds: nodes.map((n) => ({
      ...n.data.noeud,
      id: n.id,
      position: [Math.round(n.position.x), Math.round(n.position.y)] as [number, number],
    })),
    connexions,
  };
}

/** Identifiant lisible et unique tiré du type : `http`, `http_2`… */
export function nouvelId(type: string, existants: Iterable<string>): string {
  const pris = new Set(existants);
  const base =
    (type.split(".").pop() ?? "noeud")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 30) || "noeud";
  if (!pris.has(base)) return base;
  for (let i = 2; ; i++) if (!pris.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function nouveauNoeud(type: TypeNoeudApi, position: XYPosition, existants: Iterable<string>): NoeudFlux {
  const id = nouvelId(type.type, existants);
  const noeud: Noeud = {
    id,
    type: type.type,
    nom: type.libelle,
    parametres: valeursInitiales(type.parametres),
    position: [Math.round(position.x), Math.round(position.y)],
    desactive: false,
    continuerSurErreur: false,
    tentatives: 0,
    delaiEssaiMs: 1000,
  };
  return { id, type: "etape", position: { x: noeud.position[0], y: noeud.position[1] }, data: { noeud } };
}

/** Le nœud `cible` mène-t-il déjà à `source` ? (une arête source → cible fermerait alors un cycle) */
function atteint(edges: AreteFlux[], depart: string, but: string): boolean {
  const suivants = new Map<string, string[]>();
  for (const e of edges) suivants.set(e.source, [...(suivants.get(e.source) ?? []), e.target]);
  const vus = new Set<string>();
  const pile = [depart];
  while (pile.length) {
    const id = pile.pop()!;
    if (id === but) return true;
    if (vus.has(id)) continue;
    vus.add(id);
    pile.push(...(suivants.get(id) ?? []));
  }
  return false;
}

/** Règles du moteur appliquées pendant le tracé : pas de boucle, pas d'entrée sur un déclencheur, pas de doublon. */
export function connexionValide(
  c: { source: string | null; target: string | null; sourceHandle?: string | null },
  nodes: NoeudFlux[],
  edges: AreteFlux[],
): boolean {
  if (!c.source || !c.target || c.source === c.target) return false;
  const cible = nodes.find((n) => n.id === c.target);
  if (!cible || estDeclencheur(cible.data.noeud.type)) return false;
  const sortie = sortieDePoignee(c.sourceHandle);
  if (edges.some((e) => e.source === c.source && e.target === c.target && sortieDePoignee(e.sourceHandle) === sortie))
    return false;
  return !atteint(edges, c.target, c.source);
}

/** Retire les arêtes partant d'une sortie qui n'existe plus (cas d'aiguillage supprimé). */
export function elaguer(edges: AreteFlux[], noeud: string, nbSorties: number): AreteFlux[] {
  return edges.filter((e) => e.source !== noeud || sortieDePoignee(e.sourceHandle) < nbSorties);
}

/** Position libre à droite du nœud le plus à droite : pour un ajout par clic. */
export function positionSuivante(nodes: NoeudFlux[], pres?: XYPosition): XYPosition {
  if (pres) return pres;
  if (!nodes.length) return { x: 0, y: 0 };
  const dernier = nodes.reduce((a, b) => (b.position.x > a.position.x ? b : a));
  return { x: dernier.position.x + 280, y: dernier.position.y };
}

/** Résultats d'une exécution reportés sur les nœuds (badge, erreur, aperçu). */
export function avecResultats(nodes: NoeudFlux[], etapes: Etape[] | null): NoeudFlux[] {
  const parNoeud = new Map((etapes ?? []).map((e) => [e.noeud, e]));
  return nodes.map((n) => {
    const resultat = parNoeud.get(n.id);
    if (resultat === n.data.resultat) return n;
    const { resultat: _ancien, ...reste } = n.data;
    return { ...n, data: resultat ? { ...reste, resultat } : reste };
  });
}

/** Définition de départ d'un nouveau workflow : un lancement manuel. */
export function definitionVide(): Definition {
  return {
    noeuds: [
      {
        id: "declencheur",
        type: "declencheur.manuel",
        nom: "Lancement manuel",
        parametres: { donnees: {} },
        position: [0, 0],
        desactive: false,
        continuerSurErreur: false,
        tentatives: 0,
        delaiEssaiMs: 1000,
      },
    ],
    connexions: [],
  };
}

/** Nœuds dont la sortie alimente `id` (pour proposer leurs champs dans les expressions). */
export function predecesseurs(edges: AreteFlux[], id: string): string[] {
  return [...new Set(edges.filter((e) => e.target === id).map((e) => e.source))];
}

/** Chemins des champs d'un objet (deux niveaux), pour les puces `{{ $json.… }}`. */
export function cheminsDe(json: Record<string, unknown>, prefixe = "", profondeur = 2): string[] {
  const r: string[] = [];
  for (const [k, v] of Object.entries(json)) {
    const segment = /^[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(k) ? `${prefixe}.${k}` : `${prefixe}["${k}"]`;
    r.push(segment);
    if (profondeur > 1 && v && typeof v === "object" && !Array.isArray(v))
      r.push(...cheminsDe(v as Record<string, unknown>, segment, profondeur - 1));
  }
  return r.slice(0, 40);
}

/**
 * Écarte les nœuds trop serrés pour la largeur des nœuds d'auto (232 px), par exemple ceux d'un import n8n,
 * dont les nœuds sont plus étroits : les positions sont dilatées, l'ordre et la forme du graphe conservés.
 */
export function espacer(def: Definition, ecartX = 260, ecartY = 140): Definition {
  let fx = 1;
  let fy = 1;
  const ns = def.noeuds;
  for (let i = 0; i < ns.length; i++)
    for (let j = i + 1; j < ns.length; j++) {
      const dx = Math.abs(ns[i]!.position[0] - ns[j]!.position[0]);
      const dy = Math.abs(ns[i]!.position[1] - ns[j]!.position[1]);
      if (dx < ecartX && dy < ecartY) {
        if (dx > 0) fx = Math.max(fx, ecartX / dx);
        if (dy > 0) fy = Math.max(fy, ecartY / dy);
      }
    }
  if (fx === 1 && fy === 1) return def;
  return {
    ...def,
    noeuds: ns.map((n) => ({
      ...n,
      position: [Math.round(n.position[0] * fx), Math.round(n.position[1] * fy)] as [number, number],
    })),
  };
}

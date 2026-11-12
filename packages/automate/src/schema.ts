// Définition d'un workflow : un graphe orienté sans cycle de nœuds typés, reliés sortie → entrée.
// Un seul déclencheur par workflow ; ses éléments de départ viennent de l'événement, du cron, du webhook
// ou du lancement manuel. Validée par Zod côté API, worker et éditeur.
import { z } from "zod";

export const ID_NOEUD = /^[a-z0-9_-]{1,40}$/i;

export const Noeud = z.object({
  id: z.string().regex(ID_NOEUD, "identifiant : lettres, chiffres, - et _"),
  type: z.string().min(3).max(60),
  nom: z.string().trim().min(1).max(80),
  parametres: z.record(z.string(), z.unknown()).default({}),
  /** Position dans l'éditeur (px). */
  position: z.tuple([z.number(), z.number()]).default([0, 0]),
  desactive: z.boolean().default(false),
  /** Une erreur ne stoppe pas l'exécution : l'élément continue avec un champ `erreur`. */
  continuerSurErreur: z.boolean().default(false),
  /** Nouveaux essais d'un élément en échec (erreur réseau, service indisponible…), avant l'erreur finale. */
  tentatives: z.number().int().min(0).max(5).default(0),
  /** Attente entre deux essais (ms), doublée à chaque nouvel essai. */
  delaiEssaiMs: z.number().int().min(0).max(60_000).default(1000),
  note: z.string().max(2000).optional(),
});
export type Noeud = z.infer<typeof Noeud>;

export const Connexion = z.object({
  de: z.string().regex(ID_NOEUD),
  /** Indice de la sortie du nœud source (0 : principale ; `logique.si` : 0 vrai, 1 faux). */
  sortie: z.number().int().min(0).max(20).default(0),
  vers: z.string().regex(ID_NOEUD),
});
export type Connexion = z.infer<typeof Connexion>;

export const Definition = z.object({
  noeuds: z.array(Noeud).min(1).max(100),
  connexions: z.array(Connexion).max(400).default([]),
});
export type Definition = z.infer<typeof Definition>;

/** Élément qui circule entre les nœuds (comme un item n8n). */
export interface Element {
  json: Record<string, unknown>;
}

export type Declencheur = "manuel" | "evenement" | "planifie" | "webhook";

export const estDeclencheur = (type: string) => type.startsWith("declencheur.");

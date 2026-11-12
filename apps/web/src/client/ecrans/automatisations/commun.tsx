// Éléments partagés des écrans d'automatisation : catégories et rôles de couleur M3, icônes du catalogue
// (police Material Symbols, noms fournis par l'API), libellés des déclencheurs et des statuts.
import type { Categorie, Definition } from "@auto/automate";
import { api, type ResumeAutomatisation, type StatutExecution, type TypeNoeudApi } from "@auto/client";
import { pluriel } from "@auto/ui/format";

export type Role = "primaire" | "secondaire" | "tertiaire";

export const CATEGORIES: Record<Categorie, { libelle: string; role: Role }> = {
  declencheur: { libelle: "Déclencheurs", role: "tertiaire" },
  logique: { libelle: "Logique", role: "secondaire" },
  donnees: { libelle: "Données", role: "primaire" },
  reseau: { libelle: "Réseau", role: "primaire" },
  communication: { libelle: "Communication", role: "tertiaire" },
  ia: { libelle: "Intelligence artificielle", role: "secondaire" },
  auto: { libelle: "auto", role: "primaire" },
};

export const ORDRE_CATEGORIES = Object.keys(CATEGORIES) as Categorie[];

export const DECLENCHEURS: Record<ResumeAutomatisation["declencheur"], { libelle: string; icone: string }> = {
  manuel: { libelle: "Lancement manuel", icone: "play_circle" },
  evenement: { libelle: "Événement auto", icone: "bolt" },
  planifie: { libelle: "Planification", icone: "schedule" },
  webhook: { libelle: "Webhook entrant", icone: "webhook" },
};

export const STATUTS: Record<StatutExecution, { libelle: string; icone: string }> = {
  en_cours: { libelle: "En cours", icone: "progress_activity" },
  succes: { libelle: "Réussie", icone: "check_circle" },
  erreur: { libelle: "En erreur", icone: "error" },
};

/** Icône Material Symbols par son nom (police autohébergée) : décorative, le texte voisin porte le sens. */
export function IconeM3({ nom, className }: { nom: string; className?: string }) {
  return (
    <span className={`symbole-m3 ${className ?? ""}`} aria-hidden="true" translate="no">
      {nom}
    </span>
  );
}

export function BadgeExecution({ statut }: { statut: StatutExecution }) {
  const s = STATUTS[statut];
  return (
    <span className="badge-execution" data-statut={statut}>
      <IconeM3 nom={s.icone} />
      {s.libelle}
    </span>
  );
}

const dateHeure = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const relatif = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

export const dateHeureFr = (iso: string) => dateHeure.format(new Date(iso));

/** « il y a 5 minutes », « hier »… */
export function depuis(iso: string, maintenant = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - maintenant) / 1000);
  const a = Math.abs(s);
  if (a < 60) return relatif.format(s, "second");
  if (a < 3600) return relatif.format(Math.round(s / 60), "minute");
  if (a < 86_400) return relatif.format(Math.round(s / 3600), "hour");
  if (a < 30 * 86_400) return relatif.format(Math.round(s / 86_400), "day");
  return dateHeureFr(iso);
}

export function duree(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const elements = (n: number) => pluriel(n, "élément");

let catalogue: Promise<TypeNoeudApi[]> | null = null;

/** Catalogue des types de nœuds, chargé une fois par session (il ne change qu'au déploiement). */
export function chargerCatalogue(): Promise<TypeNoeudApi[]> {
  catalogue ??= api.catalogueAutomatisations().catch((e: unknown) => {
    catalogue = null;
    throw e;
  });
  return catalogue;
}

/** Définition à ouvrir dans un nouvel éditeur (import n8n) : remise une seule fois, au chargement. */
let brouillonImporte: { nom: string; definition: Definition } | null = null;

export function deposerBrouillon(b: { nom: string; definition: Definition }) {
  brouillonImporte = b;
}

export function reprendreBrouillon() {
  const b = brouillonImporte;
  brouillonImporte = null;
  return b;
}

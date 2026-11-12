// Palette des nœuds : recherche, regroupement par catégorie, glisser-déposer vers le canevas ou ajout par
// clic (et au clavier). Un seul déclencheur par workflow : les déclencheurs sont grisés quand il y en a un.
import type { TypeNoeudApi } from "@auto/client";
import { Search } from "@auto/ui/symboles";
import { useMemo, useState, type DragEvent } from "react";
import { CATEGORIES, IconeM3, ORDRE_CATEGORIES } from "./commun";
import { estDeclencheur } from "./graphe";

export const TYPE_GLISSE = "application/x-auto-noeud";

const normaliser = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Types correspondant à la recherche (libellé, description, type), groupés dans l'ordre des catégories. */
export function filtrerCatalogue(types: TypeNoeudApi[], recherche: string) {
  const q = normaliser(recherche.trim());
  const retenus = q ? types.filter((t) => normaliser(`${t.libelle} ${t.description} ${t.type}`).includes(q)) : types;
  return ORDRE_CATEGORIES.map((c) => ({ categorie: c, types: retenus.filter((t) => t.categorie === c) })).filter(
    (g) => g.types.length,
  );
}

export function Palette({
  types,
  aUnDeclencheur,
  onAjouter,
}: {
  types: TypeNoeudApi[];
  aUnDeclencheur: boolean;
  onAjouter: (t: TypeNoeudApi) => void;
}) {
  const [recherche, setRecherche] = useState("");
  const groupes = useMemo(() => filtrerCatalogue(types, recherche), [types, recherche]);

  function glisser(e: DragEvent, t: TypeNoeudApi) {
    e.dataTransfer.setData(TYPE_GLISSE, t.type);
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <aside className="flux-palette" aria-label="Nœuds disponibles">
      <div className="flux-palette-recherche">
        <Search className="icone icone-sm" aria-hidden="true" />
        <input
          type="search"
          className="controle"
          placeholder="Rechercher un nœud"
          aria-label="Rechercher un nœud"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />
      </div>
      <div className="flux-palette-liste">
        {groupes.length === 0 && <p className="attenue flux-palette-vide">Aucun nœud ne correspond.</p>}
        {groupes.map((g) => (
          <section key={g.categorie} aria-labelledby={`palette-${g.categorie}`}>
            <h3 id={`palette-${g.categorie}`} className="flux-palette-titre">
              {CATEGORIES[g.categorie].libelle}
            </h3>
            <ul>
              {g.types.map((t) => {
                const bloque = aUnDeclencheur && estDeclencheur(t.type);
                return (
                  <li key={t.type}>
                    <button
                      type="button"
                      className="flux-palette-element"
                      data-role={CATEGORIES[t.categorie].role}
                      draggable={!bloque}
                      disabled={bloque}
                      title={bloque ? "Un seul déclencheur par workflow" : undefined}
                      onDragStart={(e) => glisser(e, t)}
                      onClick={() => onAjouter(t)}
                    >
                      <span className="flux-noeud-icone">
                        <IconeM3 nom={t.icone} />
                      </span>
                      <span className="flux-palette-textes">
                        <span className="flux-palette-libelle">{t.libelle}</span>
                        <span className="flux-palette-description">{t.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

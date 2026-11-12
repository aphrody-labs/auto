// Nœud du canevas : pastille d'icône colorée par catégorie, nom, type, poignée d'entrée à gauche et une
// poignée libellée par sortie à droite ; après un essai, le nombre d'éléments produits ou l'erreur.
import type { TypeNoeudApi } from "@auto/client";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { createContext, memo, useContext, useEffect } from "react";
import { CATEGORIES, IconeM3, elements } from "./commun";
import { estDeclencheur, poignee, sortiesNoeud, type NoeudFlux } from "./graphe";

export const ContexteCatalogue = createContext<Map<string, TypeNoeudApi>>(new Map());

function NoeudEtapeBrut({ id, data, selected }: NodeProps<NoeudFlux>) {
  const catalogue = useContext(ContexteCatalogue);
  const majInternes = useUpdateNodeInternals();
  const { noeud, resultat } = data;
  const type = catalogue.get(noeud.type);
  const categorie = type ? CATEGORIES[type.categorie] : undefined;
  const sorties = sortiesNoeud(noeud, type);
  const declencheur = estDeclencheur(noeud.type);
  const nommees = sorties.length > 1;
  const cle = sorties.join("|");

  // Les poignées d'un aiguillage changent avec ses cas : React Flow doit recalculer leurs positions.
  useEffect(() => majInternes(id), [cle, id, majInternes]);

  // Nœud importé de n8n sans équivalent : remplacé par « Laisser passer », avec une note « À remplacer : … ».
  const aRemplacer = /^à remplacer/i.test(noeud.note ?? "");
  const statut = resultat ? (resultat.erreur ? "erreur" : "succes") : undefined;
  const total = resultat ? resultat.sorties.reduce((a, b) => a + b, 0) : 0;

  return (
    <div
      className="flux-noeud"
      data-role={categorie?.role ?? "primaire"}
      data-declencheur={declencheur || undefined}
      data-selectionne={selected || undefined}
      data-desactive={noeud.desactive || undefined}
      data-statut={statut}
      data-inconnu={!type || undefined}
      data-avertissement={aRemplacer || undefined}
    >
      {!declencheur && <Handle type="target" position={Position.Left} className="flux-poignee" />}
      <div className="flux-noeud-corps">
        <span className="flux-noeud-icone">
          <IconeM3 nom={type?.icone ?? "help"} />
        </span>
        <span className="flux-noeud-textes">
          <span className="flux-noeud-nom">{noeud.nom}</span>
          <span className="flux-noeud-type">
            {type?.libelle ?? `Type inconnu : ${noeud.type}`}
            {noeud.desactive && " · désactivé"}
          </span>
        </span>
      </div>
      {resultat && (
        <span className="flux-noeud-resultat" role="status">
          <IconeM3 nom={resultat.erreur ? "error" : "check_circle"} />
          {resultat.erreur ? "Erreur" : elements(total)}
        </span>
      )}
      {resultat?.erreur && <p className="flux-noeud-erreur">{resultat.erreur}</p>}
      {noeud.note && (
        <p className="flux-noeud-note">
          {aRemplacer && <IconeM3 nom="warning" />}
          {noeud.note}
        </p>
      )}
      <div className="flux-sorties" data-nommees={nommees || undefined}>
        {sorties.map((libelle, i) => (
          <div key={`${i}-${libelle}`} className="flux-sortie">
            {nommees && (
              <span className="flux-sortie-libelle">
                {libelle}
                {resultat && !resultat.erreur && <span className="flux-sortie-nb">{resultat.sorties[i] ?? 0}</span>}
              </span>
            )}
            <Handle
              type="source"
              id={poignee(i)}
              position={Position.Right}
              className="flux-poignee"
              aria-label={nommees ? `Sortie ${libelle}` : "Sortie"}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export const NoeudEtape = memo(NoeudEtapeBrut);

export const TYPES_NOEUDS = { etape: NoeudEtape };

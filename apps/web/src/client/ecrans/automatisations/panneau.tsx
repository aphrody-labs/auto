// Panneau du nœud sélectionné : paramètres (formulaire déduit du JSON Schema), résultat du dernier essai
// (éléments par sortie, erreur, aperçu JSON) et réglages (désactivation, erreurs tolérées, note).
import type { Noeud } from "@auto/automate";
import type { Portee } from "@auto/automate/expressions";
import { api, type Etape, type TypeNoeudApi } from "@auto/client";
import { Copy, Trash2, X } from "@auto/ui/symboles";
import { Bouton, useToast } from "@auto/ui/react";
import { Tabs } from "@base-ui/react/tabs";
import { useEffect, useMemo, useState } from "react";
import { AideExpressions, ContextePortee, FormulaireParametres, Interrupteur } from "./champs";
import { CATEGORIES, IconeM3, duree, elements } from "./commun";
import { erreursChamps } from "./formulaire";
import { cheminsDe, sortiesNoeud } from "./graphe";

export type Onglet = "parametres" | "resultat" | "reglages";

function UrlWebhook({ id }: { id: string | undefined }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    api.webhookAutomatisation(id).then(
      (r) => setUrl(r.url),
      (e: Error) => setErreur(e.message),
    );
  }, [id]);
  if (!id) return <p className="aide flux-encart">L'URL du webhook est attribuée au premier enregistrement.</p>;
  if (erreur) return <p className="erreur-champ">{erreur}</p>;
  if (!url) return null;
  return (
    <div className="flux-encart">
      <span className="flux-encart-titre">URL secrète du webhook</span>
      <div className="rangee">
        <code className="flux-url">{url}</code>
        <Bouton
          variante="fantome"
          icone={Copy}
          aria-label="Copier l'URL du webhook"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            toast("URL copiée");
          }}
        />
      </div>
      <span className="aide">Une requête POST sur cette URL démarre le workflow ; son corps est dans $json.corps.</span>
    </div>
  );
}

function Resultat({ etape, sorties }: { etape: Etape | undefined; sorties: string[] }) {
  if (!etape)
    return (
      <div className="flux-vide-panneau">
        <IconeM3 nom="science" />
        <p>Lancez un essai pour voir ce que ce nœud reçoit et produit.</p>
      </div>
    );
  return (
    <div className="pile">
      <dl className="flux-stats">
        <div>
          <dt>Entrée</dt>
          <dd>{elements(etape.entree)}</dd>
        </div>
        {sorties.map((s, i) => (
          <div key={`${i}-${s}`}>
            <dt>{sorties.length > 1 ? `Sortie « ${s} »` : "Sortie"}</dt>
            <dd>{elements(etape.sorties[i] ?? 0)}</dd>
          </div>
        ))}
        <div>
          <dt>Durée</dt>
          <dd>{duree(etape.dureeMs)}</dd>
        </div>
      </dl>
      {etape.erreur && (
        <div className="bandeau bandeau-erreur" role="alert">
          <strong>Erreur</strong>
          <p>{etape.erreur}</p>
        </div>
      )}
      {etape.apercu.length > 0 && (
        <>
          <h4 className="flux-sous-titre">Aperçu des éléments produits</h4>
          <pre className="flux-json" tabIndex={0} aria-label="Aperçu JSON des éléments produits">
            {JSON.stringify(
              etape.apercu.map((e) => e.json),
              null,
              2,
            )}
          </pre>
        </>
      )}
    </div>
  );
}

export function PanneauNoeud({
  noeud,
  type,
  etape,
  entree,
  portee,
  autres,
  secrets,
  automatisationId,
  onglet,
  onOnglet,
  onChange,
  onSupprimer,
  onFermer,
}: {
  noeud: Noeud;
  type: TypeNoeudApi | undefined;
  etape: Etape | undefined;
  /** Premier élément reçu lors du dernier essai (champs proposés dans l'aide). */
  entree: Record<string, unknown> | null;
  portee: Portee | null;
  autres: { id: string; nom: string }[];
  secrets: string[];
  automatisationId: string | undefined;
  onglet: Onglet;
  onOnglet: (o: Onglet) => void;
  onChange: (n: Noeud) => void;
  onSupprimer: () => void;
  onFermer: () => void;
}) {
  const erreurs = useMemo(
    () => (type ? erreursChamps(type.parametres, noeud.parametres) : {}),
    [type, noeud.parametres],
  );
  const chemins = useMemo(() => (entree ? cheminsDe(entree) : []), [entree]);
  const role = type ? CATEGORIES[type.categorie].role : "primaire";
  const nbErreurs = Object.keys(erreurs).length;

  return (
    <aside className="flux-panneau" aria-label={`Nœud ${noeud.nom}`}>
      <header className="flux-panneau-entete" data-role={role}>
        <span className="flux-noeud-icone">
          <IconeM3 nom={type?.icone ?? "help"} />
        </span>
        <div className="flux-panneau-titres">
          <input
            className="flux-titre-saisie"
            aria-label="Nom du nœud"
            value={noeud.nom}
            maxLength={80}
            onChange={(e) => onChange({ ...noeud, nom: e.target.value })}
            onBlur={(e) => !e.target.value.trim() && onChange({ ...noeud, nom: type?.libelle ?? noeud.type })}
          />
          <span className="attenue flux-panneau-type">{type?.libelle ?? noeud.type}</span>
        </div>
        <Bouton variante="fantome" icone={Trash2} aria-label="Supprimer le nœud" onClick={onSupprimer} />
        <Bouton variante="fantome" icone={X} aria-label="Fermer le panneau" onClick={onFermer} />
      </header>
      <Tabs.Root value={onglet} onValueChange={(v) => onOnglet(v as Onglet)} className="flux-onglets">
        <Tabs.List className="flux-onglets-liste" aria-label="Sections du nœud">
          <Tabs.Tab value="parametres" className="flux-onglet">
            Paramètres
            {nbErreurs > 0 && (
              <span className="flux-pastille" data-ton="erreur" aria-label={`${nbErreurs} à corriger`}>
                {nbErreurs}
              </span>
            )}
          </Tabs.Tab>
          <Tabs.Tab value="resultat" className="flux-onglet">
            Résultat
            {etape && (
              <span
                className="flux-pastille"
                data-ton={etape.erreur ? "erreur" : "succes"}
                aria-label={etape.erreur ? "en erreur" : "réussi"}
              >
                <IconeM3 nom={etape.erreur ? "error" : "check"} />
              </span>
            )}
          </Tabs.Tab>
          <Tabs.Tab value="reglages" className="flux-onglet">
            Réglages
          </Tabs.Tab>
          <Tabs.Indicator className="flux-onglet-indicateur" />
        </Tabs.List>
        <Tabs.Panel value="parametres" className="flux-onglet-panneau">
          {type ? (
            <>
              <p className="attenue flux-description">{type.description}</p>
              {noeud.type === "declencheur.webhook" && <UrlWebhook id={automatisationId} />}
              <ContextePortee.Provider value={portee}>
                <FormulaireParametres
                  schema={type.parametres}
                  valeurs={noeud.parametres}
                  erreurs={erreurs}
                  onChange={(parametres) => onChange({ ...noeud, parametres })}
                />
              </ContextePortee.Provider>
              <AideExpressions chemins={chemins} noeuds={autres} secrets={secrets} />
            </>
          ) : (
            <p className="erreur-champ">
              Type de nœud inconnu : {noeud.type}. Supprimez ce nœud ou mettez auto à jour.
            </p>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="resultat" className="flux-onglet-panneau">
          <Resultat etape={etape} sorties={sortiesNoeud(noeud, type)} />
        </Tabs.Panel>
        <Tabs.Panel value="reglages" className="flux-onglet-panneau">
          <div className="pile">
            <Interrupteur
              libelle="Désactiver ce nœud"
              aide="Les éléments le traversent sans modification."
              coche={noeud.desactive}
              onChange={(desactive) => onChange({ ...noeud, desactive })}
            />
            <Interrupteur
              libelle="Continuer en cas d'erreur"
              aide="L'élément en échec poursuit avec un champ « erreur »."
              coche={noeud.continuerSurErreur}
              onChange={(continuerSurErreur) => onChange({ ...noeud, continuerSurErreur })}
            />
            <div className="champ">
              <label htmlFor={`essais-${noeud.id}`}>Nouveaux essais en cas d'échec</label>
              <select
                id={`essais-${noeud.id}`}
                className="controle"
                value={noeud.tentatives}
                onChange={(e) => onChange({ ...noeud, tentatives: Number(e.target.value) })}
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Aucun" : `${n} essai${n > 1 ? "s" : ""}`}
                  </option>
                ))}
              </select>
              <span className="aide">
                Pour un service momentanément indisponible. Une erreur de paramètres n'est jamais réessayée.
              </span>
            </div>
            {noeud.tentatives > 0 && (
              <div className="champ">
                <label htmlFor={`delai-${noeud.id}`}>Attente avant le premier nouvel essai (secondes)</label>
                <input
                  id={`delai-${noeud.id}`}
                  className="controle"
                  type="number"
                  min={0}
                  max={60}
                  step={0.5}
                  value={noeud.delaiEssaiMs / 1000}
                  onChange={(e) =>
                    onChange({
                      ...noeud,
                      delaiEssaiMs: Math.round(Math.min(60, Math.max(0, Number(e.target.value) || 0)) * 1000),
                    })
                  }
                />
                <span className="aide">Doublée à chaque nouvel essai.</span>
              </div>
            )}
            <div className="champ">
              <label htmlFor={`note-${noeud.id}`}>Note</label>
              <textarea
                id={`note-${noeud.id}`}
                className="controle"
                rows={3}
                maxLength={2000}
                value={noeud.note ?? ""}
                onChange={(e) => {
                  const { note: _note, ...reste } = noeud;
                  onChange(e.target.value ? { ...reste, note: e.target.value } : reste);
                }}
              />
              <span className="aide">Affichée sous le nœud, sur le canevas.</span>
            </div>
            <div className="champ">
              <span className="flux-encart-titre">Identifiant</span>
              <code className="flux-url">{`{{ $noeud.${noeud.id}.json }}`}</code>
              <span className="aide">Les nœuds suivants lisent la sortie de celui-ci par cette expression.</span>
            </div>
          </div>
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  );
}

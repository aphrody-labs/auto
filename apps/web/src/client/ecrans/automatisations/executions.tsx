// Historique des exécutions d'un workflow : liste (origine, statut, durée) et détail par étape (éléments
// reçus et produits, erreur, aperçu JSON). « Exécuter maintenant » lance le workflow enregistré.
import { api, ErreurApi, type Execution, type ResumeExecution } from "@auto/client";
import { ArrowLeft, History, Play, Workflow } from "@auto/ui/symboles";
import {
  Bouton,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Lien,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { useState } from "react";
import { peut, useSession } from "../../session";
import { BadgeExecution, dateHeureFr, duree, elements } from "./commun";

const ORIGINES: Record<string, string> = {
  manuel: "Lancement manuel",
  essai: "Essai",
  evenement: "Événement",
  planifie: "Planification",
  webhook: "Webhook",
  api: "API",
};

const dureeExecution = (e: ResumeExecution) =>
  e.fin ? duree(new Date(e.fin).getTime() - new Date(e.debut).getTime()) : "—";

function Detail({ id }: { id: string }) {
  const d = useDonnees(() => api.execution(id), [id]);
  if (d.etat === "chargement") return <EtatChargement lignes={3} libelle="Chargement de l'exécution" />;
  if (d.etat === "erreur") return <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  return <Etapes execution={d.donnees} />;
}

export function Etapes({ execution }: { execution: Execution }) {
  return (
    <div className="pile">
      {execution.erreur && (
        <div className="bandeau bandeau-erreur" role="alert">
          <strong>Exécution en erreur</strong>
          <p>{execution.erreur}</p>
        </div>
      )}
      <ol className="flux-etapes">
        {execution.etapes.map((e, i) => (
          <li key={`${e.noeud}-${i}`} className="flux-etape" data-statut={e.erreur ? "erreur" : "succes"}>
            <details open={!!e.erreur}>
              <summary>
                <span className="flux-etape-rang">{i + 1}</span>
                <span className="flux-etape-nom">
                  <strong>{e.nom}</strong>
                  <span className="attenue">{e.type}</span>
                </span>
                <span className="flux-etape-chiffres">
                  {elements(e.entree)} → {e.erreur ? "erreur" : elements(e.sorties.reduce((a, b) => a + b, 0))}
                </span>
                <span className="attenue chiffres">{duree(e.dureeMs)}</span>
              </summary>
              {e.erreur && <p className="erreur-champ">{e.erreur}</p>}
              {e.sorties.length > 1 && (
                <p className="attenue">
                  Par sortie : {e.sorties.map((n, j) => `n° ${j + 1} : ${elements(n)}`).join(" · ")}
                </p>
              )}
              {e.apercu.length > 0 ? (
                <pre className="flux-json" tabIndex={0} aria-label={`Aperçu JSON de l'étape ${e.nom}`}>
                  {JSON.stringify(
                    e.apercu.map((x) => x.json),
                    null,
                    2,
                  )}
                </pre>
              ) : (
                !e.erreur && <p className="attenue">Aucun élément produit.</p>
              )}
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ExecutionsAutomatisation({ id }: { id: string }) {
  const { moi } = useSession();
  const toast = useToast();
  const ecrire = peut(moi.role, "ecrire");
  const d = useDonnees(async () => {
    const [automatisation, executions] = await Promise.all([api.automatisation(id), api.executionsAutomatisation(id)]);
    return { automatisation, executions };
  }, [id]);
  useTitrePage(d.etat === "ok" ? `Exécutions · ${d.donnees.automatisation.nom}` : "Exécutions");
  const [choisie, setChoisie] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);

  async function executer() {
    setEnvoi(true);
    setErreur(null);
    try {
      const r = await api.executerAutomatisation(id);
      toast(r.statut === "succes" ? "Exécution réussie" : "Exécution terminée en erreur");
      setChoisie(r.id);
      d.recharger();
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (!d.donnees.executions.length)
    corps = (
      <EtatVide icone={History} titre="Aucune exécution">
        <p>Chaque déclenchement de ce workflow apparaîtra ici, avec le détail de chaque étape.</p>
      </EtatVide>
    );
  else {
    const courante = choisie ?? d.donnees.executions[0]!.id;
    corps = (
      <div className="flux-historique">
        <ul className="flux-historique-liste" aria-label="Exécutions">
          {d.donnees.executions.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="flux-historique-element"
                aria-current={e.id === courante || undefined}
                onClick={() => setChoisie(e.id)}
              >
                <BadgeExecution statut={e.statut} />
                <span className="flux-historique-textes">
                  <span>{dateHeureFr(e.debut)}</span>
                  <span className="attenue">
                    {ORIGINES[e.origine] ?? e.origine} · {dureeExecution(e)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <section className="carte flux-historique-detail" aria-label="Détail de l'exécution">
          <Detail key={courante} id={courante} />
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-entete">
        <Lien
          className="bouton bouton-fantome bouton-icone"
          href={`/app/automatisations/${id}`}
          aria-label="Retour au workflow"
        >
          <ArrowLeft className="icone" aria-hidden="true" />
        </Lien>
        <h1>{d.etat === "ok" ? d.donnees.automatisation.nom : "Exécutions"}</h1>
        <span className="espace" />
        <Lien className="bouton" href={`/app/automatisations/${id}`}>
          <Workflow className="icone" aria-hidden="true" />
          Ouvrir l'éditeur
        </Lien>
        {ecrire && (
          <Bouton variante="primaire" icone={Play} chargement={envoi} onClick={() => void executer()}>
            Exécuter maintenant
          </Bouton>
        )}
      </div>
      <ResumeErreurs erreur={erreur} />
      {corps}
    </div>
  );
}

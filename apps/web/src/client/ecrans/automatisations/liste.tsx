// Écran « Automatisations » : workflows en cartes (déclencheur, interrupteur actif, dernière exécution),
// galerie des modèles prêts à l'emploi et secrets référencés par `{{ $secret.nom }}`.
import type { Modele } from "@auto/automate";
import { api, ErreurApi, type ResumeAutomatisation } from "@auto/client";
import { FileInput, KeyRound, Plus, Trash2, Workflow } from "@auto/ui/symboles";
import {
  Bouton,
  ChampTexte,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Lien,
  Modale,
  ResumeErreurs,
  naviguer,
  parametre,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { Switch } from "@base-ui/react/switch";
import { Tabs } from "@base-ui/react/tabs";
import { useState, type DragEvent, type FormEvent } from "react";
import { peut, useSession } from "../../session";
import {
  BadgeExecution,
  CATEGORIES,
  DECLENCHEURS,
  IconeM3,
  chargerCatalogue,
  deposerBrouillon,
  depuis,
} from "./commun";
import { espacer } from "./graphe";

type Vue = "workflows" | "modeles" | "secrets";

function CarteWorkflow({
  a,
  ecrire,
  onBascule,
}: {
  a: ResumeAutomatisation;
  ecrire: boolean;
  onBascule: (actif: boolean) => Promise<void>;
}) {
  const [envoi, setEnvoi] = useState(false);
  const d = DECLENCHEURS[a.declencheur];
  return (
    <li className="carte flux-carte" data-actif={a.actif || undefined}>
      <div className="flux-carte-tete">
        <span className="flux-noeud-icone" data-role="tertiaire">
          <IconeM3 nom={d.icone} />
        </span>
        <div className="flux-carte-textes">
          <h3>
            <Lien href={`/app/automatisations/${a.id}`} className="flux-carte-lien">
              {a.nom}
            </Lien>
          </h3>
          <span className="attenue">{d.libelle}</span>
        </div>
        <Switch.Root
          className="interrupteur"
          checked={a.actif}
          disabled={!ecrire || envoi}
          aria-label={`${a.actif ? "Désactiver" : "Activer"} « ${a.nom} »`}
          onCheckedChange={async (v) => {
            setEnvoi(true);
            await onBascule(v).finally(() => setEnvoi(false));
          }}
        >
          <Switch.Thumb className="interrupteur-curseur" />
        </Switch.Root>
      </div>
      {a.description && <p className="flux-carte-description">{a.description}</p>}
      <div className="flux-carte-pied">
        {a.derniereExecution ? (
          <>
            <BadgeExecution statut={a.derniereExecution.statut} />
            <span className="attenue">{depuis(a.derniereExecution.debut)}</span>
          </>
        ) : (
          <span className="attenue">Jamais exécuté</span>
        )}
        <span className="espace" />
        <Lien href={`/app/automatisations/${a.id}/executions`} className="flux-lien-discret">
          Historique
        </Lien>
      </div>
    </li>
  );
}

function Galerie({ modeles, ecrire }: { modeles: Modele[]; ecrire: boolean }) {
  const catalogue = useDonnees(() => chargerCatalogue());
  const icones = new Map(catalogue.etat === "ok" ? catalogue.donnees.map((t) => [t.type, t]) : []);
  return (
    <ul className="flux-galerie">
      {modeles.map((m) => (
        <li key={m.id} className="carte flux-modele">
          <div className="flux-modele-chaine" aria-hidden="true">
            {m.definition.noeuds.slice(0, 5).map((n) => {
              const t = icones.get(n.type);
              return (
                <span key={n.id} className="flux-noeud-icone" data-role={t ? CATEGORIES[t.categorie].role : "primaire"}>
                  <IconeM3 nom={t?.icone ?? "circle"} />
                </span>
              );
            })}
          </div>
          <h3>{m.nom}</h3>
          <p className="attenue">{m.description}</p>
          {ecrire && (
            <Lien className="bouton" href={`/app/automatisations/nouveau?modele=${encodeURIComponent(m.id)}`}>
              Utiliser ce modèle
            </Lien>
          )}
        </li>
      ))}
    </ul>
  );
}

function Secrets({ ecrire }: { ecrire: boolean }) {
  const toast = useToast();
  const d = useDonnees(() => api.secrets());
  const [ouvert, setOuvert] = useState(false);
  const [nom, setNom] = useState("");
  const [valeur, setValeur] = useState("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [aSupprimer, setASupprimer] = useState<{ id: string; nom: string } | null>(null);
  const nomValide = /^[\p{L}\p{N}_-]{1,60}$/u.test(nom);

  async function ajouter(e: FormEvent) {
    e.preventDefault();
    if (!nomValide || !valeur) return;
    setEnvoi(true);
    setErreur(null);
    try {
      await api.creerSecret(nom, valeur);
      toast("Secret enregistré");
      setOuvert(false);
      setNom("");
      setValeur("");
      d.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement lignes={2} />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (!d.donnees.length)
    corps = (
      <EtatVide icone={KeyRound} titre="Aucun secret">
        <p>
          Jetons d'API, URL de webhooks, mots de passe : enregistrés chiffrés, ils sont cités dans les nœuds par{" "}
          <code>{"{{ $secret.nom }}"}</code> et n'apparaissent jamais en clair dans les workflows ni les exécutions.
        </p>
      </EtatVide>
    );
  else
    corps = (
      <ul className="flux-secrets">
        {d.donnees.map((s) => (
          <li key={s.id} className="carte flux-secret">
            <KeyRound className="icone" aria-hidden="true" />
            <div className="flux-carte-textes">
              <code>{`{{ $secret.${s.nom} }}`}</code>
              <span className="attenue">Ajouté {depuis(s.createdAt)}</span>
            </div>
            {ecrire && (
              <Bouton
                variante="fantome"
                icone={Trash2}
                aria-label={`Supprimer le secret ${s.nom}`}
                onClick={() => setASupprimer(s)}
              />
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="pile">
      {ecrire && (
        <div className="rangee">
          <span className="espace" />
          <Bouton icone={Plus} onClick={() => setOuvert(true)}>
            Ajouter un secret
          </Bouton>
        </div>
      )}
      {corps}
      <Modale ouverte={ouvert} titre="Ajouter un secret" onFermer={() => setOuvert(false)}>
        <form className="grille" noValidate onSubmit={ajouter}>
          <ResumeErreurs erreur={erreur} />
          <ChampTexte
            libelle="Nom"
            requis
            value={nom}
            autoComplete="off"
            spellCheck={false}
            aide="Lettres, chiffres, - et _ ; cité par {{ $secret.nom }}."
            erreur={nom && !nomValide ? "Lettres, chiffres, - et _ uniquement." : undefined}
            onChange={(e) => setNom(e.target.value.trim())}
          />
          <ChampTexte
            libelle="Valeur"
            requis
            type="password"
            autoComplete="new-password"
            value={valeur}
            aide="Elle ne sera plus affichée après l'enregistrement."
            onChange={(e) => setValeur(e.target.value)}
          />
          <div className="rangee">
            <span className="espace" />
            <Bouton onClick={() => setOuvert(false)}>Annuler</Bouton>
            <Bouton type="submit" variante="primaire" chargement={envoi} disabled={!nomValide || !valeur}>
              Enregistrer
            </Bouton>
          </div>
        </form>
      </Modale>
      <Modale ouverte={!!aSupprimer} titre="Supprimer ce secret ?" onFermer={() => setASupprimer(null)}>
        <p>
          Les workflows qui citent {`{{ $secret.${aSupprimer?.nom ?? ""} }}`} échoueront à leur prochaine exécution.
        </p>
        <div className="rangee">
          <span className="espace" />
          <Bouton onClick={() => setASupprimer(null)}>Annuler</Bouton>
          <Bouton
            variante="danger"
            icone={Trash2}
            onClick={async () => {
              if (!aSupprimer) return;
              await api.supprimerSecret(aSupprimer.id).then(
                () => toast("Secret supprimé"),
                (e: Error) => toast(e.message),
              );
              setASupprimer(null);
              d.recharger();
            }}
          >
            Supprimer
          </Bouton>
        </div>
      </Modale>
    </div>
  );
}

type Conversion = Awaited<ReturnType<typeof api.importerN8n>>;

/** Import d'un export JSON de n8n : collé ou déposé, converti par l'API, avertissements montrés, puis ouvert. */
function ImportN8n({ ouvert, onFermer, onCree }: { ouvert: boolean; onFermer: () => void; onCree: () => void }) {
  const toast = useToast();
  const [creation, setCreation] = useState(false);
  const [texte, setTexte] = useState("");
  const [erreur, setErreur] = useState<{ message: string; details?: string[] } | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [survol, setSurvol] = useState(false);

  function fermer() {
    setTexte("");
    setErreur(null);
    setConversion(null);
    onFermer();
  }

  async function lireFichier(f: File | undefined) {
    if (!f) return;
    setTexte(await f.text());
    setConversion(null);
  }

  async function convertir(e: FormEvent) {
    e.preventDefault();
    setErreur(null);
    let workflow: unknown;
    try {
      workflow = JSON.parse(texte);
    } catch {
      setErreur({ message: "JSON invalide : collez l'export complet du workflow n8n." });
      return;
    }
    setEnvoi(true);
    try {
      setConversion(await api.importerN8n(workflow));
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  async function creerAutres() {
    if (!conversion) return;
    setCreation(true);
    setErreur(null);
    try {
      for (const a of conversion.autres)
        await api.creerAutomatisation({ nom: a.nom, definition: espacer(a.definition) });
      toast(
        `${conversion.autres.length} workflow${conversion.autres.length > 1 ? "s" : ""} créé${conversion.autres.length > 1 ? "s" : ""} (inactifs)`,
      );
      setConversion({ ...conversion, autres: [] });
      onCree();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setCreation(false);
    }
  }

  function ouvrir() {
    if (!conversion) return;
    deposerBrouillon({ nom: conversion.nom, definition: espacer(conversion.definition) });
    naviguer("/app/automatisations/nouveau?import=n8n");
  }

  const deposer = (e: DragEvent) => {
    e.preventDefault();
    setSurvol(false);
    void lireFichier(e.dataTransfer.files[0]);
  };

  return (
    <Modale ouverte={ouvert} titre="Importer depuis n8n" onFermer={fermer}>
      {conversion ? (
        <div className="pile">
          <p>
            « {conversion.nom} » : {conversion.definition.noeuds.length} nœuds et{" "}
            {conversion.definition.connexions.length} connexions convertis. Rien n'est enregistré avant votre validation
            dans l'éditeur.
          </p>
          <ResumeErreurs erreur={erreur} />
          {(conversion.autres ?? []).length > 0 && (
            <div className="bandeau" role="status">
              <strong>
                {conversion.autres.length} autre{conversion.autres.length > 1 ? "s" : ""} déclencheur
                {conversion.autres.length > 1 ? "s" : ""} : un workflow par déclencheur
              </strong>
              <ul>
                {conversion.autres.map((a) => (
                  <li key={a.nom}>
                    {a.nom} ({a.definition.noeuds.length} nœuds)
                  </li>
                ))}
              </ul>
              <Bouton icone={Plus} chargement={creation} onClick={() => void creerAutres()}>
                Créer {conversion.autres.length > 1 ? `ces ${conversion.autres.length} workflows` : "ce workflow"}
              </Bouton>
            </div>
          )}
          {conversion.avertissements.length > 0 && (
            <div className="bandeau bandeau-avertissement" role="status">
              <strong>À vérifier après l'import</strong>
              <ul>
                {conversion.avertissements.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="rangee">
            <span className="espace" />
            <Bouton onClick={() => setConversion(null)}>Revenir</Bouton>
            <Bouton variante="primaire" icone={Workflow} onClick={ouvrir}>
              Ouvrir dans l'éditeur
            </Bouton>
          </div>
        </div>
      ) : (
        <form className="grille" noValidate onSubmit={convertir}>
          <ResumeErreurs erreur={erreur} />
          <p className="attenue">
            Dans n8n : menu du workflow, « Download », ou sélection de tous les nœuds puis copier. Les nœuds courants,
            les expressions et les planifications sont convertis ; le reste est signalé.
          </p>
          <div
            className="flux-depot"
            data-survol={survol || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setSurvol(true);
            }}
            onDragLeave={() => setSurvol(false)}
            onDrop={deposer}
          >
            <label htmlFor="import-n8n">JSON du workflow</label>
            <textarea
              id="import-n8n"
              className="controle controle-code"
              rows={10}
              spellCheck={false}
              placeholder={'{ "name": "…", "nodes": [ … ], "connections": { … } }'}
              value={texte}
              onChange={(e) => setTexte(e.target.value)}
            />
            <span className="aide">
              Collez le JSON, déposez le fichier ici ou{" "}
              <label className="flux-lien-fichier">
                choisissez-le
                <input
                  type="file"
                  accept="application/json,.json"
                  className="visuellement-cache"
                  onChange={(e) => void lireFichier(e.target.files?.[0])}
                />
              </label>
              .
            </span>
          </div>
          <div className="rangee">
            <span className="espace" />
            <Bouton onClick={fermer}>Annuler</Bouton>
            <Bouton type="submit" variante="primaire" chargement={envoi} disabled={!texte.trim()}>
              Convertir
            </Bouton>
          </div>
        </form>
      )}
    </Modale>
  );
}

export function Automatisations() {
  useTitrePage("Automatisations");
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const toast = useToast();
  const [importer, setImporter] = useState(false);
  const [vue, setVue] = useState<Vue>(() => {
    const v = parametre("vue");
    return v === "modeles" || v === "secrets" ? v : "workflows";
  });
  const d = useDonnees(async () => {
    const [workflows, modeles] = await Promise.all([api.automatisations(), api.modelesAutomatisations()]);
    return { workflows, modeles };
  });

  function changerVue(v: Vue) {
    setVue(v);
    history.replaceState(null, "", v === "workflows" ? "/app/automatisations" : `/app/automatisations?vue=${v}`);
  }

  async function basculer(a: ResumeAutomatisation, actif: boolean) {
    try {
      await api.modifierAutomatisation(a.id, { actif });
      toast(actif ? `« ${a.nom} » activé` : `« ${a.nom} » désactivé`);
      d.recharger();
    } catch (e) {
      const x = e as ErreurApi;
      toast(x.details.length ? `${x.message} : ${x.details[0]}` : x.message);
    }
  }

  let workflows;
  if (d.etat === "chargement") workflows = <EtatChargement />;
  else if (d.etat === "erreur") workflows = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (!d.donnees.workflows.length)
    workflows = (
      <div className="flux-accueil">
        <EtatVide icone={Workflow} titre="Automatisez votre gestion">
          <p>
            Une facture émise, un paiement reçu, un formulaire de votre site ou une heure fixe déclenchent une suite
            d'actions : prévenir l'équipe, relancer un client, appeler une API, classer un message avec un modèle d'IA.
          </p>
          {ecrire && (
            <div className="rangee">
              <Lien className="bouton bouton-primaire" href="/app/automatisations/nouveau">
                Créer un workflow
              </Lien>
              <Bouton onClick={() => changerVue("modeles")}>Partir d'un modèle</Bouton>
            </div>
          )}
        </EtatVide>
        <h2 className="flux-section-titre">Pour commencer</h2>
        <Galerie modeles={d.donnees.modeles.slice(0, 3)} ecrire={ecrire} />
      </div>
    );
  else
    workflows = (
      <ul className="flux-cartes">
        {d.donnees.workflows.map((a) => (
          <CarteWorkflow key={a.id} a={a} ecrire={ecrire} onBascule={(v) => basculer(a, v)} />
        ))}
      </ul>
    );

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Automatisations</h1>
        {ecrire && (
          <div className="rangee">
            <Bouton icone={FileInput} onClick={() => setImporter(true)}>
              Importer depuis n8n
            </Bouton>
            <Bouton variante="primaire" icone={Plus} onClick={() => naviguer("/app/automatisations/nouveau")}>
              Nouveau workflow
            </Bouton>
          </div>
        )}
      </div>
      <ImportN8n ouvert={importer} onFermer={() => setImporter(false)} onCree={d.recharger} />
      <Tabs.Root value={vue} onValueChange={(v) => changerVue(v as Vue)}>
        <Tabs.List className="flux-onglets-liste flux-onglets-page" aria-label="Sections des automatisations">
          <Tabs.Tab value="workflows" className="flux-onglet">
            Workflows
            {d.etat === "ok" && d.donnees.workflows.length > 0 && (
              <span className="flux-pastille">{d.donnees.workflows.length}</span>
            )}
          </Tabs.Tab>
          <Tabs.Tab value="modeles" className="flux-onglet">
            Modèles
          </Tabs.Tab>
          <Tabs.Tab value="secrets" className="flux-onglet">
            Secrets
          </Tabs.Tab>
          <Tabs.Indicator className="flux-onglet-indicateur" />
        </Tabs.List>
        <Tabs.Panel value="workflows" className="flux-onglet-panneau">
          {workflows}
        </Tabs.Panel>
        <Tabs.Panel value="modeles" className="flux-onglet-panneau">
          {d.etat === "ok" ? (
            <Galerie modeles={d.donnees.modeles} ecrire={ecrire} />
          ) : d.etat === "erreur" ? (
            <EtatErreur message={d.erreur} onReessayer={d.recharger} />
          ) : (
            <EtatChargement />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="secrets" className="flux-onglet-panneau">
          <Secrets ecrire={ecrire} />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

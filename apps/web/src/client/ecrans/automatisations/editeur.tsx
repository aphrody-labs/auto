// Éditeur plein écran d'un workflow : canevas React Flow (fond à points, mini-carte, contrôles), palette des
// nœuds, panneau du nœud sélectionné, essai sans enregistrement avec résultats superposés aux nœuds,
// enregistrement, activation. Raccourcis : Ctrl+S enregistre, Ctrl+Entrée teste, Suppr retire la sélection.
import type { Definition, Noeud } from "@auto/automate";
import type { Portee } from "@auto/automate/expressions";
import {
  api,
  ErreurApi,
  type Automatisation,
  type Execution,
  type Secret,
  type TypeNoeudApi,
  type VersionAutomatisation,
} from "@auto/client";
import { ArrowLeft, History, Play, Plus, Save, Trash2, X } from "@auto/ui/symboles";
import {
  Bouton,
  EtatChargement,
  EtatErreur,
  Lien,
  Modale,
  naviguer,
  parametre,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { peut, useSession } from "../../session";
import { ContexteInsertion } from "./champs";
import { BadgeExecution, CATEGORIES, IconeM3, chargerCatalogue, elements, reprendreBrouillon } from "./commun";
import {
  areteDe,
  avecResultats,
  connexionValide,
  definitionVide,
  elaguer,
  estDeclencheur,
  idArete,
  nouveauNoeud,
  positionSuivante,
  predecesseurs,
  sortieDePoignee,
  sortiesNoeud,
  versDefinition,
  versFlux,
  type AreteFlux,
  type NoeudFlux,
} from "./graphe";
import { ContexteCatalogue, TYPES_NOEUDS } from "./noeud";
import { Palette, TYPE_GLISSE } from "./palette";
import { PanneauNoeud, type Onglet } from "./panneau";

interface Brouillon {
  id?: string;
  nom: string;
  description: string;
  actif: boolean;
  definition: Definition;
}

/** Workflow tout juste créé : l'éditeur rouvert sur son URL le reprend sans requête, avec son dernier essai. */
const repris = new Map<string, { automatisation: Automatisation; execution: Execution | null }>();

async function chargerBrouillon(
  id: string | undefined,
): Promise<{ brouillon: Brouillon; execution: Execution | null }> {
  if (id) {
    const r = repris.get(id);
    repris.delete(id);
    const a = r?.automatisation ?? (await api.automatisation(id));
    return {
      brouillon: { id: a.id, nom: a.nom, description: a.description ?? "", actif: a.actif, definition: a.definition },
      execution: r?.execution ?? null,
    };
  }
  const importe = parametre("import") ? reprendreBrouillon() : null;
  if (importe) return { brouillon: { ...importe, description: "", actif: false }, execution: null };
  const modele = parametre("modele");
  if (modele) {
    const m = (await api.modelesAutomatisations()).find((x) => x.id === modele);
    if (m)
      return {
        brouillon: { nom: m.nom, description: m.description, actif: false, definition: structuredClone(m.definition) },
        execution: null,
      };
  }
  return {
    brouillon: { nom: "Nouveau workflow", description: "", actif: false, definition: definitionVide() },
    execution: null,
  };
}

export function EditeurAutomatisation({ id }: { id?: string }) {
  const d = useDonnees(async () => {
    const [catalogue, secrets, initial] = await Promise.all([
      chargerCatalogue(),
      api.secrets().catch((): Secret[] => []),
      chargerBrouillon(id),
    ]);
    return { catalogue, secrets, ...initial };
  }, [id]);
  useTitrePage(d.etat === "ok" ? d.donnees.brouillon.nom : "Automatisation");

  if (d.etat !== "ok")
    return (
      <div className="flux-plein flux-plein-etat">
        {d.etat === "chargement" ? (
          <EtatChargement libelle="Ouverture du workflow" />
        ) : (
          <EtatErreur message={d.erreur} onReessayer={d.recharger} />
        )}
        <Lien className="bouton" href="/app/automatisations">
          Retour aux automatisations
        </Lien>
      </div>
    );
  return (
    <ReactFlowProvider>
      <Atelier {...d.donnees} />
    </ReactFlowProvider>
  );
}

const PAS_DE_MODIFICATION = new Set(["select", "dimensions"]);

function Atelier({
  catalogue: types,
  secrets,
  brouillon,
  execution: executionInitiale,
}: {
  catalogue: TypeNoeudApi[];
  secrets: Secret[];
  brouillon: Brouillon;
  execution: Execution | null;
}) {
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const toast = useToast();
  const rf = useReactFlow<NoeudFlux, AreteFlux>();
  const catalogue = useMemo(() => new Map(types.map((t) => [t.type, t])), [types]);
  const initial = useMemo(() => versFlux(brouillon.definition), [brouillon.definition]);

  const [nodes, setNodes, appliquerNoeuds] = useNodesState<NoeudFlux>(
    avecResultats(initial.nodes, executionInitiale?.etapes ?? null),
  );
  const [edges, setEdges, appliquerAretes] = useEdgesState<AreteFlux>(initial.edges);
  const [idCourant, setIdCourant] = useState(brouillon.id);
  const [nom, setNom] = useState(brouillon.nom);
  const [actif, setActif] = useState(brouillon.actif);
  const [modifie, setModifie] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [onglet, setOnglet] = useState<Onglet>("parametres");
  const [execution, setExecution] = useState<Execution | null>(executionInitiale);
  const [enEssai, setEnEssai] = useState(false);
  const [enregistrement, setEnregistrement] = useState(false);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [palette, setPalette] = useState(false);
  const [quitter, setQuitter] = useState(false);
  const [supprimer, setSupprimer] = useState(false);
  const [versions, setVersions] = useState<VersionAutomatisation[] | null>(null);
  const insertion = useRef(null);
  const canevas = useRef<HTMLDivElement>(null);

  const aUnDeclencheur = nodes.some((n) => estDeclencheur(n.data.noeud.type));

  // Avertit avant de quitter la page avec des modifications non enregistrées.
  useEffect(() => {
    if (!modifie) return;
    const avertir = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", avertir);
    return () => removeEventListener("beforeunload", avertir);
  }, [modifie]);

  const surNoeuds = useCallback(
    (changes: NodeChange<NoeudFlux>[]) => {
      if (!ecrire) changes = changes.filter((c) => PAS_DE_MODIFICATION.has(c.type));
      if (changes.some((c) => !PAS_DE_MODIFICATION.has(c.type))) setModifie(true);
      appliquerNoeuds(changes);
    },
    [appliquerNoeuds, ecrire],
  );
  const surAretes = useCallback(
    (changes: EdgeChange<AreteFlux>[]) => {
      if (!ecrire) changes = changes.filter((c) => c.type === "select");
      if (changes.some((c) => c.type !== "select")) setModifie(true);
      appliquerAretes(changes);
    },
    [appliquerAretes, ecrire],
  );
  const surConnexion = useCallback(
    (c: Connection) => {
      setModifie(true);
      setEdges((es) =>
        addEdge({ ...c, id: idArete({ de: c.source, sortie: sortieDePoignee(c.sourceHandle), vers: c.target }) }, es),
      );
    },
    [setEdges],
  );
  const connexionPermise: IsValidConnection<AreteFlux> = useCallback(
    (c) => connexionValide(c, rf.getNodes(), rf.getEdges()),
    [rf],
  );
  const surSelection = useCallback(({ nodes: ns }: OnSelectionChangeParams<NoeudFlux>) => {
    setSelection(ns.length === 1 ? ns[0]!.id : null);
  }, []);

  function ajouter(type: TypeNoeudApi, position?: { x: number; y: number }) {
    if (!ecrire) return;
    if (estDeclencheur(type.type) && aUnDeclencheur) {
      toast("Un seul déclencheur par workflow");
      return;
    }
    const source = selection ? nodes.find((n) => n.id === selection) : undefined;
    let pos = position;
    if (!pos && source) pos = { x: source.position.x + 300, y: source.position.y };
    if (!pos) {
      const r = canevas.current?.getBoundingClientRect();
      pos = r
        ? rf.screenToFlowPosition({ x: r.left + r.width / 2 - 110, y: r.top + r.height / 2 - 40 })
        : positionSuivante(nodes);
    }
    const n = {
      ...nouveauNoeud(
        type,
        pos,
        nodes.map((x) => x.id),
      ),
      selected: true,
    };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), n]);
    // Ajout depuis un nœud sélectionné : relié à sa première sortie, comme dans n8n.
    if (!position && source && !estDeclencheur(type.type))
      setEdges((es) => [...es, areteDe({ de: source.id, sortie: 0, vers: n.id })]);
    setSelection(n.id);
    // Le nouveau nœud est amené au centre du canevas (il peut naître hors champ, à droite de sa source).
    if (!position) void rf.setCenter(n.position.x + 116, n.position.y + 40, { zoom: rf.getZoom(), duration: 250 });
    setOnglet("parametres");
    setModifie(true);
    setPalette(false);
  }

  function deposer(e: DragEvent) {
    e.preventDefault();
    const t = catalogue.get(e.dataTransfer.getData(TYPE_GLISSE));
    if (t) ajouter(t, rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 32 }));
  }

  function majNoeud(n: Noeud) {
    setModifie(true);
    setNodes((ns) => ns.map((x) => (x.id === n.id ? { ...x, data: { ...x.data, noeud: n } } : x)));
    setEdges((es) => elaguer(es, n.id, sortiesNoeud(n, catalogue.get(n.type)).length));
  }

  function retirer(id: string) {
    void rf.deleteElements({ nodes: [{ id }] });
    setSelection(null);
    setModifie(true);
  }

  const definition = () => versDefinition(rf.getNodes(), rf.getEdges());

  async function tester() {
    setEnEssai(true);
    setErreur(null);
    try {
      const def = definition();
      const manuel = def.noeuds.find((n) => n.type === "declencheur.manuel");
      const donnees = (manuel?.parametres.donnees as Record<string, unknown> | undefined) ?? undefined;
      const r = await api.essaiAutomatisation(def, donnees);
      setExecution(r);
      setNodes((ns) => avecResultats(ns, r.etapes));
      const enEchec = r.etapes.find((e) => e.erreur);
      if (enEchec) {
        setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === enEchec.noeud })));
        setSelection(enEchec.noeud);
        setOnglet("resultat");
      } else toast(`Essai réussi : ${r.etapes.length} étapes`);
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnEssai(false);
    }
  }

  async function enregistrer(champs: { actif?: boolean } = {}) {
    if (!nom.trim()) {
      setErreur(new ErreurApi("Donnez un nom au workflow.", 422));
      return false;
    }
    setEnregistrement(true);
    setErreur(null);
    try {
      const corps = { nom: nom.trim(), definition: definition(), ...champs };
      const a = idCourant
        ? await api.modifierAutomatisation(idCourant, corps)
        : await api.creerAutomatisation({ ...corps, description: brouillon.description || undefined });
      setModifie(false);
      setActif(a.actif);
      if (!idCourant) {
        setIdCourant(a.id);
        repris.set(a.id, { automatisation: a, execution });
        naviguer(`/app/automatisations/${a.id}`, true);
      }
      toast(champs.actif === undefined ? "Workflow enregistré" : a.actif ? "Workflow activé" : "Workflow désactivé");
      return true;
    } catch (e) {
      setErreur(e as ErreurApi);
      return false;
    } finally {
      setEnregistrement(false);
    }
  }

  async function supprimerWorkflow() {
    if (!idCourant) return;
    try {
      await api.supprimerAutomatisation(idCourant);
      setModifie(false);
      toast("Workflow supprimé");
      naviguer("/app/automatisations");
    } catch (e) {
      setErreur(e as ErreurApi);
      setSupprimer(false);
    }
  }

  // Ctrl+S et Ctrl+Entrée ; Échap ferme le panneau.
  const raccourcis = useRef({ enregistrer, tester });
  raccourcis.current = { enregistrer, tester };
  useEffect(() => {
    const surTouche = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (ecrire) void raccourcis.current.enregistrer();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void raccourcis.current.tester();
      }
    };
    addEventListener("keydown", surTouche);
    return () => removeEventListener("keydown", surTouche);
  }, [ecrire]);

  // Arêtes : celles qui ont transporté des éléments lors du dernier essai sont accentuées et comptées.
  const aretes = useMemo(() => {
    if (!execution) return edges;
    const parNoeud = new Map(execution.etapes.map((e) => [e.noeud, e]));
    return edges.map((e) => {
      const n = parNoeud.get(e.source)?.sorties[sortieDePoignee(e.sourceHandle)] ?? 0;
      return n > 0 ? { ...e, className: "flux-arete-active", label: elements(n) } : e;
    });
  }, [edges, execution]);

  const choisi = selection ? nodes.find((n) => n.id === selection) : undefined;
  const etapes = useMemo(() => new Map((execution?.etapes ?? []).map((e) => [e.noeud, e])), [execution]);
  const avant = choisi ? predecesseurs(edges, choisi.id) : [];
  const entree = (avant.map((id) => etapes.get(id)?.apercu[0]?.json).find(Boolean) ?? null) as Record<
    string,
    unknown
  > | null;
  const portee: Portee | null = useMemo(() => {
    if (!execution || !entree) return null;
    const noeuds: Record<string, Record<string, unknown>> = {};
    for (const e of execution.etapes) if (e.apercu[0]) noeuds[e.noeud] = e.apercu[0].json;
    return {
      json: entree,
      noeuds,
      secrets: Object.fromEntries(secrets.map((s) => [s.nom, "••••••"])),
      execution: { id: execution.id },
      workflow: { id: idCourant ?? "brouillon", nom },
      index: 0,
    };
  }, [execution, entree, secrets, idCourant, nom]);

  const declencheur = nodes.find((n) => estDeclencheur(n.data.noeud.type));
  const typeDeclencheur = declencheur ? catalogue.get(declencheur.data.noeud.type) : undefined;

  return (
    <ContexteCatalogue.Provider value={catalogue}>
      <ContexteInsertion.Provider value={insertion}>
        <div className="flux-plein" data-panneau={choisi ? "ouvert" : undefined} data-palette={palette || undefined}>
          <h1 className="visuellement-cache">Workflow « {nom} »</h1>
          <header className="flux-barre">
            <Bouton
              variante="fantome"
              icone={ArrowLeft}
              aria-label="Retour aux automatisations"
              onClick={() => (modifie ? setQuitter(true) : naviguer("/app/automatisations"))}
            />
            <div className="flux-barre-titre">
              <input
                className="flux-titre-saisie flux-titre-workflow"
                aria-label="Nom du workflow"
                value={nom}
                maxLength={120}
                readOnly={!ecrire}
                onChange={(e) => {
                  setNom(e.target.value);
                  setModifie(true);
                }}
              />
              <span className="flux-barre-meta">
                {typeDeclencheur && (
                  <span className="flux-puce-statique">
                    <IconeM3 nom={typeDeclencheur.icone} />
                    {typeDeclencheur.libelle}
                  </span>
                )}
                {modifie ? (
                  <span className="attenue">Modifications non enregistrées</span>
                ) : (
                  idCourant && <span className="attenue">Enregistré</span>
                )}
                {execution && <BadgeExecution statut={execution.statut} />}
              </span>
            </div>
            <span className="espace" />
            {idCourant && (
              <label className="flux-actif">
                <span>{actif ? "Actif" : "Inactif"}</span>
                <Switch.Root
                  className="interrupteur"
                  checked={actif}
                  disabled={!ecrire || enregistrement}
                  aria-label="Activer le workflow"
                  onCheckedChange={(v) => void enregistrer({ actif: v })}
                >
                  <Switch.Thumb className="interrupteur-curseur" />
                </Switch.Root>
              </label>
            )}
            <Bouton icone={Play} chargement={enEssai} onClick={() => void tester()} title="Ctrl+Entrée">
              Tester
            </Bouton>
            {ecrire && (
              <Bouton
                variante="primaire"
                icone={Save}
                chargement={enregistrement}
                disabled={!modifie && !!idCourant}
                onClick={() => void enregistrer()}
                title="Ctrl+S"
              >
                Enregistrer
              </Bouton>
            )}
            {idCourant && (
              <Menu.Root>
                <Menu.Trigger className="bouton bouton-fantome bouton-icone" aria-label="Plus d'actions">
                  <IconeM3 nom="more_vert" className="icone" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner sideOffset={6} align="end" className="menu-positionneur">
                    <Menu.Popup className="menu">
                      <Menu.Item
                        className="menu-element"
                        onClick={() => naviguer(`/app/automatisations/${idCourant}/executions`)}
                      >
                        <History className="icone icone-sm" aria-hidden="true" />
                        Historique des exécutions
                      </Menu.Item>
                      <Menu.Item
                        className="menu-element"
                        onClick={() =>
                          void api.versionsAutomatisation(idCourant).then(setVersions, (e: ErreurApi) => setErreur(e))
                        }
                      >
                        <History className="icone icone-sm" aria-hidden="true" />
                        Versions précédentes
                      </Menu.Item>
                      {ecrire && (
                        <Menu.Item className="menu-element" data-ton="danger" onClick={() => setSupprimer(true)}>
                          <Trash2 className="icone icone-sm" aria-hidden="true" />
                          Supprimer le workflow
                        </Menu.Item>
                      )}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            )}
          </header>

          {erreur && (
            <div className="flux-alerte bandeau bandeau-erreur" role="alert">
              <div>
                <strong>{erreur.message}</strong>
                {erreur.details.length > 0 && (
                  <ul>
                    {erreur.details.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
              <Bouton variante="fantome" icone={X} aria-label="Fermer le message" onClick={() => setErreur(null)} />
            </div>
          )}

          <div className="flux-corps">
            {ecrire && <Palette types={types} aUnDeclencheur={aUnDeclencheur} onAjouter={(t) => ajouter(t)} />}
            <section
              className="flux-canevas"
              ref={canevas}
              aria-label="Canevas du workflow"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(TYPE_GLISSE)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={deposer}
            >
              <ReactFlow<NoeudFlux, AreteFlux>
                nodes={nodes}
                edges={aretes}
                nodeTypes={TYPES_NOEUDS}
                onNodesChange={surNoeuds}
                onEdgesChange={surAretes}
                onConnect={surConnexion}
                isValidConnection={connexionPermise}
                onSelectionChange={surSelection}
                nodesDraggable={ecrire}
                nodesConnectable={ecrire}
                deleteKeyCode={ecrire ? ["Backspace", "Delete"] : null}
                snapToGrid
                snapGrid={[20, 20]}
                fitView
                fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }}
                minZoom={0.2}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ interactionWidth: 24 }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-right"
                  ariaLabel="Mini-carte du workflow"
                  nodeClassName={(n) => {
                    const t = catalogue.get((n as NoeudFlux).data.noeud.type);
                    return `flux-mini flux-mini-${t ? CATEGORIES[t.categorie].role : "primaire"}`;
                  }}
                />
              </ReactFlow>
              {ecrire && (
                <Bouton
                  variante="primaire"
                  icone={Plus}
                  className="flux-ajout-mobile"
                  aria-expanded={palette}
                  onClick={() => setPalette(!palette)}
                >
                  {palette ? "Fermer" : "Ajouter un nœud"}
                </Bouton>
              )}
              {nodes.length === 1 && !choisi && ecrire && (
                <p className="flux-astuce">
                  Glissez un nœud depuis la palette, ou sélectionnez un nœud puis cliquez un type pour l'ajouter à sa
                  suite.
                </p>
              )}
            </section>
            {choisi && (
              <PanneauNoeud
                key={choisi.id}
                noeud={choisi.data.noeud}
                type={catalogue.get(choisi.data.noeud.type)}
                etape={etapes.get(choisi.id)}
                entree={entree}
                portee={portee}
                autres={nodes.filter((n) => n.id !== choisi.id).map((n) => ({ id: n.id, nom: n.data.noeud.nom }))}
                secrets={secrets.map((s) => s.nom)}
                automatisationId={idCourant}
                onglet={onglet}
                onOnglet={setOnglet}
                onChange={majNoeud}
                onSupprimer={() => retirer(choisi.id)}
                onFermer={() => {
                  setNodes((ns) => ns.map((x) => ({ ...x, selected: false })));
                  setSelection(null);
                }}
              />
            )}
          </div>

          <Modale ouverte={quitter} titre="Quitter sans enregistrer ?" onFermer={() => setQuitter(false)}>
            <p>Les modifications de ce workflow seront perdues.</p>
            <div className="rangee">
              <span className="espace" />
              <Bouton onClick={() => setQuitter(false)}>Rester</Bouton>
              <Bouton
                variante="danger"
                onClick={() => {
                  setModifie(false);
                  naviguer("/app/automatisations");
                }}
              >
                Quitter
              </Bouton>
            </div>
          </Modale>
          <Modale ouverte={versions !== null} titre="Versions précédentes" onFermer={() => setVersions(null)}>
            {versions?.length === 0 ? (
              <p>Aucune version : elles apparaissent à chaque enregistrement qui change le workflow.</p>
            ) : (
              <>
                <p>
                  Restaurer remplace le workflow par la version choisie ; l'état actuel devient une version, la
                  restauration se défait donc de la même façon.
                  {modifie && " Enregistrez ou abandonnez d'abord vos modifications en cours."}
                </p>
                <ul className="flux-versions">
                  {versions?.map((v) => (
                    <li key={v.numero}>
                      <span>
                        <strong>
                          {v.numero}. {v.nom}
                        </strong>
                        <span className="aide">
                          {new Date(v.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })},{" "}
                          {v.definition.noeuds.length} nœuds
                        </span>
                      </span>
                      {ecrire && (
                        <Bouton
                          disabled={modifie}
                          onClick={() =>
                            void api.restaurerVersion(idCourant!, v.numero).then(
                              () => location.reload(),
                              (e: ErreurApi) => (setVersions(null), setErreur(e)),
                            )
                          }
                        >
                          Restaurer
                        </Bouton>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Modale>
          <Modale ouverte={supprimer} titre="Supprimer ce workflow ?" onFermer={() => setSupprimer(false)}>
            <p>Le workflow « {nom} » et son historique d'exécutions seront supprimés.</p>
            <div className="rangee">
              <span className="espace" />
              <Bouton onClick={() => setSupprimer(false)}>Annuler</Bouton>
              <Bouton variante="danger" icone={Trash2} onClick={() => void supprimerWorkflow()}>
                Supprimer
              </Bouton>
            </div>
          </Modale>
        </div>
      </ContexteInsertion.Provider>
    </ContexteCatalogue.Provider>
  );
}

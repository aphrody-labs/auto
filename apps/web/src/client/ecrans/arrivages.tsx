import { RevueDevis } from "./revue-devis";
import { useEffect, useState } from "react";
import { api, ErreurApi, type SourceFichiers, type DevisRecu, type Membre } from "@auto/client";
import { SEGMENTS, LIBELLES_SEGMENTS, type Segment } from "@auto/tenancy/segments";
import { enBase64, eur } from "@auto/ui/format";
import { Plus, RotateCcw, FileText, FolderOpen } from "@auto/ui/symboles";
import {
  Bandeau,
  Bouton,
  ChampTexte,
  ChampListe,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Lien,
  Modale,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { peut, useSession } from "../session";
import { ImportFichiers } from "./import-fichiers";
export function SourcesFichiers() {
  useTitrePage("Serveur de fichiers");
  const d = useDonnees(async () => {
    const [sources, racines] = await Promise.all([api.sourcesFichiers(), api.racinesFichiers()]);
    return { sources, racines };
  });
  const [edition, setEdition] = useState<SourceFichiers | null | undefined>();
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState("");
  const [suites, setSuites] = useState<Record<string, boolean>>({});
  const toast = useToast();
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>Serveur de fichiers</h1>
          <p className="attenue">Connectez les dossiers de votre entreprise et retrouvez leurs pièces dans auto.</p>
        </div>
        <div className="rangee">
          <Lien className="bouton" href="/app/fichiers#import-local">
            Importer depuis cet appareil
          </Lien>
          <Bouton icone={Plus} variante="primaire" onClick={() => setEdition(null)}>
            Connecter un dossier
          </Bouton>
        </div>
      </div>
      <ResumeErreurs erreur={erreur} />
      <Bandeau titre="Synchronisation en lecture seule">
        <p>
          Auto conserve une copie des nouvelles pièces et les indexe, sans déplacer ni supprimer les originaux. Le
          worker vérifie les sources actives toutes les cinq minutes.
        </p>
      </Bandeau>
      {d.etat === "chargement" ? (
        <EtatChargement />
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <>
          {!d.donnees.racines.length && (
            <Bandeau ton="avertissement" titre="Aucun montage autorisé">
              <p>
                L’opérateur doit déclarer le dossier monté SMB/NFS ou local dans AUTO_DOSSIERS_RACINES, avec
                l’identifiant de votre entreprise. Les chemins arbitraires ne sont pas acceptés.
              </p>
            </Bandeau>
          )}
          {!d.donnees.sources.length ? (
            <EtatVide icone={FolderOpen} titre="Aucun dossier connecté" />
          ) : (
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead>
                  <tr>
                    {["Dossier", "Traitement", "Segment", "Dernier relevé", "État", "Actions"].map((t) => (
                      <th scope="col" key={t}>
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.donnees.sources.map((s) => (
                    <tr key={s.id}>
                      <td data-libelle="Dossier">
                        <strong>{s.nom}</strong>
                        <div className="aide">
                          {s.racine}/{s.sousDossier}
                        </div>
                      </td>
                      <td data-libelle="Traitement">
                        {
                          { index: "Indexer", facture: "Extraire les factures", devis: "Extraire les devis" }[
                            s.traitement
                          ]
                        }
                      </td>
                      <td data-libelle="Segment">{LIBELLES_SEGMENTS[s.segment]}</td>
                      <td data-libelle="Dernier relevé">
                        {s.synchroniseAt ? new Date(s.synchroniseAt).toLocaleString("fr-FR") : "Jamais"}
                      </td>
                      <td data-libelle="État">{s.erreur || (!s.actif ? "Désactivé" : "Actif")}</td>
                      <td data-libelle="Actions">
                        <div className="rangee">
                          <Bouton onClick={() => setEdition(s)}>Modifier</Bouton>
                          <Bouton
                            icone={RotateCcw}
                            disabled={!s.actif || !!envoi}
                            chargement={envoi === s.id}
                            onClick={async () => {
                              setEnvoi(s.id);
                              setErreur(null);
                              try {
                                const r = await api.synchroniserSource(s.id);
                                setSuites((precedentes) => ({ ...precedentes, [s.id]: r.limiteAtteinte }));
                                toast(
                                  `${r.nouveaux} nouvelle(s) pièce(s), ${r.inchanges} inchangée(s), ${r.erreurs.length} erreur(s)${r.limiteAtteinte ? " · continuez la synchronisation pour traiter la suite" : ""}`,
                                );
                                d.recharger();
                              } catch (e) {
                                setErreur(e as ErreurApi);
                              } finally {
                                setEnvoi("");
                              }
                            }}
                          >
                            {(suites[s.id] ?? !!s.curseur) ? "Continuer la synchronisation" : "Synchroniser"}
                          </Bouton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Modale
            ouverte={edition !== undefined}
            titre={edition ? "Modifier le dossier" : "Connecter un dossier"}
            onFermer={() => setEdition(undefined)}
          >
            {edition !== undefined && (
              <FormulaireSource
                initial={edition}
                racines={d.donnees.racines}
                onFin={() => {
                  setEdition(undefined);
                  d.recharger();
                }}
              />
            )}
          </Modale>
        </>
      )}
      <Lien className="bouton" href="/app/fichiers">
        Consulter les fichiers indexés
      </Lien>
    </div>
  );
}
function FormulaireSource({
  initial,
  racines,
  onFin,
}: {
  initial: SourceFichiers | null;
  racines: string[];
  onFin: () => void;
}) {
  const [p, setP] = useState<Omit<SourceFichiers, "id" | "synchroniseAt" | "erreur">>(
    initial ?? {
      nom: "",
      racine: racines[0] || "",
      sousDossier: "",
      segment: "fournisseurs",
      traitement: "index",
      actif: true,
    },
  );
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  return (
    <form
      className="grille"
      onSubmit={async (e) => {
        e.preventDefault();
        setEnvoi(true);
        setErreur(null);
        try {
          await api.sauverSource(p, initial?.id);
          onFin();
        } catch (e) {
          setErreur(e as ErreurApi);
        } finally {
          setEnvoi(false);
        }
      }}
    >
      <ResumeErreurs erreur={erreur} />
      <ChampTexte libelle="Nom du dossier" requis value={p.nom} onChange={(e) => setP({ ...p, nom: e.target.value })} />
      <ChampListe
        libelle="Montage autorisé"
        requis
        value={p.racine}
        onChange={(e) => setP({ ...p, racine: e.target.value })}
      >
        {racines.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </ChampListe>
      <ChampTexte
        libelle="Sous-dossier"
        aide="Chemin relatif au montage ; laissez vide pour sa racine."
        value={p.sousDossier}
        onChange={(e) => setP({ ...p, sousDossier: e.target.value })}
      />
      <ChampListe
        libelle="Traitement automatique"
        value={p.traitement}
        onChange={(e) =>
          setP({
            ...p,
            traitement: e.target.value as typeof p.traitement,
            ...(e.target.value !== "index" ? { segment: "fournisseurs" as const } : {}),
          })
        }
      >
        <option value="index">Indexer et rechercher les documents</option>
        <option value="facture">Extraire les factures reçues</option>
        <option value="devis">Extraire les devis reçus</option>
      </ChampListe>
      <ChampListe
        libelle="Segment autorisé à consulter"
        disabled={p.traitement !== "index"}
        value={p.segment}
        onChange={(e) => setP({ ...p, segment: e.target.value as Segment })}
      >
        {SEGMENTS.map((s) => (
          <option value={s} key={s}>
            {LIBELLES_SEGMENTS[s]}
          </option>
        ))}
      </ChampListe>
      <label className="rangee permission-option">
        <input type="checkbox" checked={p.actif} onChange={(e) => setP({ ...p, actif: e.target.checked })} />
        Synchronisation active
      </label>
      <div className="rangee">
        <Bouton onClick={onFin}>Annuler</Bouton>
        <Bouton type="submit" variante="primaire" chargement={envoi} disabled={!racines.length}>
          Enregistrer la connexion
        </Bouton>
      </div>
    </form>
  );
}
export function FichiersIndexes() {
  useTitrePage("Fichiers et dossiers");
  const { moi } = useSession();
  const [erreurCopie, setErreurCopie] = useState<ErreurApi | null>(null);
  const [copie, setCopie] = useState("");
  const [q, setQ] = useState("");
  const [recherche, setRecherche] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setRecherche(q.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  const d = useDonnees(() => api.rechercherFichiersIndexes(recherche, page), [recherche, page]);
  return (
    <div className="page pile">
      <h1>Fichiers et dossiers</h1>
      {peut(moi.role, "ecrire") && (
        <ImportFichiers
          onTermine={() => {
            setPage(0);
            if (page === 0) d.recharger();
          }}
        />
      )}
      <ResumeErreurs erreur={erreurCopie} />
      <ChampTexte libelle="Rechercher un fichier" value={q} onChange={(e) => setQ(e.target.value)} />
      {d.etat === "ok" ? (
        <div className="tableau-conteneur">
          <table className="tableau">
            <thead>
              <tr>
                {["Fichier", "Dossier", "Segment", "Extrait"].map((t) => (
                  <th key={t} scope="col">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.donnees.fichiers.map((f) => (
                <tr key={f.id}>
                  <td data-libelle="Fichier">
                    <a href={api.url(`/v1/fichiers-indexes/${f.id}/fichier`)} download>
                      {f.nom}
                    </a>
                    {peut(moi.role, "ecrire") && /\.(docx|xlsx|pdf)$/i.test(f.nom) && (
                      <Bouton
                        disabled={!!copie}
                        chargement={copie === f.id}
                        onClick={async () => {
                          setCopie(f.id);
                          setErreurCopie(null);
                          try {
                            const d = await api.importerAtelier({ indexId: f.id, segment: f.segment });
                            location.assign("/app/atelier/" + d.id);
                          } catch (e) {
                            setErreurCopie(e as ErreurApi);
                          } finally {
                            setCopie("");
                          }
                        }}
                      >
                        Travailler sur une copie
                      </Bouton>
                    )}
                  </td>
                  <td data-libelle="Dossier">{f.chemin}</td>
                  <td data-libelle="Segment">{LIBELLES_SEGMENTS[f.segment]}</td>
                  <td data-libelle="Extrait">{f.texte.slice(0, 160)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.donnees.fichiers.length && (
            <EtatVide titre={recherche ? "Aucun fichier trouvé" : "Aucun fichier indexé"} />
          )}
          <div className="rangee" aria-label="Pages de fichiers">
            <Bouton disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Fichiers précédents
            </Bouton>
            <span>Page {page + 1}</span>
            <Bouton disabled={!d.donnees.suite} onClick={() => setPage((p) => p + 1)}>
              Fichiers suivants
            </Bouton>
          </div>
        </div>
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <EtatChargement />
      )}
      <p className="attenue">
        100 fichiers par page. La recherche porte sur tous les fichiers de vos espaces autorisés, y compris les anciens
        imports.
      </p>
    </div>
  );
}
export function DevisRecus() {
  useTitrePage("Devis reçus");
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const d = useDonnees(() => api.devisRecus());
  const [selection, setSelection] = useState<DevisRecu | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>Devis reçus</h1>
          <p className="attenue">
            Extraction automatique des scans et PDF, puis vérification avant création d’un brouillon.
          </p>
        </div>
      </div>
      <ResumeErreurs erreur={erreur} />
      {ecrire && (
        <ChampTexte
          libelle="Importer un devis PDF ou image"
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          disabled={envoi}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setEnvoi(true);
            setErreur(null);
            try {
              if (file.size > 20 * 1024 * 1024) throw new ErreurApi("20 Mo maximum", 413);
              await api.deposerDevis(enBase64(new Uint8Array(await file.arrayBuffer())), file.name, file.type);
              toast("Devis extrait et placé dans la file de vérification");
              d.recharger();
            } catch (e) {
              setErreur(e as ErreurApi);
            } finally {
              setEnvoi(false);
            }
          }}
        />
      )}
      {envoi && <EtatChargement libelle="Extraction du devis" lignes={1} />}
      <Bandeau>
        <p>
          Les pièces déposées dans un dossier « Extraire les devis » ou reçues par e-mail avec « devis » dans le sujet
          passent par cette même file. Aucune émission automatique.
        </p>
      </Bandeau>
      {d.etat === "ok" ? (
        d.donnees.length ? (
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead>
                <tr>
                  {["Référence", "Émetteur", "TTC", "Statut", "Actions"].map((t) => (
                    <th scope="col" key={t}>
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.donnees.map((r) => (
                  <tr key={r.id}>
                    <td data-libelle="Référence">
                      <a href={api.url(`/v1/devis-recus/${r.id}/fichier`)} target="_blank" rel="noopener">
                        {r.data?.numero || "Ouvrir l’original"}
                      </a>
                    </td>
                    <td data-libelle="Émetteur">{r.data?.fournisseur.nom || "Non lu"}</td>
                    <td data-libelle="TTC">{r.data?.devise === "EUR" ? eur(r.data.totaux.ttcCents) : "—"}</td>
                    <td data-libelle="Statut">
                      {{ a_verifier: "À vérifier", valide: "Validé", rejete: "Rejeté" }[r.statut]}
                      {r.anomalies.length > 0 && <div className="aide">{r.anomalies.join(" · ")}</div>}
                    </td>
                    <td data-libelle="Actions">
                      <Bouton onClick={() => setSelection(r)}>{ecrire ? "Vérifier" : "Consulter"}</Bouton>
                      {r.brouillonId && <Lien href={"/app/documents/" + r.brouillonId}>Brouillon créé</Lien>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EtatVide icone={FileText} titre="Aucun devis reçu" />
        )
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <EtatChargement />
      )}
      <Modale ouverte={!!selection} titre="Vérifier le devis extrait" onFermer={() => setSelection(null)}>
        {selection && (
          <RevueDevis
            devis={selection}
            ecrire={ecrire}
            onFin={() => {
              setSelection(null);
              d.recharger();
            }}
          />
        )}
      </Modale>
    </div>
  );
}
export function PermissionsMembres({ membres }: { membres: Membre[] }) {
  const d = useDonnees(() => api.segmentsMembres());
  const [user, setUser] = useState("");
  const [choix, setChoix] = useState<Segment[]>([]);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  return (
    <section className="carte grille">
      <h3>Permissions par segment</h3>
      <p className="attenue">
        Les propriétaires et administrateurs conservent tous les accès. Les restrictions s’appliquent aussi aux clés
        API, agents, recherches et exports.
      </p>
      {d.etat === "ok" ? (
        <form
          className="grille"
          onSubmit={async (e) => {
            e.preventDefault();
            setEnvoi(true);
            setErreur(null);
            try {
              await api.modifierSegments(user, choix);
              toast("Permissions enregistrées");
              d.recharger();
            } catch (e) {
              setErreur(e as ErreurApi);
            } finally {
              setEnvoi(false);
            }
          }}
        >
          <ResumeErreurs erreur={erreur} />
          <ChampListe
            libelle="Membre à configurer"
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              setChoix(d.donnees.find((m) => m.userId === e.target.value)?.segments ?? [...SEGMENTS]);
            }}
          >
            <option value="">Choisir un membre</option>
            {membres
              .filter((m) => !["owner", "admin"].includes(m.role))
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.email}
                </option>
              ))}
          </ChampListe>
          {user && (
            <fieldset className="grille">
              <legend>Espaces accessibles</legend>
              {SEGMENTS.map((s) => (
                <label className="rangee permission-option" key={s}>
                  <input
                    type="checkbox"
                    checked={choix.includes(s)}
                    onChange={(e) => setChoix(e.target.checked ? [...choix, s] : choix.filter((c) => c !== s))}
                  />
                  {LIBELLES_SEGMENTS[s]}
                </label>
              ))}
            </fieldset>
          )}
          <Bouton variante="primaire" type="submit" disabled={!user} chargement={envoi}>
            Enregistrer les permissions
          </Bouton>
        </form>
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <EtatChargement />
      )}
    </section>
  );
}

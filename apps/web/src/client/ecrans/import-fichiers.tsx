import { useEffect, useRef, useState } from "react";
import { api, ErreurApi } from "@auto/client";
import { segmentsDe, LIBELLES_SEGMENTS, type Segment } from "@auto/tenancy/segments";
import { Bouton, ChampListe, Lien } from "@auto/ui/react";
import { Upload, FilePlus2, FolderOpen, RotateCcw, Ban, Check, CircleAlert } from "@auto/ui/symboles";
import { useSession } from "../session";
import {
  fichiersDeposes,
  selectionFichiers,
  validerSelection,
  LIMITE_FICHIER,
  type FichierLocal,
} from "../import-fichiers";

type Etat = "attente" | "envoi" | "importe" | "doublon" | "erreur";
interface LigneImport extends FichierLocal {
  id: string;
  etat: Etat;
  message: string;
  reessayable: boolean;
}
const ETATS: Record<Etat, string> = {
  attente: "À importer",
  envoi: "Import en cours…",
  importe: "Importé",
  doublon: "Déjà présent",
  erreur: "Échec",
};
const taille = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`
    : `${Math.ceil(n / 1024)} Ko`;

export function ImportFichiers({ onTermine }: { onTermine: () => void }) {
  const { moi } = useSession();
  const [lignes, setLignes] = useState<LigneImport[]>([]);
  const file = useRef<LigneImport[]>([]);
  const controle = useRef<AbortController | null>(null);
  const monte = useRef(true);
  const choixFichiers = useRef<HTMLInputElement>(null),
    choixDossier = useRef<HTMLInputElement>(null);
  const [segment, setSegment] = useState<Segment>(segmentsDe(moi)[0] ?? "clients");
  const [cible, setCible] = useState<"index" | "devis" | "facture">("index");
  const [actif, setActif] = useState(false),
    [lecture, setLecture] = useState(false),
    [survol, setSurvol] = useState(false);
  const [erreur, setErreur] = useState(""),
    [filtre, setFiltre] = useState("tous");
  useEffect(() => {
    monte.current = true;
    return () => {
      monte.current = false;
      controle.current?.abort();
    };
  }, []);
  function actualiser(suivantes: LigneImport[]) {
    file.current = suivantes;
    if (monte.current) setLignes(suivantes);
  }
  function changer(id: string, patch: Partial<LigneImport>) {
    actualiser(file.current.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function ajouter(ajouts: FichierLocal[]) {
    if (controle.current) return;
    setErreur("");
    try {
      const suivants = validerSelection(file.current, ajouts);
      const connus = new Map(file.current.map((l) => [`${l.chemin}\0${l.fichier.size}\0${l.fichier.lastModified}`, l]));
      actualiser(
        suivants.map(
          (f) =>
            connus.get(`${f.chemin}\0${f.fichier.size}\0${f.fichier.lastModified}`) ?? {
              ...f,
              id: crypto.randomUUID(),
              etat: f.fichier.size > LIMITE_FICHIER ? "erreur" : "attente",
              message: f.fichier.size > LIMITE_FICHIER ? "Ce fichier dépasse 20 Mo." : "",
              reessayable: f.fichier.size <= LIMITE_FICHIER,
            },
        ),
      );
    } catch (e) {
      setErreur((e as Error).message);
    }
  }
  async function deposer(transfert: DataTransfer) {
    if (actif || lecture) return;
    setLecture(true);
    setErreur("");
    try {
      ajouter(await fichiersDeposes(transfert));
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      if (monte.current) setLecture(false);
    }
  }
  async function lancer(reprendre = false) {
    if (controle.current) return;
    if (reprendre)
      actualiser(
        file.current.map((l) => (l.etat === "erreur" && l.reessayable ? { ...l, etat: "attente", message: "" } : l)),
      );
    const selection = file.current.filter((l) => l.etat === "attente");
    if (!selection.length) return;
    const signal = new AbortController();
    controle.current = signal;
    setActif(true);
    setErreur("");
    let prochain = 0,
      importes = 0;
    async function envoyer() {
      while (!signal.signal.aborted && prochain < selection.length) {
        const l = selection[prochain++]!;
        changer(l.id, { etat: "envoi", message: "" });
        try {
          const r = await api.importerFichierLocal(l.fichier, l.chemin, segment, cible, signal.signal);
          changer(l.id, { etat: r.doublon ? "doublon" : "importe" });
          importes++;
        } catch (e) {
          changer(
            l.id,
            signal.signal.aborted
              ? { etat: "attente", message: "Import interrompu ; vous pouvez reprendre." }
              : {
                  etat: "erreur",
                  message: (e as Error).message || "Envoi interrompu. Réessayez.",
                  reessayable:
                    !(e instanceof ErreurApi) ||
                    e.status === 0 ||
                    e.status >= 500 ||
                    [408, 409, 429].includes(e.status),
                },
          );
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(selection.length, cible === "index" ? 2 : 1) }, envoyer));
    } finally {
      controle.current = null;
      if (monte.current) {
        setActif(false);
        if (importes) onTermine();
      }
    }
  }
  const importes = lignes.filter((l) => l.etat === "importe" || l.etat === "doublon").length;
  const echecs = lignes.filter((l) => l.etat === "erreur").length;
  const attendus = lignes.filter((l) => l.etat === "attente").length;
  const verrouille = actif || importes > 0;
  const visibles = lignes.filter(
    (l) =>
      filtre === "tous" || (filtre === "erreurs" ? l.etat === "erreur" : l.etat === "attente" || l.etat === "envoi"),
  );
  return (
    <section className="carte pile import-lot" id="import-local" aria-labelledby="import-local-titre">
      <div>
        <h2 id="import-local-titre">
          <Upload className="icone" aria-hidden="true" /> Importer des dossiers et fichiers
        </h2>
        <p>
          Conservez l’arborescence de votre appareil et retrouvez les originaux dans Auto. Les fichiers déjà présents
          sont reconnus.
        </p>
      </div>
      <div className="grille grille-2">
        <ChampListe
          libelle="Espace des fichiers importés"
          value={segment}
          disabled={verrouille}
          onChange={(e) => {
            setSegment(e.target.value as Segment);
            setCible("index");
          }}
        >
          {segmentsDe(moi).map((s) => (
            <option key={s} value={s}>
              {LIBELLES_SEGMENTS[s]}
            </option>
          ))}
        </ChampListe>
        <ChampListe
          libelle="Traitement de l’import"
          value={cible}
          disabled={verrouille}
          onChange={(e) => setCible(e.target.value as typeof cible)}
        >
          <option value="index">Conserver et indexer les documents</option>
          {segment === "fournisseurs" && (
            <>
              <option value="devis">Extraire les devis reçus</option>
              <option value="facture">Extraire les factures reçues</option>
            </>
          )}
        </ChampListe>
      </div>
      <div
        className="import-depot"
        data-survol={survol}
        role="region"
        aria-label="Dépôt de dossiers et fichiers"
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("Files")) {
            e.preventDefault();
            setSurvol(true);
          }
        }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setSurvol(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setSurvol(false);
          void deposer(e.dataTransfer);
        }}
      >
        <p>
          <strong>Glissez vos fichiers ou un dossier ici</strong>
        </p>
        <div className="rangee">
          <Bouton icone={FilePlus2} disabled={actif || lecture} onClick={() => choixFichiers.current?.click()}>
            Choisir des fichiers
          </Bouton>
          <Bouton icone={FolderOpen} disabled={actif || lecture} onClick={() => choixDossier.current?.click()}>
            Choisir un dossier
          </Bouton>
        </div>
        <input
          ref={choixFichiers}
          type="file"
          multiple
          hidden
          aria-label="Fichiers à importer"
          onChange={(e) => {
            ajouter(selectionFichiers(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <input
          ref={choixDossier}
          type="file"
          multiple
          {...{ webkitdirectory: "" }}
          hidden
          aria-label="Dossier à importer"
          onChange={(e) => {
            ajouter(selectionFichiers(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <p className="aide">
          5 000 fichiers et 1 Go par lot, 20 Mo par fichier. PDF, DOCX, XLSX, CSV, XML, texte et images PNG/JPEG. Les
          envois sont progressifs.
        </p>
        {lecture && <p role="status">Lecture de l’arborescence…</p>}
      </div>
      {erreur && <p role="alert">{erreur}</p>}
      {!!lignes.length && (
        <>
          <p role="status" aria-live="polite">
            {importes} sur {lignes.length} fichiers conservés · {echecs} en échec · {attendus} à importer ·{" "}
            {taille(lignes.reduce((s, l) => s + l.fichier.size, 0))}
          </p>
          <progress
            className="import-progression"
            max={lignes.length}
            value={importes + echecs}
            aria-label="Progression de l’import"
          />
          <div className="rangee">
            <Bouton
              variante="primaire"
              icone={Upload}
              disabled={actif || lecture || !attendus}
              onClick={() => void lancer()}
            >
              {importes ? "Continuer l’import" : "Importer le lot"}
            </Bouton>
            {actif && (
              <Bouton icone={Ban} onClick={() => controle.current?.abort()}>
                Mettre en pause
              </Bouton>
            )}
            {!!echecs && (
              <Bouton
                icone={RotateCcw}
                disabled={actif || !lignes.some((l) => l.etat === "erreur" && l.reessayable)}
                onClick={() => void lancer(true)}
              >
                Réessayer les échecs
              </Bouton>
            )}
            <Bouton
              variante="fantome"
              disabled={actif || lecture}
              onClick={() => {
                actualiser([]);
                setErreur("");
              }}
            >
              Vider la sélection
            </Bouton>
          </div>
          <p className="aide">
            Gardez cette page ouverte pendant l’import. La pause conserve les fichiers déjà reçus ; une reprise ne les
            duplique pas.
          </p>
          <ChampListe libelle="Afficher les fichiers du lot" value={filtre} onChange={(e) => setFiltre(e.target.value)}>
            <option value="tous">Tous</option>
            <option value="erreurs">Échecs</option>
            <option value="attente">À importer</option>
          </ChampListe>
          <ul className="import-resultats">
            {visibles.slice(0, 100).map((l) => (
              <li key={l.id}>
                {l.etat === "erreur" ? (
                  <CircleAlert className="icone" aria-hidden="true" />
                ) : l.etat === "importe" || l.etat === "doublon" ? (
                  <Check className="icone" aria-hidden="true" />
                ) : (
                  <FilePlus2 className="icone" aria-hidden="true" />
                )}
                <div>
                  <strong>{l.chemin}</strong>
                  <small>
                    {taille(l.fichier.size)} · {ETATS[l.etat]}
                    {l.message ? ` · ${l.message}` : ""}
                  </small>
                </div>
              </li>
            ))}
          </ul>
          {visibles.length > 100 && (
            <p className="aide">
              100 fichiers affichés sur {visibles.length}. Le lot complet sera traité ; filtrez pour examiner les
              échecs.
            </p>
          )}
        </>
      )}
      <p>
        Pour un dossier distant SMB, NFS ou Windows partagé,{" "}
        <Lien href="/app/sources-fichiers">connectez un dossier serveur</Lien>. Sa synchronisation conserve les chemins
        et reconnaît les fichiers inchangés.
      </p>
    </section>
  );
}

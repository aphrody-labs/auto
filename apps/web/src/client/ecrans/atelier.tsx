import { useState } from "react";
import { api, ErreurApi, type DocumentAtelier } from "@auto/client";
import { segmentsDe, LIBELLES_SEGMENTS, type Segment } from "@auto/tenancy/segments";
import {
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
import { FileText, FileSpreadsheet, FileCheck } from "@auto/ui/symboles";
import { enBase64 } from "@auto/ui/format";
import { useSession, peut } from "../session";
import { BureauCraft } from "./editeur-craft";
import { FORMATS_CRAFT as FORMATS } from "../craft-bridge";
const ICONES_FORMAT = { word: FileText, excel: FileSpreadsheet, pdf: FileCheck };
function IconeFormat({ format }: { format: keyof typeof ICONES_FORMAT }) {
  const Icone = ICONES_FORMAT[format];
  return <Icone className="icone atelier-format-icone" aria-hidden="true" />;
}
export function Atelier() {
  useTitrePage("Documents Word, Excel et PDF");
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const d = useDonnees(() => api.atelier());
  const [q, setQ] = useState(""),
    [format, setFormat] = useState(""),
    [archives, setArchives] = useState(false),
    [nouveau, setNouveau] = useState<"word" | "excel" | null>(null),
    [nom, setNom] = useState(""),
    [segment, setSegment] = useState<Segment>(segmentsDe(moi)[0] ?? "clients"),
    [erreur, setErreur] = useState<ErreurApi | null>(null),
    [envoi, setEnvoi] = useState(false);
  const toast = useToast();
  async function importer(file: File) {
    setEnvoi(true);
    setErreur(null);
    try {
      if (file.size > 20 * 1024 * 1024) throw new ErreurApi("20 Mo maximum", 413);
      const doc = await api.importerAtelier({
        nom: file.name,
        segment,
        fichier: enBase64(new Uint8Array(await file.arrayBuffer())),
      });
      location.assign("/app/atelier/" + doc.id);
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  const afficher = (x: DocumentAtelier) =>
    x.archive === archives &&
    (!format || x.format === format) &&
    x.nom.toLocaleLowerCase().includes(q.toLocaleLowerCase());
  return (
    <div className="page pile">
      <div className="page-entete">
        <div>
          <h1>Documents Word, Excel et PDF</h1>
          <p className="attenue">Travaillez avec Craft. Chaque sauvegarde garde son historique.</p>
        </div>
        {ecrire && (
          <div className="rangee">
            {(["word", "excel"] as const).map((f) => (
              <Bouton
                key={f}
                icone={ICONES_FORMAT[f]}
                onClick={() => {
                  setNouveau(f);
                  setNom(f === "word" ? "Document.docx" : "Classeur.xlsx");
                }}
              >
                Nouveau {FORMATS[f]}
              </Bouton>
            ))}
          </div>
        )}
      </div>
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-3">
        <ChampTexte libelle="Rechercher un document" value={q} onChange={(e) => setQ(e.target.value)} />
        <ChampListe libelle="Format du document" value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="">Tous les formats</option>
          {Object.entries(FORMATS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </ChampListe>
        <ChampListe
          libelle="État des documents"
          value={archives ? "archives" : "actifs"}
          onChange={(e) => setArchives(e.target.value === "archives")}
        >
          <option value="actifs">Documents actifs</option>
          <option value="archives">Documents archivés</option>
        </ChampListe>
      </div>
      {ecrire && (
        <section className="carte grille" aria-labelledby="atelier-import">
          <h2 id="atelier-import">Importer un document</h2>
          <div className="grille grille-2">
            <ChampListe
              libelle="Espace de classement"
              value={segment}
              onChange={(e) => setSegment(e.target.value as Segment)}
            >
              {segmentsDe(moi).map((s) => (
                <option key={s} value={s}>
                  {LIBELLES_SEGMENTS[s]}
                </option>
              ))}
            </ChampListe>
            <ChampTexte
              libelle="Choisir un fichier Word, Excel ou PDF"
              type="file"
              accept=".docx,.xlsx,.pdf"
              disabled={envoi}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importer(f);
                e.target.value = "";
              }}
            />
          </div>
          <p className="aide">
            20 Mo maximum. Les pièces du serveur peuvent être ouvertes sur une copie ; leurs originaux restent
            conservés.
          </p>
          {envoi && <EtatChargement libelle="Import du document" lignes={1} />}
        </section>
      )}
      {d.etat === "chargement" ? (
        <EtatChargement />
      ) : d.etat === "erreur" ? (
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      ) : (
        <div className="tableau-conteneur" role="region" tabIndex={0} aria-label="Documents de l’atelier">
          <table className="tableau">
            <thead>
              <tr>
                {["Document", "Format", "Espace", "Dernière modification", "Version", "Actions"].map((t) => (
                  <th scope="col" key={t}>
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.donnees.filter(afficher).map((x) => (
                <tr key={x.id}>
                  <td data-libelle="Document">
                    <Lien className="atelier-document-lien" href={"/app/atelier/" + x.id}>
                      <IconeFormat format={x.format} />
                      {x.nom}
                    </Lien>
                  </td>
                  <td data-libelle="Format">{FORMATS[x.format]}</td>
                  <td data-libelle="Espace">{LIBELLES_SEGMENTS[x.segment as Segment]}</td>
                  <td data-libelle="Dernière modification">{new Date(x.updatedAt).toLocaleString("fr-FR")}</td>
                  <td data-libelle="Version">{x.revision}</td>
                  <td data-libelle="Actions">
                    {ecrire && (
                      <Bouton
                        onClick={async () => {
                          try {
                            await api.archiverAtelier(x.id, !x.archive);
                            toast(x.archive ? "Document restauré" : "Document archivé");
                            d.recharger();
                          } catch (e) {
                            setErreur(e as ErreurApi);
                          }
                        }}
                      >
                        {x.archive ? "Restaurer" : "Archiver"}
                      </Bouton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.donnees.some(afficher) && <EtatVide icone={FileText} titre="Aucun document trouvé" />}
        </div>
      )}
      <Modale
        ouverte={nouveau !== null}
        titre={"Nouveau document " + (nouveau ? FORMATS[nouveau] : "")}
        onFermer={() => setNouveau(null)}
      >
        <form
          className="grille"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!nouveau) return;
            setEnvoi(true);
            setErreur(null);
            try {
              const doc = await api.creerAtelier(nouveau, nom, segment);
              location.assign("/app/atelier/" + doc.id);
            } catch (e) {
              setErreur(e as ErreurApi);
            } finally {
              setEnvoi(false);
            }
          }}
        >
          <ResumeErreurs erreur={erreur} />
          <ChampTexte libelle="Nom du fichier" requis value={nom} onChange={(e) => setNom(e.target.value)} />
          <ChampListe
            libelle="Espace du nouveau document"
            value={segment}
            onChange={(e) => setSegment(e.target.value as Segment)}
          >
            {segmentsDe(moi).map((s) => (
              <option key={s} value={s}>
                {LIBELLES_SEGMENTS[s]}
              </option>
            ))}
          </ChampListe>
          <div className="rangee">
            <Bouton onClick={() => setNouveau(null)}>Annuler</Bouton>
            <Bouton type="submit" variante="primaire" chargement={envoi}>
              Créer le document
            </Bouton>
          </div>
        </form>
      </Modale>
    </div>
  );
}
export function EditeurAtelier({ id }: { id: string }) {
  const d = useDonnees(() => api.documentAtelier(id), [id]);
  return d.etat === "ok" ? (
    <BureauCraft key={id} initial={d.donnees.document} inspection={d.donnees.inspection} />
  ) : d.etat === "erreur" ? (
    <div className="page">
      <EtatErreur message={d.erreur} onReessayer={d.recharger} />
    </div>
  ) : (
    <EtatChargement />
  );
}

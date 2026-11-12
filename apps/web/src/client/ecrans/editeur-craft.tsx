import { useCallback, useEffect, useRef, useState } from "react";
import { api, ErreurApi, type DocumentAtelier, type ApercuAtelier } from "@auto/client";
import { LIBELLES_SEGMENTS, accesSegment, type Segment } from "@auto/tenancy/segments";
import {
  Bouton,
  Bandeau,
  EtatChargement,
  EtatErreur,
  Lien,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
  naviguer,
} from "@auto/ui/react";
import { enBase64 } from "@auto/ui/format";
import { ArrowLeft, FileDown, FileInput, FileOutput } from "@auto/ui/symboles";
import { useSession, peut } from "../session";
import { messageCraft, FORMATS_CRAFT as FORMATS } from "../craft-bridge";
interface Manifeste {
  version: string;
  editeurs: Record<string, unknown>;
}
interface Candidat {
  nom: string;
  octets: Uint8Array<ArrayBuffer>;
  sequence: number;
}
function telecharger(c: Candidat) {
  const url = URL.createObjectURL(new Blob([c.octets]));
  const a = document.createElement("a");
  a.href = url;
  a.download = c.nom;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function BureauCraft({ initial, inspection }: { initial: DocumentAtelier; inspection: ApercuAtelier }) {
  const { moi } = useSession(),
    toast = useToast();
  const ecrire = peut(moi.role, "ecrire") && !initial.archive;
  const [doc, setDoc] = useState(initial),
    [erreur, setErreur] = useState<ErreurApi | null>(null),
    [etat, setEtat] = useState("Chargement de l’éditeur…"),
    [pending, setPending] = useState(0),
    [plein, setPlein] = useState(false),
    [cycle, setCycle] = useState(0);
  const [extraction, setExtraction] = useState(false);
  useTitrePage(doc.nom);
  const frame = useRef<HTMLIFrameElement>(null),
    courant = useRef(doc),
    sale = useRef(false),
    nonSauve = useRef(false),
    attente = useRef(0),
    dernier = useRef<Candidat | null>(null),
    numero = useRef(0),
    file = useRef(Promise.resolve());
  const manifeste = useDonnees(async () => {
    const r = await fetch("/craft/manifest.json");
    if (!r.ok)
      throw new Error(
        "Les éditeurs Craft ne sont pas installés dans cette distribution. Le document et son historique restent accessibles.",
      );
    return r.json() as Promise<Manifeste>;
  });
  const versions = useDonnees(() => api.versionsAtelier(doc.id), [doc.id, doc.revision]);
  const studio = doc.format === "excel" ? "grid" : doc.format,
    prefixe = studio === "grid" ? "gridcraft" : studio === "word" ? "wordcraft" : "pdfcraft";
  const miseAJour = useCallback((d: DocumentAtelier) => {
    courant.current = d;
    setDoc(d);
  }, []);
  const mettreEnFile = useCallback(
    (c: Candidat, copie = false) => {
      dernier.current = c;
      nonSauve.current = true;
      setErreur(null);
      if (attente.current >= 3) {
        setErreur(
          new ErreurApi("Patientez avant de réessayer : vos dernières modifications restent disponibles.", 409),
        );
        return;
      }
      attente.current++;
      setPending(attente.current);
      file.current = file.current
        .catch(() => {})
        .then(async () => {
          try {
            const f = courant.current,
              extension = { word: ".docx", excel: ".xlsx", pdf: ".pdf" }[f.format];
            let suivant: DocumentAtelier;
            if (copie || !c.nom.toLowerCase().endsWith(extension) || c.nom !== f.nom) {
              suivant = await api.importerAtelier({ nom: c.nom, segment: f.segment, fichier: enBase64(c.octets) });
              if (c.nom.toLowerCase().endsWith(extension)) {
                miseAJour(suivant);
                history.replaceState(null, "", "/app/atelier/" + suivant.id);
              } else toast("Export enregistré dans les documents : " + suivant.nom);
            } else {
              suivant = await api.sauverAtelier(f.id, f.revision, enBase64(c.octets));
              miseAJour(suivant);
            }
            if (dernier.current === c) {
              dernier.current = null;
              nonSauve.current = false;
              setErreur(null);
              setEtat("Sauvegardé · version " + courant.current.revision);
            }
            toast(copie ? "Copie conservée" : "Document sauvegardé");
          } catch (e) {
            nonSauve.current = true;
            setErreur(e instanceof ErreurApi ? e : new ErreurApi((e as Error).message, 422));
            setEtat("Modifications à conserver");
          } finally {
            attente.current--;
            setPending(attente.current);
          }
        });
    },
    [miseAJour, toast],
  );
  useEffect(() => {
    const prevenir = (e: BeforeUnloadEvent) => {
      if (sale.current || nonSauve.current || attente.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevenir);
    const navigation = (e: Event) => {
      if (
        (sale.current || nonSauve.current || attente.current) &&
        !window.confirm("Des modifications ne sont pas encore sauvegardées. Quitter ce document ?")
      )
        e.preventDefault();
    };
    window.addEventListener("auto:avant-navigation", navigation);
    return () => {
      window.removeEventListener("beforeunload", prevenir);
      window.removeEventListener("auto:avant-navigation", navigation);
    };
  }, []);
  useEffect(() => {
    let actif = true,
      ouvert = false;
    const recevoir = async (e: MessageEvent) => {
      const m = messageCraft(e, frame.current?.contentWindow ?? null, prefixe, location.origin);
      if (!m) return;
      if (m.type === "pret" && !ouvert) {
        ouvert = true;
        setEtat("Ouverture du document…");
        try {
          const f = courant.current;
          const r = await fetch(api.url(`/v1/atelier/${f.id}/fichier`));
          if (!r.ok) throw new ErreurApi("Document inaccessible", r.status);
          const bytes = await r.arrayBuffer();
          if (actif) {
            frame.current?.contentWindow?.postMessage(
              { type: prefixe + ":open", name: f.nom, bytes },
              location.origin,
              [bytes],
            );
            setEtat("Prêt à travailler");
          }
        } catch (err) {
          if (actif) setErreur(err as ErreurApi);
        }
      } else if (m.type === "sale") {
        sale.current = m.sale;
        if (m.sale) setEtat("Modifications non sauvegardées");
      } else if (m.type === "erreur") {
        nonSauve.current = true;
        setErreur(new ErreurApi(m.message, 422));
      } else if (m.type === "sauver" && ecrire) {
        const c = { nom: m.nom, octets: m.octets, sequence: ++numero.current };
        if (!/\.(docx|xlsx|pdf)$/i.test(c.nom)) {
          telecharger(c);
          if (sale.current) nonSauve.current = true;
          setEtat("Export téléchargé. Enregistrez au format du document pour le conserver dans auto.");
          return;
        }
        mettreEnFile(c);
      }
    };
    window.addEventListener("message", recevoir);
    return () => {
      actif = false;
      window.removeEventListener("message", recevoir);
    };
  }, [prefixe, ecrire, cycle, mettreEnFile]);
  return (
    <div className={"page pile atelier-bureau" + (plein ? " atelier-plein" : "")}>
      <div className="page-entete">
        <div>
          <Lien className="atelier-document-lien" href="/app/atelier">
            <ArrowLeft className="icone" aria-hidden="true" /> Tous les documents
          </Lien>
          <h1>{doc.nom}</h1>
          <p className="attenue">
            {FORMATS[doc.format]} · {LIBELLES_SEGMENTS[doc.segment as Segment]} · version {doc.revision}
          </p>
        </div>
        <div className="rangee">
          {ecrire && doc.format !== "excel" && accesSegment(moi, "fournisseurs") && (
            <Bouton
              chargement={extraction}
              icone={FileInput}
              disabled={pending > 0 || sale.current || nonSauve.current}
              onClick={async () => {
                setExtraction(true);
                setErreur(null);
                try {
                  const r = await api.extraireDevisAtelier(doc.id, doc.revision);
                  toast(
                    r.devis.anomalies.length
                      ? "Extraction terminée : informations à vérifier"
                      : "Devis extrait depuis la version sauvegardée",
                  );
                  naviguer("/app/devis-recus");
                } catch (e) {
                  setErreur(e instanceof ErreurApi ? e : new ErreurApi((e as Error).message, 422));
                } finally {
                  setExtraction(false);
                }
              }}
            >
              Extraire ce devis
            </Bouton>
          )}
          <a className="bouton" href={api.url(`/v1/atelier/${doc.id}/fichier`)} download>
            <FileDown className="icone" aria-hidden="true" />
            Télécharger l’original
          </a>
          {doc.format === "word" && (
            <a className="bouton" href={api.url(`/v1/atelier/${doc.id}/export.pdf`)} download>
              <FileOutput className="icone" aria-hidden="true" />
              Exporter en PDF
            </a>
          )}
          {ecrire && (
            <Bouton aria-pressed={plein} onClick={() => setPlein(!plein)}>
              {plein ? "Réduire l’éditeur" : "Agrandir l’éditeur"}
            </Bouton>
          )}
        </div>
      </div>
      <ResumeErreurs erreur={erreur} />
      {erreur && dernier.current && (
        <Bandeau ton="avertissement" titre="Vos modifications restent disponibles">
          <p>Une sauvegarde refusée ne remplace jamais une version plus récente.</p>
          <div className="rangee">
            <Bouton
              disabled={pending > 0}
              onClick={() => {
                if (dernier.current) mettreEnFile(dernier.current);
              }}
            >
              Réessayer la sauvegarde
            </Bouton>
            <Bouton
              disabled={pending > 0}
              onClick={() => {
                if (dernier.current) mettreEnFile(dernier.current, true);
              }}
            >
              Conserver dans une nouvelle copie
            </Bouton>
            <Bouton
              onClick={() => {
                if (dernier.current) telecharger(dernier.current);
              }}
            >
              Télécharger mes modifications
            </Bouton>
          </div>
        </Bandeau>
      )}
      {!ecrire ? (
        <>
          <Bandeau titre={doc.archive ? "Document archivé" : "Consultation seule"}>
            <p>
              {doc.archive
                ? "Restaurez le document depuis la liste pour le modifier."
                : "Votre rôle permet de consulter et télécharger ce document."}
            </p>
          </Bandeau>
          <Apercu inspection={inspection} />
        </>
      ) : manifeste.etat === "erreur" ? (
        <EtatErreur message={manifeste.erreur} onReessayer={manifeste.recharger} />
      ) : manifeste.etat === "chargement" ? (
        <EtatChargement />
      ) : (
        <>
          <p className="aide" role="status" aria-live="polite">
            {pending ? "Sauvegarde en cours…" : etat} · Utilisez Enregistrer dans l’éditeur pour conserver une version.
          </p>
          <iframe
            key={cycle}
            ref={frame}
            title={"Éditeur " + FORMATS[doc.format] + " — " + doc.nom}
            className="atelier-frame"
            src={`/craft/${studio}/${manifeste.donnees.version}/index.html?host=parent&author=${encodeURIComponent(moi.nom ?? "")}`}
            sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"
            onLoad={() => frame.current?.contentWindow?.postMessage({ type: prefixe + ":ping" }, location.origin)}
          />
        </>
      )}
      <details className="carte">
        <summary>Historique des versions</summary>
        {versions.etat === "ok" ? (
          <ul className="atelier-versions">
            {versions.donnees.map((v) => (
              <li key={v.revision}>
                <span>
                  Version {v.revision} · {new Date(v.createdAt).toLocaleString("fr-FR")}
                </span>
                <a href={api.url(`/v1/atelier/${doc.id}/fichier?revision=${v.revision}`)} download>
                  Télécharger la version {v.revision}
                </a>
                {ecrire && v.revision !== doc.revision && (
                  <Bouton
                    disabled={pending > 0 || sale.current || nonSauve.current}
                    onClick={async () => {
                      try {
                        miseAJour(await api.restaurerAtelier(doc.id, doc.revision, v.revision));
                        setCycle((n) => n + 1);
                        toast("Version restaurée dans une nouvelle révision");
                      } catch (e) {
                        setErreur(e as ErreurApi);
                      }
                    }}
                  >
                    Restaurer la version {v.revision}
                  </Bouton>
                )}
              </li>
            ))}
          </ul>
        ) : versions.etat === "erreur" ? (
          <EtatErreur message={versions.erreur} onReessayer={versions.recharger} />
        ) : (
          <EtatChargement />
        )}
      </details>
    </div>
  );
}
function Apercu({ inspection }: { inspection: ApercuAtelier }) {
  return (
    <section className="carte pile">
      <h2>Aperçu du document</h2>
      {inspection.extrait && <p className="texte-extrait">{inspection.extrait}</p>}
      {inspection.feuilles?.map((f) => (
        <div key={f.nom}>
          <h3>{f.nom}</h3>
          <p className="aide">Aperçu des 20 premières lignes.</p>
          <div className="tableau-conteneur">
            <table className="tableau">
              <tbody>
                {f.apercu.map((l, i) => (
                  <tr key={i}>
                    {l.map((v, j) => (
                      <td key={j}>{v === null ? "" : String(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {inspection.pages && <p>{inspection.pages} page(s).</p>}
    </section>
  );
}

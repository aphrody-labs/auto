// Import guidé : fichier → aperçu et correspondance des colonnes proposée par l'API → import → bilan par ligne.
import { FileInput, FileSpreadsheet, Upload } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi, type Apercu, type ResultatImport } from "@auto/client";
import { enBase64, nombre, pluriel } from "@auto/ui/format";
import { Bandeau, Bouton, ChampListe, ChampTexte, ResumeErreurs, useTitrePage, useToast } from "@auto/ui/react";

type Cible = "clients" | "produits";

const CHAMPS: Record<Cible, { cle: string; libelle: string; requis?: boolean }[]> = {
  clients: [
    { cle: "nom", libelle: "Nom", requis: true },
    { cle: "adresse", libelle: "Adresse", requis: true },
    { cle: "siret", libelle: "SIRET" },
    { cle: "tvaIntracom", libelle: "TVA intracommunautaire" },
    { cle: "email", libelle: "E-mail" },
  ],
  produits: [
    { cle: "designation", libelle: "Désignation", requis: true },
    { cle: "prixHt", libelle: "Prix HT", requis: true },
    { cle: "tva", libelle: "Taux de TVA" },
    { cle: "unite", libelle: "Unité" },
  ],
};

const MAX_OCTETS = 10 * 1024 * 1024;

export function Imports() {
  useTitrePage("Imports");
  const toast = useToast();
  const [cible, setCible] = useState<Cible>("clients");
  const [fichier, setFichier] = useState<{ nom: string; base64: string } | null>(null);
  const [entete, setEntete] = useState("1");
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [corr, setCorr] = useState<Record<string, number>>({});
  const [resultat, setResultat] = useState<ResultatImport | null>(null);
  const [errFichier, setErrFichier] = useState<string | null>(null);
  const [errCorr, setErrCorr] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState<"" | "apercu" | "import">("");

  const ligneEntete = Math.max(0, (Number(entete) || 1) - 1);

  async function choisir(f: File | undefined) {
    setApercu(null);
    setResultat(null);
    setErreur(null);
    if (!f) return setFichier(null);
    if (f.size > MAX_OCTETS) {
      setErrFichier("Fichier trop volumineux : 10 Mo au plus.");
      return setFichier(null);
    }
    setErrFichier(null);
    setFichier({ nom: f.name, base64: enBase64(new Uint8Array(await f.arrayBuffer())) });
  }

  async function lireApercu(e: FormEvent) {
    e.preventDefault();
    if (!fichier) return setErrFichier("Choisissez un fichier xlsx, xls, ods ou csv.");
    setEnvoi("apercu");
    setErreur(null);
    setResultat(null);
    try {
      const a = await api.apercuImport(fichier.base64, ligneEntete);
      setApercu(a);
      setCorr({ ...(a.correspondance[cible] as Record<string, number>) });
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi("");
    }
  }

  async function importer() {
    if (!fichier || !apercu) return;
    const manquants = CHAMPS[cible].filter((c) => c.requis && corr[c.cle] === undefined).map((c) => c.libelle);
    if (manquants.length) return setErrCorr(`Associez une colonne à : ${manquants.join(", ")}.`);
    setErrCorr(null);
    setEnvoi("import");
    setErreur(null);
    try {
      const r = await api.importer(cible, fichier.base64, corr, ligneEntete);
      setResultat(r);
      toast(
        `${pluriel(r.crees, cible === "clients" ? "client importé" : "produit importé", cible === "clients" ? "clients importés" : "produits importés")}`,
      );
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi("");
    }
  }

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Imports</h1>
      </div>
      <ResumeErreurs erreur={erreur} />

      <form className="carte grille" noValidate onSubmit={lireApercu} aria-labelledby="sec-fichier">
        <h2 id="sec-fichier">1. Fichier</h2>
        <div className="grille grille-3">
          <ChampListe
            libelle="Importer des"
            value={cible}
            onChange={(e) => {
              const c = e.target.value as Cible;
              setCible(c);
              setResultat(null);
              if (apercu) setCorr({ ...(apercu.correspondance[c] as Record<string, number>) });
            }}
          >
            <option value="clients">Clients</option>
            <option value="produits">Produits</option>
          </ChampListe>
          <div className="champ">
            <label htmlFor="fichier-import">Tableur</label>
            <input
              id="fichier-import"
              className="controle"
              type="file"
              accept=".xlsx,.xls,.xlsb,.ods,.csv"
              aria-describedby={errFichier ? "fichier-aide fichier-erreur" : "fichier-aide"}
              aria-invalid={errFichier ? true : undefined}
              onChange={(e) => void choisir(e.target.files?.[0])}
            />
            <span id="fichier-aide" className="aide">
              xlsx, xls, xlsb, ods ou csv, 10 Mo au plus.
            </span>
            {errFichier && (
              <span id="fichier-erreur" className="erreur-champ">
                {errFichier}
              </span>
            )}
          </div>
          <ChampTexte
            libelle="Ligne d'en-tête"
            inputMode="numeric"
            aide="Numéro de la ligne qui porte les titres de colonnes."
            value={entete}
            onChange={(e) => setEntete(e.target.value)}
          />
        </div>
        <div>
          <Bouton type="submit" icone={FileSpreadsheet} chargement={envoi === "apercu"}>
            Lire l'aperçu
          </Bouton>
        </div>
      </form>

      {apercu && (
        <section className="carte pile-serree" aria-labelledby="sec-corr">
          <h2 id="sec-corr">2. Correspondance des colonnes</h2>
          <p className="attenue">
            Feuille « {apercu.nomFeuille} », format {apercu.format}, {nombre(apercu.lignes)} lignes de données. Les
            colonnes reconnues sont déjà associées.
          </p>
          {apercu.avertissements.length > 0 && (
            <Bandeau ton="avertissement" titre="Avertissements de lecture">
              <ul>
                {apercu.avertissements.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Bandeau>
          )}
          <div className="grille grille-3">
            {CHAMPS[cible].map((c) => (
              <ChampListe
                key={c.cle}
                libelle={c.libelle}
                requis={c.requis}
                value={corr[c.cle] ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = { ...corr };
                  if (v === "") delete n[c.cle];
                  else n[c.cle] = Number(v);
                  setCorr(n);
                }}
              >
                <option value="">Ne pas importer</option>
                {apercu.entete.map((t, i) => (
                  <option key={i} value={i}>
                    {String(t ?? `Colonne ${i + 1}`)}
                  </option>
                ))}
              </ChampListe>
            ))}
          </div>
          {errCorr && (
            <p className="erreur-champ" role="alert">
              {errCorr}
            </p>
          )}
          <div className="tableau-conteneur">
            <table className="tableau">
              <caption className="visuellement-cache">Aperçu des 10 premières lignes</caption>
              <thead>
                <tr>
                  {apercu.entete.map((t, i) => (
                    <th key={i} scope="col">
                      {String(t ?? `Colonne ${i + 1}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {apercu.apercu.map((l, i) => (
                  <tr key={i}>
                    {apercu.entete.map((t, j) => (
                      <td key={j} data-libelle={String(t ?? `Colonne ${j + 1}`)}>
                        {String(l[j] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <Bouton variante="primaire" icone={Upload} chargement={envoi === "import"} onClick={importer}>
              Importer {nombre(apercu.lignes)} lignes
            </Bouton>
          </div>
        </section>
      )}

      {resultat && (
        <section className="carte pile-serree" aria-labelledby="sec-bilan" aria-live="polite">
          <h2 id="sec-bilan">3. Bilan</h2>
          <Bandeau
            ton={resultat.erreurs.length ? "avertissement" : "succes"}
            titre={`${pluriel(resultat.crees, "créé")}, ${pluriel(resultat.ignores, "ignoré")} (déjà présents)`}
          >
            {resultat.erreurs.length > 0 && <p>{nombre(resultat.erreurs.length)} lignes en erreur, non importées :</p>}
          </Bandeau>
          {resultat.erreurs.length > 0 && (
            <ul>
              {resultat.erreurs.map((e) => (
                <li key={e.ligne}>
                  Ligne {e.ligne} : {e.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!apercu && !resultat && (
        <Bandeau titre="Comment ça marche">
          <p>
            <FileInput className="icone icone-sm" aria-hidden="true" /> Choisissez un tableur, vérifiez l'aperçu et les
            colonnes proposées, puis importez. Une ligne invalide est signalée sans bloquer les autres ; un SIRET déjà
            présent est ignoré.
          </p>
        </Bandeau>
      )}
    </div>
  );
}

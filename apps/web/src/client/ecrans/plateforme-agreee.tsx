import { useState, type FormEvent } from "react";
import { api, ErreurApi } from "@auto/client";
import {
  Bandeau,
  Bouton,
  ChampTexte,
  EtatChargement,
  EtatErreur,
  ResumeErreurs,
  useDonnees,
  useToast,
} from "@auto/ui/react";

/** Paramétrage d'un compte existant ; il ne crée pas de mandat auprès de la plateforme. */
export function PlateformeAgreee({ modifiable }: { modifiable: boolean }) {
  const connexion = useDonnees(() => api.connexionPa());
  const toast = useToast();
  const [valeurs, setValeurs] = useState({
    compte: "",
    cleApi: "",
    secretWebhook: "",
    signataire: "",
    qualite: "",
    date: "",
  });
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [mandatExistant, setMandatExistant] = useState(false);
  const [perimetre, setPerimetre] = useState<("emission" | "reception")[]>(["emission", "reception"]);
  if (connexion.etat === "chargement") return <EtatChargement lignes={2} />;
  if (connexion.etat === "erreur") return <EtatErreur message={connexion.erreur} onReessayer={connexion.recharger} />;
  const active = connexion.donnees;
  async function connecter(e: FormEvent) {
    e.preventDefault();
    if (!mandatExistant || perimetre.length === 0 || Object.values(valeurs).some((v) => !v.trim())) return;
    setEnvoi(true);
    setErreur(null);
    try {
      await api.connecterPa({
        plateforme: "b2brouter",
        identifiants: {
          compte: valeurs.compte.trim(),
          cleApi: valeurs.cleApi.trim(),
          secretWebhook: valeurs.secretWebhook.trim(),
        },
        mandat: {
          signataire: valeurs.signataire.trim(),
          qualite: valeurs.qualite.trim(),
          date: valeurs.date,
          perimetre,
        },
      });
      setValeurs({ compte: "", cleApi: "", secretWebhook: "", signataire: "", qualite: "", date: "" });
      setMandatExistant(false);
      connexion.recharger();
      toast("Configuration enregistrée");
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  async function deconnecter() {
    if (!window.confirm("Déconnecter cette plateforme ? Les données de dépôt déjà enregistrées seront conservées."))
      return;
    setEnvoi(true);
    setErreur(null);
    try {
      await api.deconnecterPa();
      connexion.recharger();
      toast("Plateforme déconnectée");
    } catch (e) {
      setErreur(e as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <div className="grille">
      <Bandeau ton="avertissement" titre="Connexion en cours de qualification">
        <p>
          Le raccordement B2Brouter doit être testé avec votre plateforme avant utilisation réelle. Auto ne crée pas le
          mandat auprès de B2Brouter. L'e-reporting n'est pas encore pris en charge : ne le choisissez pas dans un
          mandat destiné à Auto.
        </p>
      </Bandeau>
      <ResumeErreurs erreur={erreur} />
      {active ? (
        <>
          <p>
            Configuration enregistrée : <strong>{active.plateforme}</strong>. Référence interne :{" "}
            {active.mandatReference}.
          </p>
          <p>
            Adresse de webhook à configurer auprès de la plateforme :{" "}
            <code>{new URL(active.webhook, window.location.origin).href}</code>
          </p>
          {modifiable && (
            <Bouton onClick={deconnecter} chargement={envoi}>
              Déconnecter
            </Bouton>
          )}
        </>
      ) : modifiable ? (
        <form className="grille" onSubmit={connecter}>
          <p>Renseignez les identifiants de votre compte B2Brouter et les informations du mandat déjà établi.</p>
          <ChampTexte
            libelle="Compte B2Brouter"
            requis
            value={valeurs.compte}
            onChange={(e) => setValeurs({ ...valeurs, compte: e.target.value })}
          />
          <ChampTexte
            libelle="Clé API"
            type="password"
            autoComplete="off"
            requis
            value={valeurs.cleApi}
            onChange={(e) => setValeurs({ ...valeurs, cleApi: e.target.value })}
          />
          <ChampTexte
            libelle="Secret du webhook"
            type="password"
            autoComplete="off"
            requis
            value={valeurs.secretWebhook}
            onChange={(e) => setValeurs({ ...valeurs, secretWebhook: e.target.value })}
          />
          <ChampTexte
            libelle="Signataire du mandat"
            requis
            value={valeurs.signataire}
            onChange={(e) => setValeurs({ ...valeurs, signataire: e.target.value })}
          />
          <ChampTexte
            libelle="Qualité du signataire"
            requis
            value={valeurs.qualite}
            onChange={(e) => setValeurs({ ...valeurs, qualite: e.target.value })}
          />
          <ChampTexte
            libelle="Date du mandat"
            type="date"
            requis
            value={valeurs.date}
            onChange={(e) => setValeurs({ ...valeurs, date: e.target.value })}
          />
          <fieldset className="grille">
            <legend>Périmètre déjà autorisé dans le mandat B2Brouter</legend>
            {(["emission", "reception"] as const).map((portee) => (
              <label className="case" key={portee}>
                <input
                  type="checkbox"
                  checked={perimetre.includes(portee)}
                  onChange={(e) => {
                    setMandatExistant(false);
                    setPerimetre((avant) =>
                      e.target.checked ? [...avant, portee] : avant.filter((p) => p !== portee),
                    );
                  }}
                />
                {portee === "emission" ? "Émission de factures" : "Réception de factures"}
              </label>
            ))}
            <label className="case">
              <input type="checkbox" disabled aria-describedby="pa-ereporting-indisponible" /> E-reporting
            </label>
            <p id="pa-ereporting-indisponible">Indisponible tant que le format de déclaration n'est pas qualifié.</p>
          </fieldset>
          <label className="case">
            <input type="checkbox" checked={mandatExistant} onChange={(e) => setMandatExistant(e.target.checked)} />
            Un mandat couvrant les périmètres sélectionnés a été établi auprès de la plateforme.
          </label>
          <Bouton
            type="submit"
            variante="primaire"
            chargement={envoi}
            disabled={!mandatExistant || perimetre.length === 0 || Object.values(valeurs).some((v) => !v.trim())}
          >
            Enregistrer la configuration
          </Bouton>
        </form>
      ) : (
        <p>Aucune plateforme configurée. Un administrateur peut la connecter.</p>
      )}
    </div>
  );
}

import type { StatutVisuel } from "@auto/ui";
import { Inbox } from "@auto/ui/symboles";
import { useState } from "react";
import { api, ErreurApi, type Recue } from "@auto/client";
import { dateFr, eur } from "@auto/ui/format";
import { peut, useSession } from "../session";
import { ClasserAchat } from "./affectations";
import {
  BadgeStatut,
  Bouton,
  EtatChargement,
  EtatErreur,
  EtatVide,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";

type Filtre = Recue["statut"] | "toutes";
const FILTRES: Filtre[] = ["a_verifier", "validee", "rejetee", "toutes"];
const LIBELLE_FILTRE: Record<Filtre, string> = {
  a_verifier: "À vérifier",
  validee: "Validées",
  rejetee: "Rejetées",
  toutes: "Toutes",
};
const STATUT: Record<Recue["statut"], { visuel: StatutVisuel; libelle: string }> = {
  a_verifier: { visuel: "envoye", libelle: "À vérifier" },
  validee: { visuel: "accepte", libelle: "Validée" },
  rejetee: { visuel: "refuse", libelle: "Rejetée" },
};
const CANAL: Record<Recue["canal"], string> = {
  api: "Extension",
  mail: "E-mail",
  pa: "Plateforme",
};

/** Factures fournisseurs reçues (extension Chrome, e-mail, plateforme) : vérification puis validation ou rejet. */
export function FacturesRecues() {
  useTitrePage("Factures reçues");
  const { moi } = useSession();
  const toast = useToast();
  const [filtre, setFiltre] = useState<Filtre>("a_verifier");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [classement, setClassement] = useState<string | null>(null);
  const ecrire = peut(moi.role, "ecrire");
  const d = useDonnees(() => api.recues(filtre === "toutes" ? undefined : filtre), [filtre]);

  async function decider(r: Recue, statut: "validee" | "rejetee") {
    setErreur(null);
    try {
      await api.deciderRecue(r.id, statut);
      toast(`Facture ${r.numero ?? ""} ${statut === "validee" ? "validée" : "rejetée"}`.replace("  ", " "));
      d.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    }
  }

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (d.donnees.length === 0)
    corps = (
      <EtatVide icone={Inbox} titre={filtre === "a_verifier" ? "Aucune facture à vérifier" : "Aucune facture reçue"}>
        <p>
          Envoyez une facture fournisseur depuis l'extension Chrome (clic droit sur le lien) ou transférez-la à votre
          boîte connectée.
        </p>
      </EtatVide>
    );
  else
    corps = (
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead>
            <tr>
              <th scope="col">Fournisseur</th>
              <th scope="col">Numéro</th>
              <th scope="col">Date</th>
              <th scope="col">Échéance</th>
              <th scope="col" className="num">
                TTC
              </th>
              <th scope="col">Reçue par</th>
              <th scope="col">Statut</th>
              <th scope="col">
                <span className="visuellement-cache">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {d.donnees.map((r) => (
              <tr key={r.id}>
                <td data-libelle="Fournisseur" className="col-texte">
                  {r.fournisseur ?? "Fournisseur non lu"}
                  {r.anomalies.length > 0 && (
                    <span className="aide">
                      <br />
                      {r.anomalies.length === 1 ? "1 anomalie" : `${r.anomalies.length} anomalies`} :{" "}
                      {r.anomalies.join(", ")}
                    </span>
                  )}
                </td>
                <td data-libelle="Numéro" className="chiffres">
                  <a href={api.urlFichierRecu(r.id)} target="_blank" rel="noopener">
                    {r.numero ?? "Ouvrir le fichier"}
                  </a>
                </td>
                <td data-libelle="Date" className="num">
                  {dateFr(r.date) || "—"}
                </td>
                <td data-libelle="Échéance" className="num">
                  {dateFr(r.echeance) || "—"}
                </td>
                <td data-libelle="TTC" className="num">
                  {r.ttcCents === null ? "—" : eur(r.ttcCents)}
                </td>
                <td data-libelle="Reçue par">{CANAL[r.canal]}</td>
                <td data-libelle="Statut">
                  <BadgeStatut statut={STATUT[r.statut].visuel} libelle={STATUT[r.statut].libelle} />
                </td>
                <td data-libelle="Actions">
                  {ecrire && <Bouton onClick={() => setClassement(r.id)}>Classer</Bouton>}
                  {ecrire && r.statut === "a_verifier" && (
                    <div className="rangee actions-ligne">
                      <Bouton variante="primaire" onClick={() => decider(r, "validee")}>
                        Valider
                      </Bouton>
                      <Bouton onClick={() => decider(r, "rejetee")}>Rejeter</Bouton>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Factures reçues</h1>
      </div>
      <ResumeErreurs erreur={erreur} />
      <div className="onglets" role="group" aria-label="Filtrer par statut">
        {FILTRES.map((f) => (
          <button key={f} type="button" className="onglet" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>
            {LIBELLE_FILTRE[f]}
          </button>
        ))}
      </div>
      {corps}
      {classement && (
        <ClasserAchat
          id={classement}
          onFin={() => {
            setClassement(null);
            d.recharger();
          }}
        />
      )}
    </div>
  );
}

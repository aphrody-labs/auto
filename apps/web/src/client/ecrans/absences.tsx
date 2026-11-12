import { CalendarDays } from "@auto/ui/symboles";
import { useState } from "react";
import { api, ErreurApi, type Absence } from "@auto/client";
import { LIBELLE_STATUT_ABSENCE } from "@auto/ui/format";
import { peut, useSession } from "../session";
import {
  Bandeau,
  EtatChargement,
  EtatErreur,
  EtatVide,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";
import { TableauAbsences } from "./employes";

type Filtre = Absence["statut"] | "toutes";
const FILTRES: Filtre[] = ["demandee", "validee", "refusee", "annulee", "toutes"];

export function Absences() {
  useTitrePage("Absences");
  const { moi } = useSession();
  const toast = useToast();
  const [filtre, setFiltre] = useState<Filtre>("demandee");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const rh = peut(moi.role, "rh");
  const d = useDonnees(async () => {
    if (!rh) return { absences: [], noms: {} };
    const [absences, employes] = await Promise.all([
      api.absences(filtre === "toutes" ? undefined : filtre),
      api.employes(true),
    ]);
    return { absences, noms: Object.fromEntries(employes.map((e) => [e.id, `${e.prenom} ${e.nom}`])) };
  }, [filtre]);

  if (!rh)
    return (
      <div className="page">
        <h1>Absences</h1>
        <Bandeau ton="avertissement" titre="Accès réservé">
          <p>La validation des absences est réservée aux propriétaires et administrateurs.</p>
        </Bandeau>
      </div>
    );

  async function decider(id: string, statut: "validee" | "refusee" | "annulee") {
    setErreur(null);
    try {
      await api.deciderAbsence(id, statut);
      toast(`Absence ${LIBELLE_STATUT_ABSENCE[statut]!.toLowerCase()}`);
      d.recharger();
    } catch (x) {
      setErreur(x as ErreurApi);
    }
  }

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (d.donnees.absences.length === 0)
    corps = (
      <EtatVide icone={CalendarDays} titre={filtre === "demandee" ? "Aucune demande en attente" : "Aucune absence"}>
        <p>Les demandes se font depuis la fiche de chaque employé.</p>
      </EtatVide>
    );
  else corps = <TableauAbsences absences={d.donnees.absences} noms={d.donnees.noms} decider={decider} />;

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Absences</h1>
      </div>
      <ResumeErreurs erreur={erreur} />
      <div className="onglets" role="group" aria-label="Filtrer par statut">
        {FILTRES.map((f) => (
          <button key={f} type="button" className="onglet" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>
            {f === "toutes" ? "Toutes" : f === "demandee" ? "À valider" : `${LIBELLE_STATUT_ABSENCE[f]}s`}
          </button>
        ))}
      </div>
      {corps}
    </div>
  );
}

import { CONTRATS, TYPES_ABSENCE, type Contrat, type Employe, type TypeAbsence } from "@auto/domain";
import { CalendarPlus, UserPlus, UserRound } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi, type FicheEmploye } from "@auto/client";
import {
  aujourdhui,
  dateFr,
  emailValide,
  eur,
  jours,
  LIBELLE_ABSENCE,
  LIBELLE_CONTRAT,
  LIBELLE_STATUT_ABSENCE,
  nombre,
  versCentimes,
} from "@auto/ui/format";
import { peut, useSession } from "../session";
import {
  Bandeau,
  Bouton,
  ChampListe,
  ChampTexte,
  ChampZone,
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

function FormulaireEmploye({ onFin }: { onFin: (ok: boolean) => void }) {
  const toast = useToast();
  const [e, setE] = useState({
    prenom: "",
    nom: "",
    email: "",
    poste: "",
    contrat: "cdi" as Contrat,
    dateEntree: aujourdhui(),
    tempsTravail: "100",
    salaire: "",
  });
  const [err, setErr] = useState<Record<string, string | undefined>>({});
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(ev: FormEvent) {
    ev.preventDefault();
    const salaire = versCentimes(e.salaire);
    const temps = Number(e.tempsTravail);
    const x = {
      prenom: e.prenom.trim() ? undefined : "Prénom obligatoire.",
      nom: e.nom.trim() ? undefined : "Nom obligatoire.",
      poste: e.poste.trim() ? undefined : "Poste obligatoire.",
      email: !e.email || emailValide(e.email) ? undefined : "Adresse e-mail invalide.",
      tempsTravail: temps > 0 && temps <= 100 ? undefined : "Entre 1 et 100 %.",
      salaire: salaire === null ? "Montant en euros, par exemple 2 100." : undefined,
    };
    setErr(x);
    if (Object.values(x).some(Boolean)) return;
    setEnvoi(true);
    setErreur(null);
    const corps: Employe = {
      prenom: e.prenom.trim(),
      nom: e.nom.trim(),
      poste: e.poste.trim(),
      contrat: e.contrat,
      dateEntree: e.dateEntree,
      tempsTravail: temps,
      salaireBrutMensuelCents: salaire!,
      ...(e.email.trim() ? { email: e.email.trim() } : {}),
    };
    try {
      await api.creerEmploye(corps);
      toast("Employé ajouté");
      onFin(true);
    } catch (y) {
      setErreur(y as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  const champ = (k: keyof typeof e) => ({
    value: e[k],
    erreur: err[k],
    onChange: (x: { target: { value: string } }) => setE({ ...e, [k]: x.target.value }),
  });

  return (
    <form className="grille" noValidate onSubmit={soumettre}>
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-2">
        <ChampTexte libelle="Prénom" requis autoComplete="off" {...champ("prenom")} />
        <ChampTexte libelle="Nom" requis autoComplete="off" {...champ("nom")} />
        <ChampTexte libelle="Poste" requis {...champ("poste")} />
        <ChampTexte libelle="E-mail" type="email" {...champ("email")} />
        <ChampListe
          libelle="Contrat"
          value={e.contrat}
          onChange={(x) => setE({ ...e, contrat: x.target.value as Contrat })}
        >
          {CONTRATS.map((c) => (
            <option key={c} value={c}>
              {LIBELLE_CONTRAT[c]}
            </option>
          ))}
        </ChampListe>
        <ChampTexte libelle="Date d'entrée" type="date" requis {...champ("dateEntree")} />
        <ChampTexte libelle="Temps de travail (%)" inputMode="numeric" {...champ("tempsTravail")} />
        <ChampTexte libelle="Salaire brut mensuel (€)" inputMode="decimal" requis {...champ("salaire")} />
      </div>
      <div className="rangee">
        <span className="espace" />
        <Bouton onClick={() => onFin(false)}>Annuler</Bouton>
        <Bouton type="submit" variante="primaire" chargement={envoi}>
          Enregistrer
        </Bouton>
      </div>
    </form>
  );
}

function ListeEmployes() {
  useTitrePage("Employés");
  const [tous, setTous] = useState(false);
  const [ouvert, setOuvert] = useState(false);
  const d = useDonnees(() => api.employes(tous), [tous]);

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (d.donnees.length === 0)
    corps = (
      <EtatVide icone={UserRound} titre="Aucun employé">
        <p>Ajoutez vos salariés pour suivre leurs absences et leurs congés payés.</p>
      </EtatVide>
    );
  else
    corps = (
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">Poste</th>
              <th scope="col">Contrat</th>
              <th scope="col">Entrée</th>
              <th scope="col" className="num">
                Temps
              </th>
            </tr>
          </thead>
          <tbody>
            {d.donnees.map((e) => (
              <tr key={e.id}>
                <td data-libelle="Nom">
                  <Lien href={`/app/employes/${e.id}`}>
                    {e.prenom} {e.nom}
                  </Lien>
                </td>
                <td data-libelle="Poste">{e.poste}</td>
                <td data-libelle="Contrat">{LIBELLE_CONTRAT[e.contrat]}</td>
                <td data-libelle="Entrée" className="num">
                  {dateFr(e.dateEntree)}
                </td>
                <td data-libelle="Temps" className="num">
                  {nombre(e.tempsTravail)} %
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
        <h1>Employés</h1>
        <Bouton variante="primaire" icone={UserPlus} onClick={() => setOuvert(true)}>
          Ajouter un employé
        </Bouton>
      </div>
      <label className="case">
        <input type="checkbox" checked={tous} onChange={(e) => setTous(e.target.checked)} />
        Inclure les employés sortis
      </label>
      {corps}
      <Modale ouverte={ouvert} titre="Ajouter un employé" onFermer={() => setOuvert(false)}>
        <FormulaireEmploye
          onFin={(ok) => {
            setOuvert(false);
            if (ok) d.recharger();
          }}
        />
      </Modale>
    </div>
  );
}

function DemandeAbsence({ employe, onFin }: { employe: FicheEmploye; onFin: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<TypeAbsence>("conges_payes");
  const [debut, setDebut] = useState(aujourdhui());
  const [fin, setFin] = useState(aujourdhui());
  const [motif, setMotif] = useState("");
  const [errFin, setErrFin] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (fin < debut) {
      setErrFin("La fin doit suivre le début.");
      return;
    }
    setErrFin(null);
    setEnvoi(true);
    setErreur(null);
    try {
      const a = await api.demanderAbsence(employe.id, {
        type,
        debut,
        fin,
        ...(motif.trim() ? { motif: motif.trim() } : {}),
      });
      toast(`Absence demandée : ${jours(a.joursOuvrables)} ouvrables`);
      onFin();
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <form className="carte grille" noValidate onSubmit={soumettre} aria-labelledby="sec-demande">
      <h2 id="sec-demande">Demander une absence</h2>
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-3">
        <ChampListe libelle="Type" value={type} onChange={(e) => setType(e.target.value as TypeAbsence)}>
          {TYPES_ABSENCE.map((t) => (
            <option key={t} value={t}>
              {LIBELLE_ABSENCE[t]}
            </option>
          ))}
        </ChampListe>
        <ChampTexte libelle="Du" type="date" requis value={debut} onChange={(e) => setDebut(e.target.value)} />
        <ChampTexte
          libelle="Au (inclus)"
          type="date"
          requis
          value={fin}
          erreur={errFin}
          onChange={(e) => setFin(e.target.value)}
        />
      </div>
      <ChampZone libelle="Motif" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} />
      <div>
        <Bouton type="submit" icone={CalendarPlus} chargement={envoi}>
          Envoyer la demande
        </Bouton>
      </div>
    </form>
  );
}

function FicheEmployeEcran({ id }: { id: string }) {
  const d = useDonnees(async () => {
    const [e, solde, absences] = await Promise.all([api.employe(id), api.conges(id), api.absencesEmploye(id)]);
    return { e, solde, absences };
  }, [id]);
  useTitrePage(d.etat === "ok" ? `${d.donnees.e.prenom} ${d.donnees.e.nom}` : "Employé");
  if (d.etat === "chargement")
    return (
      <div className="page">
        <EtatChargement />
      </div>
    );
  if (d.etat === "erreur")
    return (
      <div className="page">
        <h1>Employé</h1>
        <EtatErreur message={d.erreur} onReessayer={d.recharger} />
      </div>
    );
  const { e, solde, absences } = d.donnees;
  return (
    <div className="page">
      <p className="fil">
        <Lien href="/app/employes">Employés</Lien>
      </p>
      <div className="page-entete">
        <h1>
          {e.prenom} {e.nom}
        </h1>
      </div>
      <div className="grille grille-2">
        <section className="carte resume" aria-labelledby="sec-fiche">
          <h2 id="sec-fiche">Fiche</h2>
          <dl>
            <dt>Poste</dt>
            <dd>{e.poste}</dd>
            <dt>Contrat</dt>
            <dd>{LIBELLE_CONTRAT[e.contrat]}</dd>
            <dt>Entrée</dt>
            <dd className="chiffres">{dateFr(e.dateEntree)}</dd>
            {e.dateSortie && (
              <>
                <dt>Sortie</dt>
                <dd className="chiffres">{dateFr(e.dateSortie)}</dd>
              </>
            )}
            <dt>Temps de travail</dt>
            <dd className="chiffres">{nombre(e.tempsTravail)} %</dd>
            <dt>Salaire brut</dt>
            <dd className="chiffres">{eur(e.salaireBrutMensuelCents)} par mois</dd>
          </dl>
        </section>
        <section className="carte resume" aria-labelledby="sec-solde">
          <h2 id="sec-solde">Congés payés, période du {dateFr(solde.periode) || solde.periode}</h2>
          <p className="kpi-valeur">{jours(solde.disponible)} disponibles</p>
          <dl>
            <dt>Acquis</dt>
            <dd className="chiffres">{jours(solde.acquis)}</dd>
            <dt>Pris</dt>
            <dd className="chiffres">{jours(solde.pris)}</dd>
            <dt>En attente</dt>
            <dd className="chiffres">{jours(solde.demandes)}</dd>
          </dl>
          <p className="attenue petit">2,5 jours ouvrables par mois de travail effectif, 30 au plus par période.</p>
        </section>
      </div>
      <DemandeAbsence employe={e} onFin={d.recharger} />
      <section className="pile-serree" aria-labelledby="sec-absences">
        <h2 id="sec-absences">Absences</h2>
        {absences.length === 0 ? <p className="attenue">Aucune absence.</p> : <TableauAbsences absences={absences} />}
      </section>
    </div>
  );
}

export function TableauAbsences({
  absences,
  noms,
  decider,
}: {
  absences: import("@auto/client").Absence[];
  noms?: Record<string, string>;
  decider?: (id: string, statut: "validee" | "refusee" | "annulee") => void;
}) {
  return (
    <div className="tableau-conteneur">
      <table className="tableau">
        <thead>
          <tr>
            {noms && <th scope="col">Employé</th>}
            <th scope="col">Type</th>
            <th scope="col">Du</th>
            <th scope="col">Au</th>
            <th scope="col" className="num">
              Jours ouvrables
            </th>
            <th scope="col">Statut</th>
            {decider && (
              <th scope="col">
                <span className="visuellement-cache">Décision</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {absences.map((a) => (
            <tr key={a.id}>
              {noms && <td data-libelle="Employé">{noms[a.employeId] ?? "—"}</td>}
              <td data-libelle="Type">{LIBELLE_ABSENCE[a.type]}</td>
              <td data-libelle="Du" className="num">
                {dateFr(a.debut)}
              </td>
              <td data-libelle="Au" className="num">
                {dateFr(a.fin)}
              </td>
              <td data-libelle="Jours ouvrables" className="num">
                {nombre(a.joursOuvrables)}
              </td>
              <td data-libelle="Statut">{LIBELLE_STATUT_ABSENCE[a.statut]}</td>
              {decider && (
                <td data-libelle="Décision">
                  {a.statut === "demandee" ? (
                    <div className="rangee">
                      <Bouton variante="primaire" onClick={() => decider(a.id, "validee")}>
                        Valider
                      </Bouton>
                      <Bouton onClick={() => decider(a.id, "refusee")}>Refuser</Bouton>
                    </div>
                  ) : a.statut === "validee" ? (
                    <Bouton variante="fantome" onClick={() => decider(a.id, "annulee")}>
                      Annuler
                    </Bouton>
                  ) : null}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Employes({ id }: { id?: string }) {
  const { moi } = useSession();
  if (!peut(moi.role, "rh"))
    return (
      <div className="page">
        <h1>Employés</h1>
        <Bandeau ton="avertissement" titre="Accès réservé">
          <p>La gestion des employés est réservée aux propriétaires et administrateurs.</p>
        </Bandeau>
      </div>
    );
  return id ? <FicheEmployeEcran id={id} /> : <ListeEmployes />;
}

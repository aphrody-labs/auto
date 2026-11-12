import { sirenValide, siretValide, type Partie } from "@auto/domain";
import { Pencil, Search, UserPlus, Users } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi, type Client } from "@auto/client";
import { chiffres, emailValide, grouperSiret } from "@auto/ui/format";
import { peut, useSession } from "../session";
import {
  Bouton,
  ChampTexte,
  ChampZone,
  EtatChargement,
  EtatErreur,
  EtatVide,
  Modale,
  ResumeErreurs,
  useDonnees,
  useTitrePage,
  useToast,
} from "@auto/ui/react";

const vide: Partie = { nom: "", siret: "", adresse: "", email: "", tvaIntracom: "" };

/** Erreurs du formulaire client, par champ. */
export function erreursClient(p: Partie): Record<string, string | undefined> {
  const s = chiffres(p.siret);
  return {
    nom: p.nom.trim() ? undefined : "Nom ou raison sociale obligatoire.",
    adresse: p.adresse.trim() ? undefined : "Adresse obligatoire.",
    siret: !s || siretValide(s) ? undefined : "SIRET invalide : 14 chiffres, clé de contrôle vérifiée.",
    email: !p.email || emailValide(p.email) ? undefined : "Adresse e-mail invalide.",
  };
}

function FormulaireClient({ client, onFin }: { client: Client | null; onFin: (ok: boolean) => void }) {
  const toast = useToast();
  const [p, setP] = useState<Partie>(client ? { ...vide, ...client } : vide);
  const [err, setErr] = useState<Record<string, string | undefined>>({});
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [cherche, setCherche] = useState(false);

  async function prefill() {
    const s = chiffres(p.siret).slice(0, 9);
    if (!sirenValide(s)) {
      setErr({ ...err, siret: "Saisissez un SIREN (9 chiffres) ou un SIRET valide pour rechercher." });
      return;
    }
    setCherche(true);
    try {
      const r = await api.siren(s);
      setP({ ...p, nom: p.nom || r.nom, siret: grouperSiret(r.siretSiege), adresse: p.adresse || r.adresse });
      setErr({});
    } catch {
      setErr({ ...err, siret: "Entreprise introuvable dans l'annuaire : saisissez les informations à la main." });
    } finally {
      setCherche(false);
    }
  }

  async function soumettre(e: FormEvent) {
    e.preventDefault();
    const x = erreursClient(p);
    setErr(x);
    if (Object.values(x).some(Boolean)) return;
    setEnvoi(true);
    setErreur(null);
    const corps: Partie = {
      nom: p.nom.trim(),
      siret: chiffres(p.siret),
      adresse: p.adresse.trim(),
      ...(p.email?.trim() ? { email: p.email.trim() } : {}),
      ...(p.tvaIntracom?.trim() ? { tvaIntracom: p.tvaIntracom.trim() } : {}),
    };
    try {
      if (client) await api.modifierClient(client.id, corps);
      else await api.creerClient(corps);
      toast(client ? "Client modifié" : "Client ajouté");
      onFin(true);
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <form className="grille" noValidate onSubmit={soumettre} id="form-client">
      <ResumeErreurs erreur={erreur} />
      <div className="rangee rangee-bas">
        <ChampTexte
          className="espace"
          libelle="SIRET"
          inputMode="numeric"
          aide="Facultatif pour un particulier."
          value={p.siret}
          erreur={err.siret}
          onChange={(e) => setP({ ...p, siret: e.target.value })}
          onBlur={() => setP((x) => ({ ...x, siret: grouperSiret(x.siret) }))}
        />
        <Bouton icone={Search} chargement={cherche} onClick={prefill}>
          Préremplir
        </Bouton>
      </div>
      <ChampTexte
        libelle="Nom ou raison sociale"
        requis
        autoComplete="organization"
        value={p.nom}
        erreur={err.nom}
        onChange={(e) => setP({ ...p, nom: e.target.value })}
      />
      <ChampZone
        libelle="Adresse"
        requis
        rows={2}
        autoComplete="street-address"
        value={p.adresse}
        erreur={err.adresse}
        onChange={(e) => setP({ ...p, adresse: e.target.value })}
      />
      <div className="grille grille-2">
        <ChampTexte
          libelle="E-mail"
          type="email"
          autoComplete="email"
          value={p.email ?? ""}
          erreur={err.email}
          onChange={(e) => setP({ ...p, email: e.target.value })}
        />
        <ChampTexte
          libelle="TVA intracommunautaire"
          value={p.tvaIntracom ?? ""}
          onChange={(e) => setP({ ...p, tvaIntracom: e.target.value })}
        />
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

export function Clients() {
  useTitrePage("Clients");
  const { moi } = useSession();
  const ecrire = peut(moi.role, "ecrire");
  const [q, setQ] = useState("");
  const [edition, setEdition] = useState<Client | null | undefined>(undefined);
  const d = useDonnees(() => api.clients(q.trim() || undefined), [q]);

  let corps;
  if (d.etat === "chargement") corps = <EtatChargement />;
  else if (d.etat === "erreur") corps = <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  else if (d.donnees.length === 0)
    corps = (
      <EtatVide icone={Users} titre={q ? "Aucun client ne correspond" : "Aucun client enregistré"}>
        {!q && <p>Ajoutez un client ou importez votre fichier depuis Imports.</p>}
      </EtatVide>
    );
  else
    corps = (
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">SIRET</th>
              <th scope="col">Adresse</th>
              <th scope="col">E-mail</th>
              {ecrire && (
                <th scope="col">
                  <span className="visuellement-cache">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {d.donnees.map((c) => (
              <tr key={c.id}>
                <td data-libelle="Nom">{c.nom}</td>
                <td data-libelle="SIRET" className="chiffres">
                  {c.siret ? grouperSiret(c.siret) : "—"}
                </td>
                <td data-libelle="Adresse">{c.adresse}</td>
                <td data-libelle="E-mail">{c.email ?? "—"}</td>
                {ecrire && (
                  <td data-libelle="Actions">
                    <Bouton
                      variante="fantome"
                      icone={Pencil}
                      aria-label={`Modifier ${c.nom}`}
                      onClick={() => setEdition(c)}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="page">
      <div className="page-entete">
        <h1>Clients</h1>
        {ecrire && (
          <Bouton variante="primaire" icone={UserPlus} onClick={() => setEdition(null)}>
            Ajouter un client
          </Bouton>
        )}
      </div>
      <ChampTexte
        libelle="Rechercher un client"
        type="search"
        placeholder="Nom, SIRET ou e-mail"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {corps}
      <Modale
        ouverte={edition !== undefined}
        titre={edition ? "Modifier le client" : "Ajouter un client"}
        onFermer={() => setEdition(undefined)}
      >
        {edition !== undefined && (
          <FormulaireClient
            key={edition?.id ?? "nouveau"}
            client={edition}
            onFin={(ok) => {
              setEdition(undefined);
              if (ok) d.recharger();
            }}
          />
        )}
      </Modale>
    </div>
  );
}

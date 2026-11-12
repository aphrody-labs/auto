// Onboarding en 3 étapes : compte, entreprise (préremplie depuis le SIREN), connexions facultatives.
import { sirenValide, siretValide } from "@auto/domain";
import { ArrowLeft, ArrowRight, Building2, Inbox, PlugZap, Search } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi } from "@auto/client";
import { chiffres, emailValide, grouperSiret } from "@auto/ui/format";
import { Bandeau, Bouton, ChampTexte, ChampZone, Lien, ResumeErreurs, naviguer, useTitrePage } from "@auto/ui/react";
import { Marque } from "./marque";

const ETAPES = ["Votre compte", "Votre entreprise", "Connexions"] as const;

function Etapes({ courante }: { courante: number }) {
  return (
    <ol className="etapes" aria-label="Étapes de l'inscription">
      {ETAPES.map((e, i) => (
        <li
          key={e}
          data-etat={i < courante ? "faite" : i === courante ? "courante" : "a-venir"}
          aria-current={i === courante ? "step" : undefined}
        >
          <span>
            <span className="visuellement-cache">Étape {i + 1} sur 3 : </span>
            {e}
            {i < courante && <span className="visuellement-cache"> (terminée)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * `connecte` : compte déjà ouvert (lien magique, Google, Microsoft) sans entreprise ; l'inscription commence à
 * l'étape entreprise et crée seulement l'entreprise.
 */
export function Onboarding({
  onSession,
  connecte = false,
}: {
  onSession: () => Promise<void> | void;
  connecte?: boolean;
}) {
  const [etape, setEtape] = useState(connecte ? 1 : 0);
  useTitrePage(`Inscription, ${ETAPES[etape]}`);
  const [compte, setCompte] = useState({ email: "", motDePasse: "" });
  const [ent, setEnt] = useState({ siren: "", nom: "", siret: "", adresse: "", franchiseTva: false });
  const [erreurs, setErreurs] = useState<Record<string, string | undefined>>({});
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [recherche, setRecherche] = useState<"repos" | "cours" | "trouve" | "absent">("repos");
  const [envoi, setEnvoi] = useState(false);

  function validerCompte(e: FormEvent) {
    e.preventDefault();
    const err = {
      email: emailValide(compte.email) ? undefined : "Saisissez une adresse e-mail valide, par exemple nom@exemple.fr.",
      motDePasse: compte.motDePasse.length >= 12 ? undefined : "12 caractères au minimum.",
    };
    setErreurs(err);
    if (!err.email && !err.motDePasse) setEtape(1);
  }

  async function chercherSiren() {
    const s = chiffres(ent.siren);
    if (!sirenValide(s)) {
      setErreurs({ siren: "SIREN invalide : 9 chiffres, clé de contrôle vérifiée." });
      return;
    }
    setErreurs({});
    setRecherche("cours");
    try {
      const r = await api.siren(s);
      setEnt((x) => ({ ...x, nom: r.nom, siret: grouperSiret(r.siretSiege), adresse: r.adresse }));
      setRecherche("trouve");
    } catch {
      setRecherche("absent");
    }
  }

  async function creer(e: FormEvent) {
    e.preventDefault();
    const err = {
      nom: ent.nom.trim() ? undefined : "Raison sociale obligatoire.",
      siret: siretValide(chiffres(ent.siret)) ? undefined : "SIRET invalide : 14 chiffres, clé de contrôle vérifiée.",
      adresse: ent.adresse.trim() ? undefined : "Adresse obligatoire (figure sur vos factures).",
    };
    setErreurs(err);
    if (err.nom || err.siret || err.adresse) return;
    setEnvoi(true);
    setErreur(null);
    try {
      const entreprise = {
        nom: ent.nom.trim(),
        siret: chiffres(ent.siret),
        adresse: ent.adresse.trim(),
        franchiseTva: ent.franchiseTva,
      };
      if (connecte) await api.creerEntreprise(entreprise);
      else await api.inscrire({ email: compte.email.trim(), motDePasse: compte.motDePasse, entreprise });
      setEtape(2);
    } catch (x) {
      setErreur(x as ErreurApi);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <main className="auth" id="contenu">
      <div className="fond-motif pattern-dots-md" aria-hidden="true" />
      <div className="auth-carte carte">
        <Marque />
        <h1>Créer votre compte</h1>
        <Etapes courante={etape} />

        {etape === 0 && (
          <form className="grille" noValidate onSubmit={validerCompte}>
            <ChampTexte
              libelle="E-mail professionnel"
              type="email"
              autoComplete="email"
              requis
              value={compte.email}
              erreur={erreurs.email}
              onChange={(e) => setCompte({ ...compte, email: e.target.value })}
            />
            <ChampTexte
              libelle="Mot de passe"
              type="password"
              autoComplete="new-password"
              requis
              aide="12 caractères au minimum. Une phrase de passe est plus simple à retenir."
              value={compte.motDePasse}
              erreur={erreurs.motDePasse}
              onChange={(e) => setCompte({ ...compte, motDePasse: e.target.value })}
            />
            <Bouton type="submit" variante="primaire" icone={ArrowRight} plein>
              Continuer
            </Bouton>
            <p className="attenue">
              Déjà inscrit ? <Lien href="/app/connexion">Se connecter</Lien>
            </p>
          </form>
        )}

        {etape === 1 && (
          <form className="grille" noValidate onSubmit={creer}>
            <ResumeErreurs erreur={erreur} />
            <div className="rangee rangee-bas">
              <ChampTexte
                className="espace"
                libelle="SIREN"
                inputMode="numeric"
                autoComplete="off"
                aide="Préremplit la raison sociale, le SIRET du siège et l'adresse depuis l'annuaire des entreprises."
                value={ent.siren}
                erreur={erreurs.siren}
                onChange={(e) => setEnt({ ...ent, siren: e.target.value })}
              />
              <Bouton icone={Search} chargement={recherche === "cours"} onClick={chercherSiren}>
                Rechercher
              </Bouton>
            </div>
            <div aria-live="polite">
              {recherche === "trouve" && (
                <Bandeau ton="succes" titre="Entreprise trouvée">
                  <p>Vérifiez les informations ci-dessous avant de continuer.</p>
                </Bandeau>
              )}
              {recherche === "absent" && (
                <Bandeau ton="avertissement" titre="Annuaire indisponible ou SIREN inconnu">
                  <p>Saisissez les informations à la main.</p>
                </Bandeau>
              )}
            </div>
            <ChampTexte
              libelle="Raison sociale"
              autoComplete="organization"
              requis
              value={ent.nom}
              erreur={erreurs.nom}
              onChange={(e) => setEnt({ ...ent, nom: e.target.value })}
            />
            <ChampTexte
              libelle="SIRET"
              inputMode="numeric"
              requis
              value={ent.siret}
              erreur={erreurs.siret}
              onChange={(e) => setEnt({ ...ent, siret: e.target.value })}
              onBlur={() => setEnt((x) => ({ ...x, siret: grouperSiret(x.siret) }))}
            />
            <ChampZone
              libelle="Adresse"
              autoComplete="street-address"
              rows={2}
              requis
              value={ent.adresse}
              erreur={erreurs.adresse}
              onChange={(e) => setEnt({ ...ent, adresse: e.target.value })}
            />
            <label className="case">
              <input
                type="checkbox"
                checked={ent.franchiseTva}
                onChange={(e) => setEnt({ ...ent, franchiseTva: e.target.checked })}
              />
              Franchise en base de TVA (art. 293 B du CGI) : mes factures sont sans TVA
            </label>
            <div className="rangee">
              <Bouton icone={ArrowLeft} onClick={() => setEtape(0)}>
                Retour
              </Bouton>
              <span className="espace" />
              <Bouton type="submit" variante="primaire" icone={Building2} chargement={envoi}>
                Créer mon entreprise
              </Bouton>
            </div>
          </form>
        )}

        {etape === 2 && (
          <div className="grille">
            <Bandeau ton="succes" titre="Compte créé">
              <p>Votre entreprise est prête. Ces connexions se font plus tard, depuis les paramètres.</p>
            </Bandeau>
            <ul className="liste-connexions">
              <li className="carte">
                <PlugZap className="icone" aria-hidden="true" />
                <div>
                  <strong>Plateforme agréée (PA)</strong>
                  <p className="attenue">
                    Configurer un compte B2Brouter existant. Le raccordement reste à qualifier avec votre plateforme.
                  </p>
                  <Bouton
                    onClick={async () => {
                      await onSession();
                      naviguer("/app/parametres", true);
                    }}
                  >
                    Configurer
                  </Bouton>
                </div>
                <span className="pastille-etat">À connecter</span>
              </li>
              <li className="carte">
                <Inbox className="icone" aria-hidden="true" />
                <div>
                  <strong>Boîte mail</strong>
                  <p className="attenue">Connectez un compte depuis votre boîte unifiée.</p>
                  <Bouton
                    onClick={async () => {
                      await onSession();
                      naviguer("/app/courrier", true);
                    }}
                  >
                    Ouvrir la boîte unifiée
                  </Bouton>
                </div>
                <span className="pastille-etat">À connecter</span>
              </li>
            </ul>
            <Bouton
              variante="primaire"
              icone={ArrowRight}
              plein
              onClick={async () => {
                await onSession();
                naviguer("/app", true);
              }}
            >
              Accéder au tableau de bord
            </Bouton>
          </div>
        )}
      </div>
    </main>
  );
}

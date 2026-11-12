// Acceptation d'une invitation : lien Better Auth (`/app/invitation?id=…`) ou ancien lien (`#jeton`).
// Connecté avec la bonne adresse : acceptation directe. Sinon : mot de passe du compte existant, ou du
// compte à créer (12 caractères minimum) ; la 2FA du compte s'applique ensuite à la connexion.
import { Check, LogIn } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { api, ErreurApi } from "@auto/client";
import { Bandeau, Bouton, ChampTexte, Lien, ResumeErreurs, naviguer, parametre, useTitrePage } from "@auto/ui/react";
import { authClient, messageAuth } from "../auth";
import { Marque } from "./marque";

export function Invitation({ onSession }: { onSession: () => Promise<void> | void }) {
  useTitrePage("Invitation");
  const id = parametre("id");
  const jeton = location.hash.slice(1) || null;
  const session = authClient.useSession();
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [deuxFacteurs, setDeuxFacteurs] = useState(false);

  async function accepterConnecte() {
    if (!id) return;
    setEnvoi(true);
    setErreur(null);
    try {
      const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
      if (error) return setErreur(new ErreurApi(messageAuth(error), error.status ?? 400));
      await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
      await onSession();
      naviguer("/app", true);
    } finally {
      setEnvoi(false);
    }
  }

  async function accepter(e: FormEvent) {
    e.preventDefault();
    setEnvoi(true);
    setErreur(null);
    try {
      const r = await api.accepterInvitation({ ...(id ? { id } : { jeton: jeton ?? "" }), motDePasse });
      if (r.deuxFacteurs) return setDeuxFacteurs(true);
      await onSession();
      naviguer("/app", true);
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
        <h1>Rejoindre une entreprise</h1>
        {!id && !jeton ? (
          <Bandeau ton="erreur" titre="Lien incomplet">
            <p>Ouvrez le lien reçu par e-mail tel quel.</p>
          </Bandeau>
        ) : deuxFacteurs ? (
          <Bandeau ton="succes" titre="Invitation acceptée">
            <p>
              Votre compte est protégé par la double authentification :{" "}
              <Lien href="/app/connexion">connectez-vous</Lien> pour continuer.
            </p>
          </Bandeau>
        ) : session.data && id ? (
          <div className="grille">
            <ResumeErreurs erreur={erreur} />
            <p>
              Connecté en tant que <strong>{session.data.user.email}</strong>.
            </p>
            <Bouton variante="primaire" icone={Check} chargement={envoi} plein onClick={accepterConnecte}>
              Accepter l'invitation
            </Bouton>
            <Bouton
              variante="fantome"
              disabled={envoi}
              onClick={async () => {
                setEnvoi(true);
                setErreur(null);
                try {
                  const { error } = await authClient.signOut();
                  if (error) return setErreur(new ErreurApi(messageAuth(error), error.status ?? 400));
                  await onSession();
                } catch {
                  setErreur(new ErreurApi("Impossible de changer de compte. Réessayez.", 0));
                } finally {
                  setEnvoi(false);
                }
              }}
            >
              Utiliser un autre compte
            </Bouton>
          </div>
        ) : (
          <form className="grille" noValidate onSubmit={accepter}>
            <ResumeErreurs erreur={erreur} />
            <p className="attenue">
              Saisissez le mot de passe de votre compte auto, ou choisissez-en un (12 caractères minimum) si vous n'avez
              pas encore de compte.
            </p>
            <ChampTexte
              libelle="Mot de passe"
              type="password"
              autoComplete="current-password"
              requis
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value)}
            />
            <Bouton type="submit" variante="primaire" icone={LogIn} chargement={envoi} plein>
              Rejoindre
            </Bouton>
          </form>
        )}
      </div>
    </main>
  );
}

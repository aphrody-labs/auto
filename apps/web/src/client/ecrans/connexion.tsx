// Connexion par Better Auth : mot de passe (puis second facteur), lien magique par mail, passkey, et
// fournisseurs Google ou Microsoft quand l'opérateur les a configurés. Lancée par un client OAuth (MCP),
// la connexion reprend ensuite l'autorisation (requête signée relayée par le client Better Auth).
import { KeyRound, LogIn, Send, ShieldCheck } from "@auto/ui/symboles";
import { useEffect, useState, type FormEvent } from "react";
import { ErreurApi } from "@auto/client";
import { emailValide } from "@auto/ui/format";
import { Bandeau, Bouton, ChampTexte, Lien, ResumeErreurs, naviguer, parametre, useTitrePage } from "@auto/ui/react";
import { authClient, messageAuth, suivreRedirection } from "../auth";
import { Marque } from "./marque";
import { ConnexionAppareil, dansApplicationNative } from "./appareil";
import { LogoFournisseur } from "./logo-fournisseur";

/** Destination après connexion : seulement un chemin interne de l'application (pas de redirection ouverte). */
export const retourSur = (r: string | null) => (r && r.startsWith("/app") && !r.startsWith("//") ? r : "/app");

const NOMS: Record<string, string> = { google: "Google", microsoft: "Microsoft" };

type Etape = "identifiants" | "deuxFacteurs" | "lienEnvoye";

export function Connexion({ onSession }: { onSession: () => Promise<void> | void }) {
  useTitrePage("Connexion");
  const [etape, setEtape] = useState<Etape>("identifiants");
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [resterConnecte, setResterConnecte] = useState(true);
  const [code, setCode] = useState("");
  const [confiance, setConfiance] = useState(false);
  const [erreurs, setErreurs] = useState<{ email?: string; motDePasse?: string; code?: string }>({});
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState<string | null>(null);
  // null tant que /v1/auth/methodes n'a pas répondu : places réservées pour les boutons (pas de décalage).
  const [sociaux, setSociaux] = useState<string[] | null>(null);
  const [appareilActif, setAppareilActif] = useState(false);

  useEffect(() => {
    fetch("/v1/auth/methodes")
      .then((r) => (r.ok ? r.json() : { sociaux: [] }))
      .then((m: { sociaux?: string[]; appareil?: boolean }) => {
        setSociaux(m.sociaux ?? []);
        setAppareilActif(m.appareil === true);
      })
      .catch(() => setSociaux([]));
  }, []);

  const retour = retourSur(parametre("retour"));

  async function apres(d: unknown) {
    if (suivreRedirection(d)) return;
    await onSession();
    naviguer(retour, true);
  }

  function echec(e: { code?: string; message?: string; status?: number }) {
    setErreur(new ErreurApi(messageAuth(e), e.status ?? 400));
  }

  async function motDePasseSoumis(e: FormEvent) {
    e.preventDefault();
    const err = {
      email: emailValide(email) ? undefined : "Saisissez une adresse e-mail valide, par exemple nom@exemple.fr.",
      motDePasse: motDePasse ? undefined : "Saisissez votre mot de passe.",
    };
    setErreurs(err);
    if (err.email || err.motDePasse) return;
    setEnvoi("mdp");
    setErreur(null);
    try {
      const { data, error } = await authClient.signIn.email({
        email: email.trim(),
        password: motDePasse,
        rememberMe: resterConnecte,
      });
      if (error) return echec(error);
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        setEtape("deuxFacteurs");
        return;
      }
      await apres(data);
    } finally {
      setEnvoi(null);
    }
  }

  async function codeSoumis(e: FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!c) return setErreurs({ code: "Saisissez le code à 6 chiffres ou un code de secours." });
    setErreurs({});
    setEnvoi("code");
    setErreur(null);
    try {
      const { data, error } = /^\d{6}$/.test(c)
        ? await authClient.twoFactor.verifyTotp({ code: c, trustDevice: confiance })
        : await authClient.twoFactor.verifyBackupCode({ code: c, trustDevice: confiance });
      if (error) return echec(error);
      await apres(data);
    } finally {
      setEnvoi(null);
    }
  }

  async function lienMagique() {
    if (!emailValide(email)) return setErreurs({ email: "Saisissez d'abord votre adresse e-mail." });
    setErreurs({});
    setEnvoi("lien");
    setErreur(null);
    try {
      const { error } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: retour });
      if (error) return echec(error);
      setEtape("lienEnvoye");
    } finally {
      setEnvoi(null);
    }
  }

  async function passkey() {
    setEnvoi("passkey");
    setErreur(null);
    try {
      const r = await authClient.signIn.passkey();
      if (r?.error) return echec(r.error);
      await apres(r?.data);
    } finally {
      setEnvoi(null);
    }
  }

  return (
    <main className="auth" id="contenu">
      <div className="fond-motif pattern-dots-md" aria-hidden="true" />
      <div className="auth-carte carte">
        <Marque />
        {etape === "identifiants" && (
          <>
            <h1>Se connecter</h1>
            <form className="grille" noValidate onSubmit={motDePasseSoumis}>
              <ResumeErreurs erreur={erreur} />
              <ChampTexte
                libelle="E-mail"
                type="email"
                autoComplete="username webauthn"
                requis
                value={email}
                erreur={erreurs.email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <ChampTexte
                libelle="Mot de passe"
                type="password"
                autoComplete="current-password webauthn"
                requis
                value={motDePasse}
                erreur={erreurs.motDePasse}
                onChange={(e) => setMotDePasse(e.target.value)}
              />
              <label className="rangee permission-option">
                <input type="checkbox" checked={resterConnecte} onChange={(e) => setResterConnecte(e.target.checked)} />
                Rester connecté sur cet appareil
              </label>
              <Bouton type="submit" variante="primaire" icone={LogIn} chargement={envoi === "mdp"} plein>
                Se connecter
              </Bouton>
              <div className="grille grille-2">
                <Bouton icone={Send} chargement={envoi === "lien"} onClick={lienMagique}>
                  Recevoir un lien par e-mail
                </Bouton>
                <Bouton icone={KeyRound} chargement={envoi === "passkey"} onClick={passkey}>
                  Clé d'accès (passkey)
                </Bouton>
              </div>
              {sociaux === null &&
                ["google", "microsoft"].map((p) => (
                  <Bouton
                    key={p}
                    plein
                    className="connexion-fournisseur connexion-attente"
                    disabled
                    aria-hidden
                    tabIndex={-1}
                  >
                    Continuer
                  </Bouton>
                ))}
              {(sociaux ?? []).map((p) => (
                <Bouton
                  key={p}
                  plein
                  className="connexion-fournisseur"
                  onClick={() => authClient.signIn.social({ provider: p as "google", callbackURL: retour })}
                >
                  <LogoFournisseur fournisseur={p} />
                  Continuer avec {NOMS[p] ?? p}
                </Bouton>
              ))}
              {appareilActif && dansApplicationNative() && <ConnexionAppareil onSession={onSession} retour={retour} />}
              <p className="attenue">
                Pas encore de compte ? <Lien href="/app/inscription">Créer un compte gratuit</Lien>
              </p>
            </form>
          </>
        )}
        {etape === "deuxFacteurs" && (
          <>
            <h1>Double authentification</h1>
            <form className="grille" noValidate onSubmit={codeSoumis}>
              <ResumeErreurs erreur={erreur} />
              <p className="attenue">
                Saisissez le code de votre application d'authentification, ou l'un de vos codes de secours.
              </p>
              <ChampTexte
                libelle="Code"
                inputMode="text"
                autoComplete="one-time-code"
                requis
                value={code}
                erreur={erreurs.code}
                onChange={(e) => setCode(e.target.value)}
              />
              <label className="rangee">
                <input type="checkbox" checked={confiance} onChange={(e) => setConfiance(e.target.checked)} />
                Faire confiance à cet appareil pendant 30 jours
              </label>
              <Bouton type="submit" variante="primaire" icone={ShieldCheck} chargement={envoi === "code"} plein>
                Valider
              </Bouton>
            </form>
          </>
        )}
        {etape === "lienEnvoye" && (
          <>
            <h1>Vérifiez votre boîte mail</h1>
            <Bandeau ton="succes" titre="Lien envoyé">
              <p>
                Si un compte existe pour {email.trim()}, un lien de connexion valable 10 minutes vient d'y être envoyé.
              </p>
            </Bandeau>
            <Bouton onClick={() => setEtape("identifiants")}>Retour</Bouton>
          </>
        )}
      </div>
    </main>
  );
}

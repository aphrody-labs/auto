// Paramètres, sécurité du compte (Better Auth) : double authentification TOTP et codes de secours, clés
// d'accès (passkeys), mot de passe, sessions actives, applications autorisées (clients MCP par OAuth).
import { Copy, KeyRound, Lock, LogOut, ShieldCheck, Smartphone, Trash2 } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { ErreurApi } from "@auto/client";
import { Bandeau, Bouton, ChampTexte, EtatChargement, ResumeErreurs, useDonnees, useToast } from "@auto/ui/react";
import { authClient, messageAuth } from "../auth";
import { useSession } from "../session";

type ErreurBa = { code?: string; message?: string; status?: number } | null;
const enErreur = (e: ErreurBa) => (e ? new ErreurApi(messageAuth(e), e.status ?? 400) : null);
const date = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("fr-FR") : "—");

function Codes({ codes }: { codes: string[] }) {
  const toast = useToast();
  return (
    <Bandeau ton="avertissement" titre="Codes de secours : notez-les maintenant, ils ne seront plus affichés">
      <p className="jeton">{codes.join("  ")}</p>
      <Bouton
        icone={Copy}
        onClick={async () => {
          await navigator.clipboard?.writeText(codes.join("\n"));
          toast("Codes copiés");
        }}
      >
        Copier
      </Bouton>
    </Bandeau>
  );
}

function DeuxFacteurs() {
  const { moi, recharger } = useSession();
  const toast = useToast();
  const [mdp, setMdp] = useState("");
  const [code, setCode] = useState("");
  const [enrolement, setEnrolement] = useState<{ uri: string; secret: string; codes: string[] } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function lancer(f: () => Promise<void>) {
    setEnvoi(true);
    setErreur(null);
    try {
      await f();
    } finally {
      setEnvoi(false);
    }
  }

  const activer = (e: FormEvent) => {
    e.preventDefault();
    return lancer(async () => {
      const { data, error } = await authClient.twoFactor.enable({ password: mdp });
      if (error || !data || !("totpURI" in data)) return setErreur(enErreur(error));
      const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
      setEnrolement({ uri: data.totpURI, secret, codes: data.backupCodes });
      setMdp("");
    });
  };
  const confirmer = (e: FormEvent) => {
    e.preventDefault();
    return lancer(async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (error) return setErreur(enErreur(error));
      setCodes(enrolement!.codes);
      setEnrolement(null);
      setCode("");
      toast("Double authentification activée");
      await recharger();
    });
  };
  const desactiver = (e: FormEvent) => {
    e.preventDefault();
    return lancer(async () => {
      const { error } = await authClient.twoFactor.disable({ password: mdp });
      if (error) return setErreur(enErreur(error));
      setMdp("");
      setCodes(null);
      toast("Double authentification désactivée");
      await recharger();
    });
  };
  const regenerer = () =>
    lancer(async () => {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({ password: mdp });
      if (error || !data) return setErreur(enErreur(error));
      setCodes(data.backupCodes);
      setMdp("");
    });

  return (
    <div className="grille">
      <h3>Double authentification</h3>
      <ResumeErreurs erreur={erreur} />
      {codes && <Codes codes={codes} />}
      {enrolement ? (
        <form className="grille" noValidate onSubmit={confirmer}>
          <p>
            Ajoutez auto à votre application d'authentification : <a href={enrolement.uri}>ouvrir dans l'application</a>
            , ou saisissez la clé <code className="jeton">{enrolement.secret}</code>
          </p>
          <ChampTexte
            libelle="Code à 6 chiffres"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Bouton type="submit" variante="primaire" icone={ShieldCheck} chargement={envoi}>
            Confirmer
          </Bouton>
        </form>
      ) : (
        <form className="grille" noValidate onSubmit={moi.deuxFacteurs ? desactiver : activer}>
          <p className="attenue">
            {moi.deuxFacteurs
              ? "Active : un code de votre application est demandé à chaque connexion par mot de passe."
              : "Inactive : protégez votre compte par un code à usage unique (Google Authenticator, 1Password…)."}
          </p>
          <ChampTexte
            libelle="Mot de passe actuel"
            type="password"
            autoComplete="current-password"
            value={mdp}
            onChange={(e) => setMdp(e.target.value)}
          />
          <div className="rangee">
            <Bouton
              type="submit"
              variante={moi.deuxFacteurs ? "danger" : "primaire"}
              icone={Smartphone}
              chargement={envoi}
            >
              {moi.deuxFacteurs ? "Retirer la double authentification" : "Configurer la double authentification"}
            </Bouton>
            {moi.deuxFacteurs && (
              <Bouton icone={KeyRound} chargement={envoi} onClick={regenerer}>
                Nouveaux codes de secours
              </Bouton>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function ClesAcces() {
  const toast = useToast();
  const liste = useDonnees(async () => (await authClient.passkey.listUserPasskeys()).data ?? []);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  return (
    <div className="grille">
      <h3>Clés d'accès (passkeys)</h3>
      <ResumeErreurs erreur={erreur} />
      <p className="attenue">Connexion sans mot de passe par l'empreinte, le visage ou le code de cet appareil.</p>
      {liste.etat === "ok" && liste.donnees.length > 0 && (
        <ul className="pile-serree">
          {liste.donnees.map((p) => (
            <li key={p.id} className="rangee">
              <span className="espace">
                {p.name || "Clé d'accès"} <span className="attenue">ajoutée le {date(p.createdAt)}</span>
              </span>
              <Bouton
                variante="fantome"
                icone={Trash2}
                aria-label={`Supprimer ${p.name || "la clé d'accès"}`}
                onClick={async () => {
                  const { error } = await authClient.passkey.deletePasskey({ id: p.id });
                  if (error) return setErreur(enErreur(error));
                  toast("Clé d'accès supprimée");
                  liste.recharger();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div>
        <Bouton
          icone={KeyRound}
          onClick={async () => {
            setErreur(null);
            const r = await authClient.passkey.addPasskey({ name: navigator.platform || "appareil" });
            if (r?.error) return setErreur(enErreur(r.error));
            toast("Clé d'accès ajoutée");
            liste.recharger();
          }}
        >
          Ajouter une clé d'accès
        </Bouton>
      </div>
    </div>
  );
}

function MotDePasse() {
  const toast = useToast();
  const [actuel, setActuel] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  return (
    <form
      className="grille"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (nouveau.length < 12) return setErreur(new ErreurApi("Nouveau mot de passe : 12 caractères minimum.", 422));
        setEnvoi(true);
        setErreur(null);
        const { error } = await authClient.changePassword({
          currentPassword: actuel,
          newPassword: nouveau,
          revokeOtherSessions: true,
        });
        setEnvoi(false);
        if (error) return setErreur(enErreur(error));
        setActuel("");
        setNouveau("");
        toast("Mot de passe changé ; les autres sessions sont fermées");
      }}
    >
      <h3>Mot de passe</h3>
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-2">
        <ChampTexte
          libelle="Mot de passe actuel"
          type="password"
          autoComplete="current-password"
          value={actuel}
          onChange={(e) => setActuel(e.target.value)}
        />
        <ChampTexte
          libelle="Nouveau mot de passe"
          type="password"
          autoComplete="new-password"
          aide="12 caractères minimum"
          value={nouveau}
          onChange={(e) => setNouveau(e.target.value)}
        />
      </div>
      <div>
        <Bouton type="submit" icone={Lock} chargement={envoi}>
          Changer le mot de passe
        </Bouton>
      </div>
    </form>
  );
}

function ComptesLies() {
  const toast = useToast();
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const liste = useDonnees(async () => {
    const [comptes, reponse] = await Promise.all([authClient.listAccounts(), fetch("/v1/auth/methodes")]);
    if (comptes.error) throw new Error(messageAuth(comptes.error));
    if (!reponse.ok) throw new Error("Impossible de charger les méthodes de connexion.");
    const methodes = (await reponse.json()) as { sociaux: string[] };
    return { comptes: comptes.data ?? [], sociaux: methodes.sociaux };
  });
  async function lancer(action: () => Promise<void>) {
    setEnvoi(true);
    setErreur(null);
    try {
      await action();
    } catch {
      setErreur(new ErreurApi("Connexion impossible. Réessayez dans un instant.", 503));
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <div className="grille">
      <h3>Comptes Google et Microsoft</h3>
      <p className="attenue">Associez un compte de même adresse e-mail pour vous connecter avec ce fournisseur.</p>
      <ResumeErreurs erreur={erreur} />
      {liste.etat === "chargement" && <EtatChargement lignes={2} />}
      {liste.etat === "erreur" && (
        <Bandeau ton="avertissement" titre={liste.erreur}>
          <Bouton onClick={liste.recharger}>Réessayer</Bouton>
        </Bandeau>
      )}
      {liste.etat === "ok" && (
        <ul className="pile-serree">
          {(["google", "microsoft"] as const).map((provider) => {
            const nom = provider === "google" ? "Google" : "Microsoft";
            const compte = liste.donnees.comptes.find((c) => c.providerId === provider);
            const disponible = liste.donnees.sociaux.includes(provider);
            return (
              <li key={provider} className="rangee">
                <span className="espace">
                  {nom}{" "}
                  <span className="attenue">{compte ? "Associé" : disponible ? "Non associé" : "Non configuré"}</span>
                </span>
                {compte ? (
                  <Bouton
                    disabled={envoi || liste.donnees.comptes.length < 2}
                    onClick={() =>
                      lancer(async () => {
                        const { error } = await authClient.unlinkAccount({ accountId: compte.id });
                        if (error) return setErreur(enErreur(error));
                        toast(`Compte ${nom} dissocié`);
                        liste.recharger();
                      })
                    }
                  >
                    Dissocier {nom}
                  </Bouton>
                ) : (
                  disponible && (
                    <Bouton
                      disabled={envoi}
                      onClick={() =>
                        lancer(async () => {
                          const { error } = await authClient.linkSocial({
                            provider,
                            callbackURL: "/app/parametres",
                            errorCallbackURL: "/app/parametres?liaison=erreur",
                          });
                          if (error) setErreur(enErreur(error));
                        })
                      }
                    >
                      Associer {nom}
                    </Bouton>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {new URLSearchParams(location.search).get("liaison") === "erreur" && (
        <Bandeau
          ton="avertissement"
          titre="Association refusée ou annulée. Vérifiez que les adresses e-mail correspondent, puis réessayez."
        />
      )}
      <p className="attenue">Conservez au moins une méthode de connexion avant de dissocier un compte.</p>
    </div>
  );
}

function Sessions() {
  const toast = useToast();
  const courante = authClient.useSession();
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const liste = useDonnees(async () => {
    const { data, error } = await authClient.listSessions();
    if (error) throw new Error(messageAuth(error));
    return data ?? [];
  });
  async function fermer(token?: string) {
    setEnvoi(true);
    setErreur(null);
    try {
      const { error } = token ? await authClient.revokeSession({ token }) : await authClient.revokeOtherSessions();
      if (error) return setErreur(enErreur(error));
      toast(token ? "Session fermée" : "Autres sessions fermées");
      liste.recharger();
    } catch {
      setErreur(new ErreurApi("Impossible de fermer la session. Réessayez.", 0));
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <div className="grille">
      <h3>Sessions actives</h3>
      <p>Chaque employé utilise son propre compte. Fermer une session ici ne déconnecte pas vos collègues.</p>
      <ResumeErreurs erreur={erreur} />
      {liste.etat === "chargement" && <EtatChargement lignes={2} />}
      {liste.etat === "erreur" && <p role="alert">{liste.erreur}</p>}
      {liste.etat === "ok" && (
        <ul className="pile-serree">
          {liste.donnees.map((s) => (
            <li key={s.id} className="rangee">
              <span className="espace">
                {s.userAgent?.slice(0, 80) || "Navigateur inconnu"}{" "}
                <span className="attenue">
                  {s.ipAddress ?? ""} · depuis le {date(s.createdAt)}
                  {` · expire le ${date(s.expiresAt)}`}
                  {s.id === courante.data?.session.id ? " · cette session" : ""}
                </span>
              </span>
              {s.id !== courante.data?.session.id && (
                <Bouton
                  variante="fantome"
                  icone={LogOut}
                  aria-label="Fermer cette session"
                  disabled={envoi}
                  onClick={() => void fermer(s.token)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Bouton icone={LogOut} disabled={envoi} onClick={() => void fermer()}>
          Fermer les autres sessions
        </Bouton>
      </div>
    </div>
  );
}

interface Consentement {
  id: string;
  clientId: string;
  scopes: string[];
  createdAt: string;
}

function Applications() {
  const toast = useToast();
  const liste = useDonnees(async () => {
    const r = await authClient.$fetch<Consentement[]>("/oauth2/get-consents", { method: "GET" });
    return r.data ?? [];
  });
  return (
    <div className="grille">
      <h3>Applications autorisées</h3>
      <p className="attenue">
        Clients MCP (Claude Code, Claude Desktop…) connectés par OAuth au serveur MCP distant d'auto.
      </p>
      {liste.etat === "ok" && liste.donnees.length === 0 && <p className="attenue">Aucune application.</p>}
      {liste.etat === "ok" && liste.donnees.length > 0 && (
        <ul className="pile-serree">
          {liste.donnees.map((c) => (
            <li key={c.id} className="rangee">
              <span className="espace">
                {c.clientId}{" "}
                <span className="attenue">
                  {c.scopes.join(" ")} · {date(c.createdAt)}
                </span>
              </span>
              <Bouton
                variante="fantome"
                icone={Trash2}
                aria-label={`Révoquer ${c.clientId}`}
                onClick={async () => {
                  await authClient.$fetch("/oauth2/delete-consent", { method: "POST", body: { id: c.id } });
                  toast("Accès révoqué");
                  liste.recharger();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Securite() {
  return (
    <div className="grille">
      <DeuxFacteurs />
      <ClesAcces />
      <ComptesLies />
      <MotDePasse />
      <Sessions />
      <Applications />
    </div>
  );
}

import { useEffect, useState } from "react";
import { Bouton, Lien, naviguer, useTitrePage } from "@auto/ui/react";
import { authClient } from "../auth";

interface Demande {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  expire: number;
}
const formatCode = (s: string) => s.toUpperCase().replace(/(.{4})(?=.)/g, "$1-");
async function requete(path: string, body: unknown, signal?: AbortSignal) {
  return fetch("/api/auth/device" + path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
export const dansApplicationNative = () =>
  typeof window !== "undefined" && (window as Window & { __AUTO_NATIVE__?: boolean }).__AUTO_NATIVE__ === true;

/** RFC8628 : le secret appareil reste en mémoire ; le serveur pose le cookie HttpOnly après validation. */
export function ConnexionAppareil({ onSession, retour }: { onSession: () => Promise<void> | void; retour: string }) {
  const [demande, setDemande] = useState<Demande | null>(null),
    [erreur, setErreur] = useState(""),
    [chargement, setChargement] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!demande) return;
    let actif = true,
      timer: ReturnType<typeof setTimeout>,
      intervalle = Math.max(5, demande.interval) * 1000;
    const controle = new AbortController();
    const poll = async () => {
      if (!actif) return;
      if (Date.now() >= demande.expire) {
        setMessage("Code expiré. Lancez une nouvelle connexion.");
        setDemande(null);
        return;
      }
      try {
        const r = await requete(
          "/token",
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: "auto-native",
            device_code: demande.device_code,
          },
          controle.signal,
        );
        if (r.ok) {
          if (actif) {
            setDemande(null);
            await onSession();
            naviguer(retour);
          }
          return;
        }
        const b = (await r.json()) as { error?: string };
        if (b.error === "slow_down") intervalle += 5000;
        else if (b.error !== "authorization_pending") {
          setErreur(
            b.error === "access_denied"
              ? "Connexion refusée dans le navigateur."
              : "Ce code n’est plus utilisable. Relancez la connexion.",
          );
          setDemande(null);
          return;
        }
      } catch {
        if (!actif) return;
        setMessage("Connexion au serveur interrompue, nouvel essai en cours.");
      }
      if (actif) timer = setTimeout(poll, intervalle);
    };
    timer = setTimeout(poll, intervalle);
    return () => {
      actif = false;
      clearTimeout(timer);
      controle.abort();
    };
  }, [demande, onSession, retour]);
  async function commencer() {
    setChargement(true);
    setErreur("");
    setMessage("");
    try {
      const r = await requete("/code", { client_id: "auto-native" });
      if (!r.ok) throw Error("Impossible de préparer la connexion.");
      const b = (await r.json()) as Omit<Demande, "expire">;
      const u = new URL(b.verification_uri_complete);
      if (
        u.origin !== location.origin ||
        u.pathname !== "/app/verification-appareil" ||
        !b.device_code ||
        !b.user_code ||
        !Number.isFinite(b.expires_in) ||
        b.expires_in <= 0 ||
        !Number.isFinite(b.interval)
      )
        throw Error("Adresse de validation invalide.");
      setDemande({ ...b, expire: Date.now() + Math.min(600, b.expires_in) * 1000 });
      setMessage("Validez le même code dans votre navigateur. Cette fenêtre attend votre accord.");
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setChargement(false);
    }
  }
  return (
    <section className="grille" aria-label="Connexion avec le navigateur">
      {erreur && <p role="alert">{erreur}</p>}
      {message && <p role="status">{message}</p>}
      {demande ? (
        <>
          <p>
            Votre code : <strong className="chiffres">{formatCode(demande.user_code)}</strong>
          </p>
          <Bouton onClick={() => location.assign(demande.verification_uri_complete)}>Ouvrir le navigateur</Bouton>
          <Bouton
            variante="fantome"
            onClick={() => {
              setDemande(null);
              setMessage("Connexion annulée sur cet appareil.");
            }}
          >
            Annuler cette connexion
          </Bouton>
        </>
      ) : (
        <Bouton disabled={chargement} onClick={commencer}>
          Se connecter avec le navigateur
        </Bouton>
      )}
    </section>
  );
}

export function VerificationAppareil() {
  useTitrePage("Valider un appareil");
  const code = new URLSearchParams(location.search).get("user_code") ?? "";
  const [email, setEmail] = useState(""),
    [etat, setEtat] = useState("chargement"),
    [erreur, setErreur] = useState(""),
    [occupe, setOccupe] = useState(false);
  useEffect(() => {
    let actif = true;
    if (!/^[a-z0-9-]{4,32}$/i.test(code)) {
      setErreur("Code d’appareil invalide.");
      setEtat("erreur");
      return;
    }
    Promise.all([
      authClient.getSession(),
      fetch(`/api/auth/device?${new URLSearchParams({ user_code: code })}`, { credentials: "same-origin" }),
    ])
      .then(async ([s, r]) => {
        if (!actif) return;
        if (!s.data) throw Error("Connectez-vous avant de valider cet appareil.");
        if (!r.ok) throw Error("Code inconnu ou expiré.");
        const b = (await r.json()) as { client_id?: string; status?: string };
        if (b.client_id !== "auto-native") throw Error("Application non reconnue.");
        setEmail(s.data.user.email);
        setEtat(b.status ?? "pending");
      })
      .catch((e) => {
        if (actif) {
          setErreur(e.message);
          setEtat("erreur");
        }
      });
    return () => {
      actif = false;
    };
  }, [code]);
  async function decider(accord: boolean) {
    setOccupe(true);
    setErreur("");
    try {
      const r = await requete(accord ? "/approve" : "/deny", { userCode: code });
      if (!r.ok) throw Error("La validation a échoué. Vérifiez le code et réessayez.");
      setEtat(accord ? "approved" : "denied");
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setOccupe(false);
    }
  }
  return (
    <main className="courrier-app">
      <Lien href="/app/courrier">auto · Aphrody</Lien>
      <h1>Connexion à Auto sur un appareil</h1>
      {erreur && <p role="alert">{erreur}</p>}
      {etat === "chargement" ? (
        <p>Vérification du code…</p>
      ) : etat === "pending" ? (
        <section className="courrier-lecture">
          <h2>Auto natif · Windows / Android</h2>
          <p>
            Compte : <strong>{email}</strong>
          </p>
          <p>Confirmez que ce code est affiché dans votre application Auto :</p>
          <p className="chiffres">
            <strong>{formatCode(code)}</strong>
          </p>
          <p>Votre accord ouvre une session sur cet appareil.</p>
          <div className="courrier-actions">
            <Bouton disabled={occupe} onClick={() => decider(true)}>
              Autoriser cet appareil
            </Bouton>
            <Bouton disabled={occupe} variante="fantome" onClick={() => decider(false)}>
              Refuser
            </Bouton>
          </div>
        </section>
      ) : etat === "approved" ? (
        <p role="status">Appareil autorisé. Vous pouvez revenir dans l’application Auto.</p>
      ) : etat === "denied" ? (
        <p role="status">Connexion refusée.</p>
      ) : null}
    </main>
  );
}

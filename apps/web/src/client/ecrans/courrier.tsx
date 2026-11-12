import { useEffect, useState, type FormEvent } from "react";
import { Bouton, EtatChargement, Lien, useTitrePage } from "@auto/ui/react";
import { authClient } from "../auth";
import { Inbox, Send, RotateCcw, Pencil, LogOut, Users, ReceiptText } from "@auto/ui/symboles";
import { LogoFournisseur } from "./logo-fournisseur";

interface Compte {
  id: string;
  adresse: string;
  fournisseur: string;
  actif: boolean;
  synchronise_at: string | null;
  erreur: string | null;
}
interface Message {
  id: string;
  compte_id: string;
  adresse: string;
  expediteur: string;
  destinataires: string[];
  sujet: string;
  extrait?: string;
  texte?: string;
  date_envoi: string;
  lu: boolean;
  pieces: number | { id: string; nom: string; taille: number }[];
}
async function appel<T>(chemin: string, methode = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/v1/courrier${chemin}`, {
    method: methode,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body !== undefined && methode !== "GET" && methode !== "HEAD" ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 204) return null as T;
  const b = await r.json();
  if (!r.ok) throw new Error(b.erreur ?? `Erreur ${r.status}`);
  return b as T;
}
const date = (s: string) => new Date(s).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

export function Courrier() {
  useTitrePage("Ma boîte unifiée");
  const [comptes, setComptes] = useState<Compte[]>([]),
    [messages, setMessages] = useState<Message[]>([]),
    [detail, setDetail] = useState<Message | null>(null);
  const [compte, setCompte] = useState(""),
    [recherche, setRecherche] = useState(""),
    [q, setQ] = useState(""),
    [page, setPage] = useState(0),
    [suite, setSuite] = useState(false),
    [dossier, setDossier] = useState("reception");
  const [erreur, setErreur] = useState(""),
    [info, setInfo] = useState(""),
    [charge, setCharge] = useState(true),
    [occupe, setOccupe] = useState(false),
    [composer, setComposer] = useState(false),
    [comptesOuverts, setComptesOuverts] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(recherche);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [recherche]);
  useEffect(() => {
    const timer = setInterval(() => setRevision((x) => x + 1), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let actif = true;
    setCharge(true);
    setErreur("");
    Promise.all([
      appel<{ comptes: Compte[] }>("/comptes"),
      appel<{ messages: Message[]; suite: boolean }>(
        `/messages?${new URLSearchParams({ compte, q, page: String(page), dossier })}`,
      ),
    ])
      .then(([c, m]) => {
        if (actif) {
          setComptes(c.comptes);
          setMessages(m.messages);
          setSuite(m.suite);
        }
      })
      .catch((e) => {
        if (actif) setErreur((e as Error).message);
      })
      .finally(() => {
        if (actif) setCharge(false);
      });
    return () => {
      actif = false;
    };
  }, [compte, q, page, dossier, revision]);
  async function action(fn: () => Promise<void>) {
    setOccupe(true);
    setErreur("");
    setInfo("");
    try {
      await fn();
      setRevision((x) => x + 1);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setOccupe(false);
    }
  }
  const connecter = (f: string) =>
    action(async () => {
      const b = await appel<{ url: string }>(`/oauth/${f}/connecter`, "POST", {});
      location.assign(b.url);
    });
  const relever = () =>
    action(async () => {
      let n = 0,
        suivants = false,
        limitation = false;
      for (const c of comptes.filter((c) => c.actif)) {
        const r = await appel<{
          nouveaux: number;
          suite: boolean;
          repriseApresLimitation?: boolean;
          repriseA?: string;
        }>(`/comptes/${c.id}/synchroniser`, "POST", {});
        n += r.nouveaux;
        suivants ||= r.suite;
        if (r.repriseApresLimitation) {
          limitation = true;
          setInfo(
            `Google limite temporairement la relève. Reprise automatique${r.repriseA ? ` à ${date(r.repriseA)}` : " dans cinq minutes"}. Le curseur est conservé.`,
          );
          continue;
        }
      }
      if (!limitation) setInfo(`${n} message(s) synchronisé(s).${suivants ? " La relève continue par lots." : ""}`);
    });
  async function ouvrir(m: Message) {
    await action(async () => {
      const d = await appel<Message>(`/messages/${m.id}`);
      setDetail(d);
      await appel(`/messages/${m.id}`, "PATCH", { lu: true });
    });
  }
  async function envoyer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await action(async () => {
      await appel("/envoyer", "POST", {
        a: String(form.get("a") ?? "")
          .split(/[;,]/)
          .map((x) => x.trim())
          .filter(Boolean),
        sujet: String(form.get("sujet") ?? ""),
        texte: String(form.get("texte") ?? ""),
      });
      setComposer(false);
      setDossier("envoyes");
      setDetail(null);
      setInfo("Message envoyé avec Resend.");
    });
  }
  return (
    <main className="courrier-app">
      <header className="courrier-entete">
        <div>
          <Lien href="/app">auto · Aphrody</Lien> · <Lien href="/app/administration">Administration</Lien>
          <h1>Ma boîte unifiée</h1>
          <p>Gmail, Outlook et Aphrody réunis dans votre espace privé.</p>
        </div>
        <div className="courrier-actions">
          <Bouton
            className="courrier-toggle-comptes"
            icone={Users}
            aria-expanded={comptesOuverts}
            aria-controls="courrier-comptes"
            onClick={() => setComptesOuverts((x) => !x)}
          >
            Mes comptes
          </Bouton>
          <Bouton icone={RotateCcw} disabled={occupe || !comptes.some((c) => c.actif)} onClick={relever}>
            {occupe ? "Traitement…" : "Synchroniser"}
          </Bouton>
          <Bouton
            icone={Pencil}
            disabled={occupe}
            onClick={() => {
              setComposer(true);
              setDetail(null);
            }}
          >
            Nouveau message
          </Bouton>
          <Bouton
            variante="fantome"
            icone={LogOut}
            onClick={async () => {
              await authClient.signOut();
              location.assign("/app/connexion");
            }}
          >
            Déconnexion
          </Bouton>
        </div>
      </header>
      {erreur && (
        <p role="alert" className="courrier-erreur">
          {erreur}
        </p>
      )}
      {info && <p role="status">{info}</p>}
      <div className="courrier-grille" data-lecture={!!detail || composer}>
        <aside
          id="courrier-comptes"
          className="courrier-comptes"
          aria-label="Comptes et dossiers"
          data-ouverte={comptesOuverts}
        >
          <h2>Dossiers</h2>
          <button
            aria-pressed={dossier === "reception"}
            onClick={() => {
              setDossier("reception");
              setPage(0);
              setDetail(null);
              setComposer(false);
            }}
          >
            <Inbox className="icone" aria-hidden="true" /> Réception unifiée
          </button>
          <button
            aria-pressed={dossier === "envoyes"}
            onClick={() => {
              setDossier("envoyes");
              setPage(0);
              setDetail(null);
              setComposer(false);
            }}
          >
            <Send className="icone" aria-hidden="true" /> Envoyés avec Resend
          </button>
          <h2>Mes comptes</h2>
          <label>
            Trier par compte
            <select
              value={compte}
              onChange={(e) => {
                setCompte(e.target.value);
                setPage(0);
                setDetail(null);
              }}
            >
              <option value="">Tous mes comptes</option>
              {comptes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.adresse}
                </option>
              ))}
            </select>
          </label>
          {comptes.map((c) => (
            <section key={c.id} className="courrier-compte">
              <div className="courrier-identite">
                <LogoFournisseur fournisseur={c.fournisseur} />
                <strong>{c.adresse}</strong>
              </div>
              <span>
                {c.fournisseur === "google" ? "Gmail" : c.fournisseur === "microsoft" ? "Outlook" : "Aphrody"}
              </span>
              <small>
                {!c.actif
                  ? "Déconnecté"
                  : c.synchronise_at
                    ? `Relevé le ${date(c.synchronise_at)}`
                    : "Première relève à lancer"}
              </small>
              {c.erreur && <small role="status">{c.erreur}</small>}
              {c.actif && (
                <button
                  disabled={occupe}
                  onClick={() =>
                    action(async () => {
                      await appel(`/comptes/${c.id}`, "DELETE");
                      setInfo("Compte déconnecté. Les messages importés sont conservés.");
                    })
                  }
                >
                  Déconnecter
                </button>
              )}
            </section>
          ))}
          <h2>Ajouter un compte</h2>
          <Bouton disabled={occupe} onClick={() => connecter("google")}>
            <LogoFournisseur fournisseur="google" />
            Connecter Gmail
          </Bouton>
          <Bouton disabled={occupe} onClick={() => connecter("microsoft")}>
            <LogoFournisseur fournisseur="microsoft" />
            Connecter Outlook
          </Bouton>
          <Bouton
            disabled={occupe}
            icone={ReceiptText}
            onClick={() =>
              action(async () => {
                await appel("/comptes/aphrody", "POST", {});
                setInfo("Boîte Aphrody connectée. Lancez la synchronisation.");
              })
            }
          >
            Connecter Aphrody
          </Bouton>
          <p className="attenue">
            Les boîtes d’origine restent intactes. Le statut lu est local à Auto. Les envois utilisent l’adresse Aphrody
            via Resend.
          </p>
        </aside>
        <section className="courrier-liste" aria-label="Messages">
          <label>
            Rechercher
            <input
              type="search"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
              placeholder="Sujet, expéditeur, contenu"
            />
          </label>
          {charge ? (
            <EtatChargement />
          ) : !messages.length ? (
            <p>Aucun message dans cette vue. Connectez une boîte puis lancez sa synchronisation.</p>
          ) : (
            <ul>
              {messages.map((m) => (
                <li key={m.id}>
                  <button
                    className="courrier-message"
                    aria-current={detail?.id === m.id ? "true" : undefined}
                    onClick={() => ouvrir(m)}
                    disabled={occupe}
                  >
                    <span className={!m.lu ? "courrier-non-lu" : ""}>{m.expediteur || m.adresse}</span>
                    <strong>{m.sujet || "(Sans objet)"}</strong>
                    <span>{m.extrait}</span>
                    <small>
                      {date(m.date_envoi)} · {m.adresse}
                      {typeof m.pieces === "number" && m.pieces ? ` · ${m.pieces} pièce(s)` : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="courrier-pagination">
            <button disabled={!page || charge} onClick={() => setPage((p) => p - 1)}>
              Précédents
            </button>
            <span>Page {page + 1}</span>
            <button disabled={!suite || charge} onClick={() => setPage((p) => p + 1)}>
              Suivants
            </button>
          </div>
        </section>
        <section className="courrier-lecture" aria-label={composer ? "Nouveau message" : "Lecture du message"}>
          {composer ? (
            <form onSubmit={envoyer}>
              <h2>Nouveau message</h2>
              <p>De : Auto &lt;auto@notifications.aphrody.com&gt; · Réponses : auto@aphrody.com</p>
              <label>
                À (séparés par une virgule)
                <input name="a" required autoComplete="off" />
              </label>
              <label>
                Objet
                <input name="sujet" required maxLength={998} />
              </label>
              <label>
                Message
                <textarea name="texte" required rows={12} maxLength={100000} />
              </label>
              <div className="courrier-actions">
                <Bouton type="submit" disabled={occupe}>
                  Envoyer avec Resend
                </Bouton>
                <Bouton type="button" variante="fantome" onClick={() => setComposer(false)}>
                  Annuler
                </Bouton>
              </div>
            </form>
          ) : detail ? (
            <article>
              <Bouton className="courrier-retour-liste" variante="fantome" onClick={() => setDetail(null)}>
                ← Retour aux messages
              </Bouton>
              <h2>{detail.sujet || "(Sans objet)"}</h2>
              <p>
                <strong>De :</strong> {detail.expediteur}
                <br />
                <strong>À :</strong> {detail.destinataires.join(", ")}
                <br />
                {date(detail.date_envoi)}
              </p>
              <p className="courrier-texte">{detail.texte || "Ce message ne contient pas de texte lisible."}</p>
              {Array.isArray(detail.pieces) && detail.pieces.length > 0 && (
                <div>
                  <h3>Pièces jointes</h3>
                  {detail.pieces.map((p) => (
                    <p key={p.id}>
                      <a href={`/v1/courrier/pieces/${p.id}`} download>
                        {p.nom}
                      </a>{" "}
                      · {Math.ceil(p.taille / 1024)} Ko
                    </p>
                  ))}
                </div>
              )}
            </article>
          ) : (
            <div className="courrier-attente">
              <h2>Votre courrier, au même endroit</h2>
              <p>Sélectionnez un message pour le lire. Aucun contenu distant ni image de suivi n’est chargé.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

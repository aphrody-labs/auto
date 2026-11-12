// Console opérateur : santé, plans publics et, connecté au tenant opérateur (AUTO_TENANT_OPERATEUR), ses factures
// d'abonnement, puis les routes /v1/admin : entreprises, suspension, événements en échec, audit de tous les tenants.
import { api, ErreurApi, type Moi } from "@auto/client";
import { dateFr, emailValide, eur, nombre } from "@auto/ui/format";
import {
  Bandeau,
  BasculeTheme,
  Bouton,
  ChampTexte,
  EtatChargement,
  EtatErreur,
  FournisseurToasts,
  ResumeErreurs,
  appliquerTheme,
  themeEnregistre,
  useDonnees,
} from "@auto/ui/react";
import { Activity, Ban, LogIn, LogOut, RotateCcw, ShieldCheck } from "@auto/ui/symboles";
import { useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

function Connexion({ onSession }: { onSession: () => void }) {
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [defi, setDefi] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [errEmail, setErrEmail] = useState<string | null>(null);
  const [erreur, setErreur] = useState<ErreurApi | null>(null);
  const [envoi, setEnvoi] = useState(false);
  async function soumettre(e: FormEvent) {
    e.preventDefault();
    if (!emailValide(email)) return setErrEmail("Adresse e-mail invalide.");
    setErrEmail(null);
    setEnvoi(true);
    setErreur(null);
    try {
      if (defi) {
        // Second facteur (Better Auth) : code TOTP ou code de secours.
        await admin("/v1/auth/2fa", { defi, code: code.trim() });
        return onSession();
      }
      const r = (await api.connecter(email, motDePasse)) as { deuxFacteurs?: boolean; defi?: string };
      if (r.deuxFacteurs && r.defi) return setDefi(r.defi);
      onSession();
    } catch (x) {
      setErreur(x instanceof ErreurApi ? x : new ErreurApi((x as Error).message, 401));
    } finally {
      setEnvoi(false);
    }
  }
  if (defi)
    return (
      <form className="carte grille" noValidate onSubmit={soumettre} aria-labelledby="titre-connexion">
        <h2 id="titre-connexion">Double authentification</h2>
        <ResumeErreurs erreur={erreur} />
        <ChampTexte
          libelle="Code de l'application ou code de secours"
          autoComplete="one-time-code"
          requis
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div>
          <Bouton type="submit" variante="primaire" icone={ShieldCheck} chargement={envoi}>
            Valider
          </Bouton>
        </div>
      </form>
    );
  return (
    <form className="carte grille" noValidate onSubmit={soumettre} aria-labelledby="titre-connexion">
      <h2 id="titre-connexion">Connexion opérateur</h2>
      <ResumeErreurs erreur={erreur} />
      <div className="grille grille-2">
        <ChampTexte
          libelle="E-mail"
          type="email"
          autoComplete="email"
          requis
          value={email}
          erreur={errEmail}
          onChange={(e) => setEmail(e.target.value)}
        />
        <ChampTexte
          libelle="Mot de passe"
          type="password"
          autoComplete="current-password"
          requis
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
        />
      </div>
      <div>
        <Bouton type="submit" variante="primaire" icone={LogIn} chargement={envoi}>
          Se connecter
        </Bouton>
      </div>
    </form>
  );
}

interface TenantAdmin {
  id: string;
  nom: string;
  siren: string;
  plan: string;
  statut: string;
  membres: number;
  suspendu: { depuis: string; motif: string | null } | null;
}

/** Appel d'une route opérateur avec la session en cookie (mutations en JSON, comme l'exige l'anti-CSRF). */
async function admin<T>(chemin: string, corps?: unknown): Promise<T> {
  const r = await fetch(chemin, {
    method: corps === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(j?.erreur ?? `HTTP ${r.status}`);
  return j as T;
}

function Entreprises() {
  const d = useDonnees(async () => {
    const [tenants, echecs, audit] = await Promise.all([
      admin<TenantAdmin[]>("/v1/admin/tenants"),
      admin<unknown[]>("/v1/admin/evenements?statut=echec"),
      admin<{ ok: boolean }[]>("/v1/admin/audit"),
    ]);
    return { tenants, echecs: echecs.length, auditRompus: audit.filter((a) => !a.ok).length };
  });
  const [enCours, setEnCours] = useState<string | null>(null);
  const [aSuspendre, setASuspendre] = useState<TenantAdmin | null>(null);
  const [motif, setMotif] = useState("");
  const [erreurMotif, setErreurMotif] = useState<string | null>(null);
  if (d.etat === "chargement") return <EtatChargement />;
  if (d.etat === "erreur") return <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  async function envoyer(t: TenantAdmin, motif?: string) {
    setEnCours(t.id);
    setErreurMotif(null);
    try {
      await admin(`/v1/admin/tenants/${t.id}/suspension`, { suspendu: !t.suspendu, motif });
      setASuspendre(null);
      setMotif("");
      d.recharger();
    } catch (e) {
      setErreurMotif(e instanceof Error ? e.message : String(e));
    } finally {
      setEnCours(null);
    }
  }
  /** Rétablir est immédiat ; suspendre ouvre un formulaire qui exige un motif (tracé dans l'audit du tenant). */
  function basculer(t: TenantAdmin) {
    if (t.suspendu) return envoyer(t);
    setASuspendre(t);
    setErreurMotif(null);
  }
  function confirmer(e: FormEvent) {
    e.preventDefault();
    if (!aSuspendre) return;
    if (!motif.trim())
      return setErreurMotif("Indiquez le motif : il est enregistré dans le journal d'audit de l'entreprise.");
    void envoyer(aSuspendre, motif.trim());
  }
  return (
    <section className="carte pile-serree" aria-labelledby="sec-entreprises">
      <h2 id="sec-entreprises">Entreprises</h2>
      <p className="attenue">
        {nombre(d.donnees.tenants.length)} entreprises ; {nombre(d.donnees.echecs)} événements en échec ;{" "}
        {d.donnees.auditRompus
          ? `${nombre(d.donnees.auditRompus)} journaux d'audit rompus`
          : "tous les journaux d'audit sont intègres"}
        .
      </p>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead>
            <tr>
              <th scope="col">Entreprise</th>
              <th scope="col">SIREN</th>
              <th scope="col">Plan</th>
              <th scope="col" className="num">
                Membres
              </th>
              <th scope="col">État</th>
              <th scope="col">
                <span className="visuellement-cache">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {d.donnees.tenants.map((t) => (
              <tr key={t.id}>
                <td data-libelle="Entreprise">{t.nom}</td>
                <td data-libelle="SIREN" className="chiffres">
                  {t.siren}
                </td>
                <td data-libelle="Plan">
                  {t.plan} ({t.statut})
                </td>
                <td data-libelle="Membres" className="num">
                  {nombre(t.membres)}
                </td>
                <td data-libelle="État">{t.suspendu ? `Suspendue : ${t.suspendu.motif ?? ""}` : "Active"}</td>
                <td data-libelle="Action">
                  <Bouton
                    variante="secondaire"
                    icone={t.suspendu ? RotateCcw : Ban}
                    chargement={enCours === t.id}
                    onClick={() => basculer(t)}
                  >
                    {t.suspendu ? "Rétablir" : "Suspendre"}
                  </Bouton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {aSuspendre && (
        <form className="pile-serree" onSubmit={confirmer} aria-labelledby="titre-suspension">
          <h3 id="titre-suspension">Suspendre « {aSuspendre.nom} »</h3>
          <p className="attenue">Les membres ne pourront plus se connecter ; les données restent intactes.</p>
          <ChampTexte
            libelle="Motif de la suspension"
            requis
            autoFocus
            value={motif}
            erreur={erreurMotif ?? undefined}
            onChange={(e) => setMotif(e.target.value)}
          />
          <div className="rangee">
            <Bouton type="submit" variante="danger" icone={Ban} chargement={enCours === aSuspendre.id}>
              Suspendre
            </Bouton>
            <Bouton type="button" variante="secondaire" onClick={() => setASuspendre(null)}>
              Annuler
            </Bouton>
          </div>
        </form>
      )}
    </section>
  );
}

function Operateur({ moi }: { moi: Moi }) {
  const d = useDonnees(async () => {
    const [factures, audit] = await Promise.all([api.documents("facture"), api.verifierAudit()]);
    return { factures, audit };
  });
  if (d.etat === "chargement") return <EtatChargement />;
  if (d.etat === "erreur") return <EtatErreur message={d.erreur} onReessayer={d.recharger} />;
  const emises = d.donnees.factures.filter((f) => f.statut !== "brouillon");
  const total = emises.reduce((s, f) => s + f.htCents, 0);
  return (
    <>
      <section className="carte pile-serree" aria-labelledby="sec-factures">
        <h2 id="sec-factures">Factures émises par {moi.entreprise.nom}</h2>
        <p className="attenue">
          {nombre(emises.length)} factures, {eur(total)} HT. Pour le tenant opérateur, ce sont les factures d'abonnement
          émises en Factur-X.
        </p>
        {emises.length > 0 && (
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead>
                <tr>
                  <th scope="col">Numéro</th>
                  <th scope="col">Client</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="num">
                    TTC
                  </th>
                  <th scope="col">Statut</th>
                </tr>
              </thead>
              <tbody>
                {emises.map((f) => (
                  <tr key={f.id}>
                    <td data-libelle="Numéro" className="chiffres">
                      {f.numero}
                    </td>
                    <td data-libelle="Client">{f.data.client.nom}</td>
                    <td data-libelle="Date" className="num">
                      {dateFr(f.data.date)}
                    </td>
                    <td data-libelle="TTC" className="num">
                      {eur(f.ttcCents)}
                    </td>
                    <td data-libelle="Statut">{f.statut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Bandeau
        ton={d.donnees.audit.ok ? "succes" : "erreur"}
        titre={d.donnees.audit.ok ? "Journal d'audit intègre" : "Journal d'audit rompu"}
      >
        <p>
          <ShieldCheck className="icone icone-sm" aria-hidden="true" /> {nombre(d.donnees.audit.entrees)} entrées
          vérifiées pour ce tenant.
        </p>
      </Bandeau>
    </>
  );
}

interface Utilisateur {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  twoFactorEnabled?: boolean | null;
  createdAt: string;
}

/** Appel du plugin admin de Better Auth (rôle global `admin` des owner et admin du tenant opérateur). */
async function adminAuth<T>(chemin: string, corps?: unknown): Promise<T> {
  const r = await fetch(`/api/auth/admin/${chemin}`, {
    method: corps === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`);
  return j as T;
}

/** Comptes de toutes les entreprises : recherche, suspension (bannissement) et fermeture des sessions. */
function Utilisateurs() {
  const [recherche, setRecherche] = useState("");
  const [filtre, setFiltre] = useState("");
  const d = useDonnees(() => {
    const q = new URLSearchParams({ limit: "50", sortBy: "createdAt", sortDirection: "desc" });
    if (filtre) {
      q.set("searchField", "email");
      q.set("searchOperator", "contains");
      q.set("searchValue", filtre);
    }
    return adminAuth<{ users: Utilisateur[]; total: number }>(`list-users?${q}`);
  }, [filtre]);
  const [enCours, setEnCours] = useState<string | null>(null);
  async function agir(u: Utilisateur, f: () => Promise<unknown>) {
    setEnCours(u.id);
    try {
      await f();
      d.recharger();
    } finally {
      setEnCours(null);
    }
  }
  return (
    <section className="carte pile-serree" aria-labelledby="sec-utilisateurs">
      <h2 id="sec-utilisateurs">Utilisateurs</h2>
      <form
        className="rangee rangee-bas"
        onSubmit={(e) => {
          e.preventDefault();
          setFiltre(recherche.trim());
        }}
      >
        <ChampTexte
          libelle="Adresse e-mail contient"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />
        <Bouton type="submit">Chercher</Bouton>
      </form>
      {d.etat === "chargement" && <EtatChargement lignes={2} />}
      {d.etat === "erreur" && <EtatErreur message={d.erreur} onReessayer={d.recharger} />}
      {d.etat === "ok" && (
        <div className="tableau-conteneur">
          <table className="tableau">
            <thead>
              <tr>
                <th scope="col">Compte</th>
                <th scope="col">2FA</th>
                <th scope="col">État</th>
                <th scope="col">
                  <span className="visuellement-cache">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.donnees.users.map((u) => (
                <tr key={u.id}>
                  <td data-libelle="Compte">
                    {u.email} {u.role === "admin" && <strong>(opérateur)</strong>}
                  </td>
                  <td data-libelle="2FA">{u.twoFactorEnabled ? "active" : "—"}</td>
                  <td data-libelle="État">
                    {u.banned ? `suspendu${u.banReason ? ` : ${u.banReason}` : ""}` : "actif"}
                  </td>
                  <td data-libelle="Actions">
                    <div className="rangee">
                      <Bouton
                        variante={u.banned ? "secondaire" : "danger"}
                        icone={Ban}
                        chargement={enCours === u.id}
                        onClick={() =>
                          agir(u, () =>
                            u.banned
                              ? adminAuth("unban-user", { userId: u.id })
                              : adminAuth("ban-user", { userId: u.id, banReason: "suspendu par l'opérateur" }),
                          )
                        }
                      >
                        {u.banned ? "Rétablir" : "Suspendre"}
                      </Bouton>
                      <Bouton
                        variante="fantome"
                        icone={LogOut}
                        chargement={enCours === u.id}
                        onClick={() => agir(u, () => adminAuth("revoke-user-sessions", { userId: u.id }))}
                      >
                        Fermer ses sessions
                      </Bouton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="attenue petit">{nombre(d.donnees.total)} comptes au total.</p>
        </div>
      )}
    </section>
  );
}

function Console() {
  const sante = useDonnees(async () => (await fetch("/health")).ok);
  const plans = useDonnees(() => api.plans());
  const session = useDonnees<Moi | null>(() =>
    api.moi().catch((e) => {
      if (e instanceof ErreurApi && e.status === 401) return null;
      throw e;
    }),
  );

  return (
    <main className="console" id="contenu">
      <div className="console-entete">
        <h1>Console opérateur</h1>
        <BasculeTheme />
        {session.etat === "ok" && session.donnees && (
          <Bouton
            variante="fantome"
            icone={LogOut}
            onClick={async () => {
              await api.deconnecter().catch(() => {});
              session.recharger();
            }}
          >
            Se déconnecter
          </Bouton>
        )}
      </div>

      <section className="carte pile-serree" aria-labelledby="sec-sante">
        <h2 id="sec-sante">Santé de l'API</h2>
        {sante.etat === "chargement" && <EtatChargement lignes={1} />}
        {sante.etat !== "chargement" && (
          <Bandeau
            ton={sante.donnees ? "succes" : "erreur"}
            titre={sante.donnees ? "API joignable" : "API injoignable"}
          >
            <p>
              <Activity className="icone icone-sm" aria-hidden="true" /> <code>GET /health</code>
            </p>
          </Bandeau>
        )}
      </section>

      <section className="carte pile-serree" aria-labelledby="sec-plans">
        <h2 id="sec-plans">Plans publiés</h2>
        {plans.etat === "chargement" && <EtatChargement lignes={2} />}
        {plans.etat === "erreur" && <EtatErreur message={plans.erreur} onReessayer={plans.recharger} />}
        {plans.etat === "ok" && (
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col" className="num">
                    Mensuel HT
                  </th>
                  <th scope="col" className="num">
                    Annuel HT
                  </th>
                  <th scope="col" className="num">
                    Essai
                  </th>
                  <th scope="col" className="num">
                    Factures par mois
                  </th>
                </tr>
              </thead>
              <tbody>
                {plans.donnees.map((p) => (
                  <tr key={p.id}>
                    <td data-libelle="Plan">{p.nom}</td>
                    <td data-libelle="Mensuel HT" className="num">
                      {eur(p.prixHtCents.mensuel)}
                    </td>
                    <td data-libelle="Annuel HT" className="num">
                      {eur(p.prixHtCents.annuel)}
                    </td>
                    <td data-libelle="Essai" className="num">
                      {p.essaiJours ? `${nombre(p.essaiJours)} jours` : "—"}
                    </td>
                    <td data-libelle="Factures par mois" className="num">
                      {p.quotas.factures === null ? "illimité" : nombre(p.quotas.factures ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {session.etat === "chargement" && <EtatChargement lignes={2} />}
      {session.etat === "erreur" && <EtatErreur message={session.erreur} onReessayer={session.recharger} />}
      {session.etat === "ok" && !session.donnees && <Connexion onSession={session.recharger} />}
      {session.etat === "ok" && session.donnees && <Operateur moi={session.donnees} />}
      {session.etat === "ok" && session.donnees && <Entreprises />}
      {session.etat === "ok" && session.donnees && <Utilisateurs />}
    </main>
  );
}

appliquerTheme(themeEnregistre());
createRoot(document.getElementById("racine")!).render(
  <FournisseurToasts>
    <Console />
  </FournisseurToasts>,
);

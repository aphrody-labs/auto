import {
  ArrowLeftRight,
  CalendarDays,
  FileInput,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  ReceiptText,
  Settings,
  Search,
  Undo2,
  Users,
  UserRound,
  Workflow,
  X,
} from "@auto/ui/symboles";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ErreurApi, type Moi } from "@auto/client";
import { grouperSiret } from "@auto/ui/format";
import { accesSegment, pagePermise, LIBELLES_SEGMENTS, segmentsDe } from "@auto/tenancy/segments";
import { useSession } from "./session";
import { Connexion, retourSur } from "./ecrans/connexion";
import { Marque } from "./ecrans/marque";
import { authClient } from "./auth";

// Écrans chargés à la demande (découpage du bundle) : seule la connexion fait partie du premier chargement.
const Absences = lazy(() => import("./ecrans/absences").then((m) => ({ default: m.Absences })));
const EditeurAutomatisation = lazy(() =>
  import("./ecrans/automatisations/editeur").then((m) => ({ default: m.EditeurAutomatisation })),
);
const ExecutionsAutomatisation = lazy(() =>
  import("./ecrans/automatisations/executions").then((m) => ({ default: m.ExecutionsAutomatisation })),
);
const Automatisations = lazy(() =>
  import("./ecrans/automatisations/liste").then((m) => ({ default: m.Automatisations })),
);
const Clients = lazy(() => import("./ecrans/clients").then((m) => ({ default: m.Clients })));
const Courrier = lazy(() => import("./ecrans/courrier").then((m) => ({ default: m.Courrier })));
const Administration = lazy(() => import("./ecrans/administration").then((m) => ({ default: m.Administration })));
const VerificationAppareil = lazy(() => import("./ecrans/appareil").then((m) => ({ default: m.VerificationAppareil })));
const Chantiers = lazy(() => import("./ecrans/chantiers").then((m) => ({ default: m.Chantiers })));
const DetailChantier = lazy(() => import("./ecrans/chantiers").then((m) => ({ default: m.DetailChantier })));
const DetailFournisseur = lazy(() => import("./ecrans/chantiers").then((m) => ({ default: m.DetailFournisseur })));
const Fournisseurs = lazy(() => import("./ecrans/chantiers").then((m) => ({ default: m.Fournisseurs })));
const PiecesChantier = lazy(() => import("./ecrans/pieces-chantier").then((m) => ({ default: m.PiecesChantier })));
const RechercheGestion = lazy(() =>
  import("./ecrans/recherche-gestion").then((m) => ({ default: m.RechercheGestion })),
);
const SourcesFichiers = lazy(() => import("./ecrans/arrivages").then((m) => ({ default: m.SourcesFichiers })));
const FichiersIndexes = lazy(() => import("./ecrans/arrivages").then((m) => ({ default: m.FichiersIndexes })));
const DevisRecus = lazy(() => import("./ecrans/arrivages").then((m) => ({ default: m.DevisRecus })));
const Atelier = lazy(() => import("./ecrans/atelier").then((m) => ({ default: m.Atelier })));
const EditeurAtelier = lazy(() => import("./ecrans/atelier").then((m) => ({ default: m.EditeurAtelier })));
const Autorisation = lazy(() => import("./ecrans/autorisation").then((m) => ({ default: m.Autorisation })));
const Invitation = lazy(() => import("./ecrans/invitation").then((m) => ({ default: m.Invitation })));
const DetailDocument = lazy(() => import("./ecrans/detail").then((m) => ({ default: m.DetailDocument })));
const Editeur = lazy(() => import("./ecrans/editeur").then((m) => ({ default: m.Editeur })));
const Employes = lazy(() => import("./ecrans/employes").then((m) => ({ default: m.Employes })));
const Exports = lazy(() => import("./ecrans/exports").then((m) => ({ default: m.Exports })));
const FacturesRecues = lazy(() => import("./ecrans/recues").then((m) => ({ default: m.FacturesRecues })));
const Imports = lazy(() => import("./ecrans/imports").then((m) => ({ default: m.Imports })));
const ListeDocuments = lazy(() => import("./ecrans/liste").then((m) => ({ default: m.ListeDocuments })));
const Onboarding = lazy(() => import("./ecrans/onboarding").then((m) => ({ default: m.Onboarding })));
const Parametres = lazy(() => import("./ecrans/parametres").then((m) => ({ default: m.Parametres })));
const Produits = lazy(() => import("./ecrans/produits").then((m) => ({ default: m.Produits })));
const TableauDeBord = lazy(() => import("./ecrans/tableau").then((m) => ({ default: m.TableauDeBord })));
import { ContexteSession, peut } from "./session";
import {
  BasculeTheme,
  Bouton,
  EtatChargement,
  EtatErreur,
  EtatVide,
  FournisseurToasts,
  Lien,
  correspond,
  naviguer,
  useChemin,
  useTitrePage,
  type Etat,
} from "@auto/ui/react";

const PUBLIQUES = ["/app/connexion", "/app/inscription", "/app/invitation"];

function Navigation({ moi, ouverte, fermer }: { moi: Moi; ouverte: boolean; fermer: () => void }) {
  const rh = peut(moi.role, "rh");
  const lien = (href: string, Icone: typeof FileText, texte: string) =>
    pagePermise(moi, href) ? (
      <Lien className="nav-lien" href={href} onClick={fermer}>
        <Icone className="icone" aria-hidden="true" />
        {texte}
      </Lien>
    ) : null;
  return (
    <nav className="navigation" id="navigation" aria-label="Navigation principale" data-ouverte={ouverte}>
      <Marque />
      {lien("/app", LayoutDashboard, "Tableau de bord")}
      {lien("/app/courrier", Inbox, "Ma boîte unifiée")}
      {accesSegment(moi, "clients") && <p className="nav-titre">Ventes</p>}
      {lien("/app/devis", FileText, "Devis")}
      {lien("/app/factures", ReceiptText, "Factures")}
      {lien("/app/avoirs", Undo2, "Avoirs")}
      {lien("/app/clients", Users, "Clients")}
      {lien("/app/produits", Package, "Produits")}
      {accesSegment(moi, "fournisseurs") && <p className="nav-titre">Achats</p>}
      {lien("/app/achats", Inbox, "Factures reçues")}
      {lien("/app/fournisseurs", Users, "Fournisseurs")}
      {lien("/app/devis-recus", FileInput, "Devis reçus")}
      {["chantiers", "livraisons", "commandes"].some((s) =>
        segmentsDe(moi).includes(s as "chantiers" | "livraisons" | "commandes"),
      ) && <p className="nav-titre">Chantiers</p>}
      {lien("/app/chantiers", Package, "Chantiers et analytique")}
      {lien("/app/livraisons", FileInput, "Bons de livraison")}
      {lien("/app/commandes", FileText, "Confirmations de commande")}
      {rh && (
        <>
          <p className="nav-titre">Équipe</p>
          {lien("/app/employes", UserRound, "Employés")}
          {lien("/app/absences", CalendarDays, "Absences")}
        </>
      )}
      <p className="nav-titre">Données</p>
      {lien("/app/recherche", Search, "Rechercher un document")}
      {lien("/app/atelier", FileText, "Word, Excel et PDF")}
      {lien("/app/fichiers", FileInput, "Fichiers et dossiers")}
      {lien("/app/sources-fichiers", Settings, "Serveur de fichiers")}
      {lien("/app/imports", FileInput, "Imports")}
      {lien("/app/exports", ArrowLeftRight, "Exports")}
      {lien("/app/automatisations", Workflow, "Automatisations")}
      <div className="nav-pied">
        <div className="nav-entreprise">
          {moi.entreprises.length > 1 ? (
            <label>
              <span className="visuellement-cache">Entreprise active</span>
              <select
                value={moi.tenantId}
                onChange={async (e) => {
                  await authClient.organization.setActive({ organizationId: e.target.value });
                  location.assign("/app");
                }}
              >
                {moi.entreprises.map((x) => (
                  <option key={x.id} value={x.id} disabled={x.suspendue}>
                    {x.nom}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <strong>{moi.entreprise.nom}</strong>
          )}
          <span className="attenue chiffres">SIRET {grouperSiret(moi.entreprise.siret)}</span>
        </div>
        {lien("/app/parametres", Settings, "Paramètres")}
        <BasculeTheme avecLibelle />
        <Bouton
          variante="fantome"
          icone={LogOut}
          onClick={async () => {
            await authClient.signOut().catch(() => {});
            location.assign("/app/connexion");
          }}
        >
          Se déconnecter
        </Bouton>
      </div>
    </nav>
  );
}

function PageIntrouvable() {
  useTitrePage("Page introuvable");
  return (
    <div className="page">
      <h1 className="visuellement-cache">Page introuvable</h1>
      <EtatVide titre="Page introuvable">
        <Lien className="bouton" href="/app">
          Retour au tableau de bord
        </Lien>
      </EtatVide>
    </div>
  );
}

function Routes({ chemin }: { chemin: string }) {
  const { moi } = useSession();
  const p = chemin.split("?")[0]!;
  if (!pagePermise(moi, p))
    return (
      <div className="page">
        <h1>Accès restreint</h1>
        <EtatVide titre="Ce segment ne vous est pas attribué">
          <Lien href="/app">Ouvrir mon espace</Lien>
        </EtatVide>
      </div>
    );
  if ((p === "/app" || p === "/app/") && !accesSegment(moi, "clients"))
    return (
      <div className="page pile">
        <h1>Mon espace de travail</h1>
        <p>Vos segments accessibles.</p>
        {segmentsDe(moi).map((s) => (
          <Lien
            key={s}
            className="bouton"
            href={
              {
                clients: "/app/clients",
                fournisseurs: "/app/fournisseurs",
                chantiers: "/app/chantiers",
                livraisons: "/app/livraisons",
                commandes: "/app/commandes",
              }[s]
            }
          >
            {LIBELLES_SEGMENTS[s]}
          </Lien>
        ))}
      </div>
    );
  let m: Record<string, string> | null;
  if (p === "/app" || p === "/app/") return <TableauDeBord />;
  if (p === "/app/devis") return <ListeDocuments key="devis" types={["devis"]} />;
  if (p === "/app/factures") return <ListeDocuments key="factures" types={["facture", "acompte"]} />;
  if (p === "/app/avoirs") return <ListeDocuments key="avoirs" types={["avoir"]} />;
  if (p === "/app/documents/nouveau") return <Editeur key={chemin} />;
  if ((m = correspond("/app/documents/:id", p))) return <DetailDocument key={m.id} id={m.id!} />;
  if ((m = correspond("/app/documents/:id/modifier", p))) return <Editeur key={m.id} id={m.id} />;
  if (p === "/app/clients") return <Clients />;
  if (p === "/app/fournisseurs") return <Fournisseurs />;
  if ((m = correspond("/app/fournisseurs/:id", p))) return <DetailFournisseur key={m.id} id={m.id!} />;
  if (p === "/app/chantiers") return <Chantiers />;
  if ((m = correspond("/app/chantiers/:id", p))) return <DetailChantier key={m.id} id={m.id!} />;
  if (p === "/app/pieces") return <PiecesChantier />;
  if (p === "/app/livraisons") return <PiecesChantier key="livraisons" typePiece="bon_livraison" />;
  if (p === "/app/commandes") return <PiecesChantier key="commandes" typePiece="confirmation_commande" />;
  if (p === "/app/recherche") return <RechercheGestion />;
  if (p === "/app/sources-fichiers") return <SourcesFichiers />;
  if (p === "/app/fichiers") return <FichiersIndexes />;
  if (p === "/app/devis-recus") return <DevisRecus />;
  if (p === "/app/atelier") return <Atelier />;
  if ((m = correspond("/app/atelier/:id", p))) return <EditeurAtelier key={m.id} id={m.id!} />;
  if (p === "/app/produits") return <Produits />;
  if (p === "/app/achats") return <FacturesRecues />;
  if (p === "/app/employes") return <Employes />;
  if ((m = correspond("/app/employes/:id", p))) return <Employes key={m.id} id={m.id} />;
  if (p === "/app/absences") return <Absences />;
  if (p === "/app/imports") return <Imports />;
  if (p === "/app/exports") return <Exports />;
  if (p === "/app/automatisations") return <Automatisations />;
  if (p === "/app/automatisations/nouveau") return <EditeurAutomatisation key={chemin} />;
  if ((m = correspond("/app/automatisations/:id", p))) return <EditeurAutomatisation key={m.id} id={m.id} />;
  if ((m = correspond("/app/automatisations/:id/executions", p)))
    return <ExecutionsAutomatisation key={m.id} id={m.id!} />;
  if (p === "/app/parametres") return <Parametres />;
  return <PageIntrouvable />;
}

function Coque({ moi, children }: { moi: Moi; children: ReactNode }) {
  const [ouverte, setOuverte] = useState(false);
  useEffect(() => {
    if (!ouverte) return;
    const navigation = document.getElementById("navigation");
    const precedent = document.activeElement as HTMLElement | null;
    const ancienDebordement = document.body.style.overflow;
    const media = matchMedia("(min-width: 1024px)");
    const fermer = () => setOuverte(false);
    const clavier = (e: KeyboardEvent) => {
      if (e.key === "Escape") fermer();
      if (e.key !== "Tab") return;
      const elements = Array.from(navigation?.querySelectorAll<HTMLElement>("a[href], button, select") ?? []).filter(
        (element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0,
      );
      const premier = elements[0];
      const dernier = elements.at(-1);
      if (e.shiftKey && document.activeElement === premier) {
        e.preventDefault();
        dernier?.focus();
      } else if (!e.shiftKey && document.activeElement === dernier) {
        e.preventDefault();
        premier?.focus();
      }
    };
    if (media.matches) {
      fermer();
      return;
    }
    document.body.style.overflow = "hidden";
    navigation?.querySelector<HTMLElement>(".nav-lien")?.focus();
    document.addEventListener("keydown", clavier);
    media.addEventListener("change", fermer);
    return () => {
      document.body.style.overflow = ancienDebordement;
      document.removeEventListener("keydown", clavier);
      media.removeEventListener("change", fermer);
      precedent?.focus();
    };
  }, [ouverte]);
  return (
    <div className="coque">
      <a className="lien-evitement" href="#contenu">
        Aller au contenu
      </a>
      <header className="barre-haut">
        <Bouton
          variante="fantome"
          icone={ouverte ? X : Menu}
          aria-label={ouverte ? "Fermer le menu" : "Ouvrir le menu"}
          aria-expanded={ouverte}
          aria-controls="navigation"
          onClick={() => setOuverte(!ouverte)}
        />
        <Marque />
      </header>
      <Navigation moi={moi} ouverte={ouverte} fermer={() => setOuverte(false)} />
      <main className="principal" id="contenu" tabIndex={-1} inert={ouverte}>
        <Suspense fallback={<EtatChargement libelle="Chargement de l’écran" />}>{children}</Suspense>
      </main>
    </div>
  );
}

/**
 * Session courante (`/v1/moi`) : `recharger` attend la nouvelle réponse, pour qu'une navigation qui suit une
 * connexion ou une inscription ne parte jamais d'une session périmée.
 */
function useSessionApi() {
  const [etat, setEtat] = useState<Etat<Moi | null>>({ etat: "chargement" });
  const [sansEntreprise, setSansEntreprise] = useState(false);
  const lecture = useRef(0);
  const recharger = useCallback(async () => {
    const numero = ++lecture.current;
    // Cet appel public reçoit les Set-Cookie officiels de renouvellement, avant la lecture métier.
    const courante = await authClient.getSession().catch(() => null);
    // Aucune session Better Auth (réponse 200 sans données) : pas de lecture /v1/moi vouée au 401.
    if (courante && !courante.error && !courante.data) {
      if (numero !== lecture.current) return;
      setSansEntreprise(false);
      setEtat({ etat: "ok", donnees: null });
      return;
    }
    try {
      const moi = await api.moi();
      if (numero !== lecture.current) return;
      setEtat({ etat: "ok", donnees: moi });
      setSansEntreprise(false);
    } catch (e) {
      if (numero !== lecture.current) return;
      if (e instanceof ErreurApi && e.status === 401) {
        // Session ouverte (lien magique, Google…) mais aucune entreprise : inscription de l'entreprise.
        setSansEntreprise(!!courante?.data);
        setEtat({ etat: "ok", donnees: null });
      } else setEtat({ etat: "erreur", erreur: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void recharger();
    const reprendre = () => {
      if (document.visibilityState === "visible") void recharger();
    };
    window.addEventListener("focus", reprendre);
    document.addEventListener("visibilitychange", reprendre);
    return () => {
      window.removeEventListener("focus", reprendre);
      document.removeEventListener("visibilitychange", reprendre);
    };
  }, [recharger]);
  return { ...etat, recharger, sansEntreprise };
}

export function App() {
  const chemin = useChemin();
  const publique = PUBLIQUES.some((p) => chemin.startsWith(p));
  const session = useSessionApi();
  const recharger = session.recharger;

  useEffect(() => {
    if (chemin.startsWith("/app/connexion") && session.etat === "ok" && (session.donnees || session.sansEntreprise)) {
      const retour = retourSur(new URLSearchParams(location.search).get("retour"));
      naviguer(retour.startsWith("/app/connexion") ? "/app" : retour, true);
      return;
    }
    if (session.etat === "ok" && !session.donnees && !publique && !session.sansEntreprise) {
      const retour = encodeURIComponent(chemin);
      naviguer(`/app/connexion?retour=${retour}`, true);
    }
  }, [session.etat, session.donnees, session.sansEntreprise, publique, chemin]);

  let contenu: ReactNode;
  if (chemin.startsWith("/app/inscription")) contenu = <Onboarding onSession={recharger} />;
  else if (chemin.startsWith("/app/connexion")) contenu = <Connexion onSession={recharger} />;
  else if (chemin.startsWith("/app/invitation")) contenu = <Invitation onSession={recharger} />;
  else if (
    chemin.split("?")[0] === "/app/verification-appareil" &&
    session.etat === "ok" &&
    (session.sansEntreprise || session.donnees)
  )
    contenu = <VerificationAppareil />;
  else if (
    chemin.split("?")[0] === "/app/administration" &&
    session.etat === "ok" &&
    (session.sansEntreprise || session.donnees)
  )
    contenu = <Administration />;
  else if ((chemin === "/app" || chemin === "/app/") && session.etat === "ok" && session.sansEntreprise)
    contenu = <Courrier />;
  else if (
    chemin.split("?")[0] === "/app/courrier" &&
    session.etat === "ok" &&
    (session.sansEntreprise || session.donnees)
  )
    contenu = <Courrier />;
  else if (session.etat === "ok" && session.sansEntreprise) contenu = <Onboarding onSession={recharger} connecte />;
  else if (chemin.startsWith("/app/autorisation") && session.etat === "ok" && session.donnees)
    contenu = <Autorisation />;
  else if (session.etat === "chargement")
    contenu = (
      <div className="auth">
        <div className="auth-carte">
          <EtatChargement libelle="Ouverture de la session" />
        </div>
      </div>
    );
  else if (session.etat === "erreur")
    contenu = (
      <div className="auth">
        <EtatErreur message={session.erreur} onReessayer={session.recharger} />
      </div>
    );
  else if (!session.donnees) contenu = null;
  else
    contenu = (
      <ContexteSession.Provider value={{ moi: session.donnees, recharger }}>
        <Coque moi={session.donnees}>
          <Routes chemin={chemin} />
        </Coque>
      </ContexteSession.Provider>
    );

  return (
    <FournisseurToasts>
      <Suspense
        fallback={
          <div className="auth">
            <div className="auth-carte">
              <EtatChargement libelle="Chargement" />
            </div>
          </div>
        }
      >
        {contenu}
      </Suspense>
    </FournisseurToasts>
  );
}

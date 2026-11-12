// Composants propres à auto sur les jetons @auto/ui (rôles M3) ; les composants Material génériques
// viennent de @aphrody/m3-react (apps/web), voir docs/UI.md.
import type { StatutVisuel } from "@auto/ui";
import {
  Ban,
  Banknote,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClockAlert,
  FileCheck,
  Inbox,
  Monitor,
  Moon,
  Pencil,
  RotateCcw,
  Send,
  Sun,
  TriangleAlert,
  Upload,
  X,
  type Symbole,
} from "./symboles";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export type Variante = "primaire" | "secondaire" | "danger" | "fantome";

export function Bouton({
  variante = "secondaire",
  chargement = false,
  icone: Icone,
  plein,
  className,
  children,
  disabled,
  type = "button",
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variante?: Variante;
  chargement?: boolean;
  icone?: Symbole;
  plein?: boolean;
}) {
  const classes = [
    "bouton",
    variante !== "secondaire" && `bouton-${variante}`,
    !children && "bouton-icone",
    plein && "bouton-plein",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || chargement}
      aria-busy={chargement || undefined}
      {...p}
    >
      {chargement ? (
        <span className="indicateur" aria-hidden="true" />
      ) : (
        Icone && <Icone className="icone" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

interface ProprietesChamp {
  libelle: string;
  aide?: string;
  erreur?: string | null;
  requis?: boolean;
}

function Enveloppe({
  id,
  libelle,
  aide,
  erreur,
  requis,
  children,
  className,
}: ProprietesChamp & { id: string; children: ReactNode; className?: string }) {
  return (
    <div className={`champ ${className ?? ""}`}>
      <label htmlFor={id}>
        {libelle}
        {requis && (
          <>
            {" "}
            <span className="requis" aria-hidden="true">
              *
            </span>
            <span className="visuellement-cache"> (obligatoire)</span>
          </>
        )}
      </label>
      {children}
      {aide && (
        <span id={`${id}-aide`} className="aide">
          {aide}
        </span>
      )}
      {erreur && (
        <span id={`${id}-erreur`} className="erreur-champ">
          <CircleAlert className="icone icone-sm" aria-hidden="true" />
          {erreur}
        </span>
      )}
    </div>
  );
}

const decrit = (id: string, aide?: string, erreur?: string | null) =>
  [aide && `${id}-aide`, erreur && `${id}-erreur`].filter(Boolean).join(" ") || undefined;

export function ChampTexte({
  libelle,
  aide,
  erreur,
  requis,
  className,
  id: idFourni,
  ...p
}: ProprietesChamp & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = idFourni ?? auto;
  return (
    <Enveloppe id={id} libelle={libelle} aide={aide} erreur={erreur} requis={requis} className={className}>
      <input
        id={id}
        className={`controle ${p.inputMode === "decimal" ? "num" : ""}`}
        required={requis}
        aria-invalid={erreur ? true : undefined}
        aria-describedby={decrit(id, aide, erreur)}
        {...p}
      />
    </Enveloppe>
  );
}

export function ChampListe({
  libelle,
  aide,
  erreur,
  requis,
  className,
  children,
  id: idFourni,
  ...p
}: ProprietesChamp & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const id = idFourni ?? auto;
  return (
    <Enveloppe id={id} libelle={libelle} aide={aide} erreur={erreur} requis={requis} className={className}>
      <select
        id={id}
        className="controle"
        required={requis}
        aria-invalid={erreur ? true : undefined}
        aria-describedby={decrit(id, aide, erreur)}
        {...p}
      >
        {children}
      </select>
    </Enveloppe>
  );
}

export function ChampZone({
  libelle,
  aide,
  erreur,
  requis,
  className,
  id: idFourni,
  ...p
}: ProprietesChamp & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = idFourni ?? auto;
  return (
    <Enveloppe id={id} libelle={libelle} aide={aide} erreur={erreur} requis={requis} className={className}>
      <textarea
        id={id}
        className="controle"
        required={requis}
        aria-invalid={erreur ? true : undefined}
        aria-describedby={decrit(id, aide, erreur)}
        {...p}
      />
    </Enveloppe>
  );
}

const ICONES_STATUT: Record<StatutVisuel, Symbole> = {
  brouillon: Pencil,
  emis: FileCheck,
  envoye: Send,
  accepte: CircleCheck,
  refuse: CircleX,
  depose: Upload,
  rejete: TriangleAlert,
  paye: Banknote,
  annule: Ban,
  en_retard: ClockAlert,
};

/** Badge : pictogramme + libellé ; la couleur ne porte jamais seule le statut. */
export function BadgeStatut({ statut, libelle }: { statut: StatutVisuel; libelle: string }) {
  const Icone = ICONES_STATUT[statut];
  const nom = statut.replace("_", "-");
  return (
    <span
      className="badge"
      data-statut={statut}
      style={
        {
          "--texte": `var(--auto-statut-${nom}-texte)`,
          "--fond": `var(--auto-statut-${nom}-fond)`,
        } as React.CSSProperties
      }
    >
      <Icone className="icone icone-sm" aria-hidden="true" />
      <span className="visuellement-cache">Statut : </span>
      {libelle}
    </span>
  );
}

export function Bandeau({
  ton = "info",
  titre,
  children,
  focaliser,
}: {
  ton?: "info" | "erreur" | "avertissement" | "succes";
  titre?: string;
  children?: ReactNode;
  /** Résumé d'erreurs : reçoit le focus à l'affichage. */
  focaliser?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focaliser) ref.current?.focus();
  }, [focaliser, titre]);
  const Icone =
    ton === "erreur" ? CircleAlert : ton === "avertissement" ? TriangleAlert : ton === "succes" ? CircleCheck : Inbox;
  return (
    <div
      ref={ref}
      className={`bandeau ${ton !== "info" ? `bandeau-${ton}` : ""}`}
      role={ton === "erreur" ? "alert" : undefined}
      tabIndex={focaliser ? -1 : undefined}
    >
      <Icone className="icone" aria-hidden="true" />
      <div>
        {titre && <strong>{titre}</strong>}
        {children}
      </div>
    </div>
  );
}

/** Erreurs de l'API : message et détails (mentions manquantes, lignes invalides). */
export function ResumeErreurs({ erreur }: { erreur: { message: string; details?: string[] } | null }) {
  if (!erreur) return null;
  return (
    <Bandeau ton="erreur" titre={erreur.message} focaliser>
      {erreur.details && erreur.details.length > 0 && (
        <ul>
          {erreur.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </Bandeau>
  );
}

export function EtatVide({
  icone: Icone = Inbox,
  titre,
  children,
}: {
  icone?: Symbole;
  titre: string;
  children?: ReactNode;
}) {
  return (
    <div className="etat">
      <Icone className="icone" aria-hidden="true" />
      <h2>{titre}</h2>
      {children}
    </div>
  );
}

export function EtatChargement({ lignes = 4, libelle = "Chargement" }: { lignes?: number; libelle?: string }) {
  return (
    <div className="pile" role="status" aria-live="polite">
      <span className="visuellement-cache">{libelle}…</span>
      {Array.from({ length: lignes }, (_, i) => (
        <div key={i} className="squelette" style={{ height: 40, width: `${100 - i * 8}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

export function EtatErreur({ message, onReessayer }: { message: string; onReessayer?: () => void }) {
  return (
    <div className="etat" role="alert">
      <CircleAlert className="icone" aria-hidden="true" />
      <h2>Chargement impossible</h2>
      <p>{message}</p>
      {onReessayer && (
        <Bouton icone={RotateCcw} onClick={onReessayer}>
          Réessayer
        </Bouton>
      )}
    </div>
  );
}

/** Modale native : `showModal()` piège le focus, Échap ferme, le focus revient au déclencheur. */
export function Modale({
  ouverte,
  titre,
  onFermer,
  children,
  pied,
}: {
  ouverte: boolean;
  titre: string;
  onFermer: () => void;
  children: ReactNode;
  pied?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titreId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (ouverte && !d.open) d.showModal();
    if (!ouverte && d.open) d.close();
  }, [ouverte]);
  return (
    <dialog
      ref={ref}
      className="modale"
      aria-labelledby={titreId}
      onClose={onFermer}
      onCancel={(e) => {
        e.preventDefault();
        onFermer();
      }}
    >
      {ouverte && (
        <>
          <div className="modale-entete">
            <h2 id={titreId}>{titre}</h2>
            <Bouton variante="fantome" icone={X} aria-label="Fermer" onClick={onFermer} />
          </div>
          <div className="modale-corps">{children}</div>
          {pied && <div className="modale-pied">{pied}</div>}
        </>
      )}
    </dialog>
  );
}

type Toast = { id: number; message: string };
const ContexteToast = createContext<(message: string) => void>(() => {});

/** Toasts : région `aria-live="polite"`, fermeture automatique en 4 s, sans vol de focus. */
export function FournisseurToasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const suivant = useRef(0);
  const afficher = useCallback((message: string) => {
    const id = ++suivant.current;
    setToasts((t) => [...t.slice(-2), { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ContexteToast.Provider value={afficher}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <CircleCheck className="icone" aria-hidden="true" />
            {t.message}
          </div>
        ))}
      </div>
    </ContexteToast.Provider>
  );
}

export const useToast = () => useContext(ContexteToast);

export type Theme = "clair" | "sombre" | "systeme";

const CLE_THEME = "auto-theme";

/**
 * Applique un thème et le mémorise. « systeme » efface la valeur enregistrée : la page suit de nouveau le
 * système, y compris ses changements ultérieurs. Un stockage indisponible n'empêche pas d'appliquer le thème.
 */
export function appliquerTheme(t: Theme) {
  if (t === "systeme") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "systeme") localStorage.removeItem(CLE_THEME);
    else localStorage.setItem(CLE_THEME, t);
  } catch {
    // Données du site bloquées : le thème vaut pour cette page seulement.
  }
}

export function themeEnregistre(): Theme {
  try {
    const t = localStorage.getItem(CLE_THEME);
    return t === "clair" || t === "sombre" ? t : "systeme";
  } catch {
    return "systeme";
  }
}

const systemeSombre = () => matchMedia("(prefers-color-scheme: dark)").matches;
/** Thème réellement affiché : le thème imposé, sinon celui du système. */
const themeAffiche = (t: Theme): "clair" | "sombre" => (t === "systeme" ? (systemeSombre() ? "sombre" : "clair") : t);

/**
 * Bascule à deux états pour la barre latérale : passe au thème opposé de celui affiché. Si ce thème est celui du
 * système, l'utilisateur annule son réglage : rien n'est mémorisé, la page suit à nouveau le système. Les trois choix
 * explicites (système, clair, sombre) sont dans les paramètres (`ChoixTheme`).
 */
export function BasculeTheme({ avecLibelle }: { avecLibelle?: boolean }) {
  const [theme, setTheme] = useState<Theme>(themeEnregistre);
  const [, rafraichir] = useState(0);
  useEffect(() => {
    // Autre onglet ou changement du thème du système : l'icône et l'action proposée suivent.
    const surStockage = (e: StorageEvent) => {
      if (e.key !== CLE_THEME && e.key !== null) return;
      const t = themeEnregistre();
      appliquerTheme(t);
      setTheme(t);
    };
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const surSysteme = () => rafraichir((n) => n + 1);
    addEventListener("storage", surStockage);
    mq.addEventListener("change", surSysteme);
    return () => {
      removeEventListener("storage", surStockage);
      mq.removeEventListener("change", surSysteme);
    };
  }, []);
  const affiche = themeAffiche(theme);
  const cible = affiche === "sombre" ? "clair" : "sombre";
  const action = cible === "sombre" ? "Passer au thème sombre" : "Passer au thème clair";
  function basculer() {
    const t: Theme = cible === (systemeSombre() ? "sombre" : "clair") ? "systeme" : cible;
    appliquerTheme(t);
    setTheme(t);
  }
  return (
    <Bouton
      variante="fantome"
      icone={affiche === "sombre" ? Moon : Sun}
      aria-label={avecLibelle ? undefined : action}
      onClick={basculer}
    >
      {avecLibelle ? action : undefined}
    </Bouton>
  );
}

const CHOIX_THEME: { valeur: Theme; libelle: string; icone: Symbole }[] = [
  { valeur: "systeme", libelle: "Système", icone: Monitor },
  { valeur: "clair", libelle: "Clair", icone: Sun },
  { valeur: "sombre", libelle: "Sombre", icone: Moon },
];

/** Réglage explicite à trois choix (paramètres) ; « Système » indique le thème qu'il donne actuellement. */
export function ChoixTheme() {
  const [theme, setTheme] = useState<Theme>(themeEnregistre);
  const systeme = systemeSombre() ? "sombre" : "clair";
  return (
    <fieldset className="choix-theme">
      <legend>Thème</legend>
      {CHOIX_THEME.map((c) => (
        <label key={c.valeur} className="choix-theme-option">
          <input
            type="radio"
            name="theme"
            value={c.valeur}
            checked={theme === c.valeur}
            onChange={() => {
              appliquerTheme(c.valeur);
              setTheme(c.valeur);
            }}
          />
          <c.icone className="icone icone-sm" aria-hidden="true" />
          {c.valeur === "systeme" ? `${c.libelle} (actuellement ${systeme})` : c.libelle}
        </label>
      ))}
    </fieldset>
  );
}

export type Etat<T> =
  | { etat: "chargement"; donnees?: undefined; erreur?: undefined }
  | { etat: "ok"; donnees: T; erreur?: undefined }
  | { etat: "erreur"; donnees?: undefined; erreur: string };

/** Chargement asynchrone avec états chargement, ok, erreur et rechargement. */
export function useDonnees<T>(charger: () => Promise<T>, deps: unknown[] = []) {
  const [etat, setEtat] = useState<Etat<T>>({ etat: "chargement" });
  const [jeton, setJeton] = useState(0);
  useEffect(() => {
    let actif = true;
    setEtat((e) => (e.etat === "ok" ? e : { etat: "chargement" }));
    charger().then(
      (donnees) => actif && setEtat({ etat: "ok", donnees }),
      (e: Error) => actif && setEtat({ etat: "erreur", erreur: e.message }),
    );
    return () => {
      actif = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, jeton]);
  return { ...etat, recharger: () => setJeton((j) => j + 1) } as Etat<T> & { recharger: () => void };
}

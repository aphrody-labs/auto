// Champs du formulaire des paramètres, un composant par genre (voir formulaire.ts). Les champs texte
// s'inscrivent comme cible d'insertion : une puce de l'aide aux expressions s'insère au curseur, et un
// aperçu montre la valeur résolue sur les données du dernier essai.
import { FILTRES, resoudre, type Portee } from "@auto/automate/expressions";
import { Plus, Trash2 } from "@auto/ui/symboles";
import { Bouton } from "@auto/ui/react";
import { Switch } from "@base-ui/react/switch";
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import {
  UNAIRES,
  champsDepuisSchema,
  depuisLibre,
  elementVide,
  estExpression,
  versLibre,
  versNombre,
  type Champ,
} from "./formulaire";
import type { SchemaJson } from "@auto/client";

type Saisie = HTMLInputElement | HTMLTextAreaElement;

interface Cible {
  element: Saisie;
  appliquer: (texte: string) => void;
}

/** Cible d'insertion courante : le dernier champ texte qui a eu le focus. */
export const ContexteInsertion = createContext<{ current: Cible | null }>({ current: null });

/** Portée d'aperçu des expressions : données d'entrée du dernier essai. */
export const ContextePortee = createContext<Portee | null>(null);

export function insererAuCurseur(cible: Cible, texte: string) {
  const el = cible.element;
  const debut = el.selectionStart ?? el.value.length;
  const fin = el.selectionEnd ?? debut;
  cible.appliquer(el.value.slice(0, debut) + texte + el.value.slice(fin));
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(debut + texte.length, debut + texte.length);
  });
}

function useCible(appliquer: (t: string) => void) {
  const ref = useContext(ContexteInsertion);
  return (e: { currentTarget: Saisie }) => {
    ref.current = { element: e.currentTarget, appliquer };
  };
}

function Apercu({ valeur }: { valeur: unknown }) {
  const portee = useContext(ContextePortee);
  if (!portee || !estExpression(valeur)) return null;
  let texte: string;
  let erreur = false;
  try {
    const r = resoudre(valeur, portee);
    texte = r === undefined ? "(indéfini)" : typeof r === "string" ? r : JSON.stringify(r);
  } catch (e) {
    texte = (e as Error).message;
    erreur = true;
  }
  return (
    <span className="flux-apercu-expr" data-erreur={erreur || undefined}>
      <span className="visuellement-cache">Aperçu : </span>
      {texte.length > 300 ? `${texte.slice(0, 300)}…` : texte}
    </span>
  );
}

function Cadre({
  id,
  champ,
  erreur,
  children,
  apres,
}: {
  id: string;
  champ: Champ;
  erreur?: string;
  children: ReactNode;
  apres?: ReactNode;
}) {
  return (
    <div className="champ flux-champ">
      <label htmlFor={id}>
        {champ.libelle}
        {champ.requis && (
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
      {apres}
      {champ.aide && (
        <span id={`${id}-aide`} className="aide">
          {champ.aide}
        </span>
      )}
      {erreur && (
        <span id={`${id}-erreur`} className="erreur-champ">
          {erreur}
        </span>
      )}
    </div>
  );
}

const decrit = (id: string, champ: Champ, erreur?: string) =>
  [champ.aide && `${id}-aide`, erreur && `${id}-erreur`].filter(Boolean).join(" ") || undefined;

/** Saisie texte (ligne ou zone) inscrite comme cible d'insertion. */
function Texte({
  id,
  valeur,
  onTexte,
  zone,
  className,
  ...p
}: {
  id?: string;
  valeur: string;
  onTexte: (t: string) => void;
  zone?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  placeholder?: string;
  list?: string;
  inputMode?: "decimal";
}) {
  const inscrire = useCible(onTexte);
  const classes = `controle ${estExpression(valeur) ? "controle-expr" : ""} ${className ?? ""}`;
  if (zone)
    return (
      <textarea
        id={id}
        className={classes}
        rows={valeur.split("\n").length > 3 ? 6 : 3}
        value={valeur}
        spellCheck={false}
        onFocus={inscrire}
        onChange={(e) => onTexte(e.target.value)}
        {...p}
      />
    );
  return (
    <input
      id={id}
      className={classes}
      value={valeur}
      spellCheck={false}
      autoComplete="off"
      onFocus={inscrire}
      onChange={(e) => onTexte(e.target.value)}
      {...p}
    />
  );
}

/** Interrupteur Base UI libellé (rôle switch, Espace pour basculer). */
export function Interrupteur({
  libelle,
  coche,
  onChange,
  disabled,
  aide,
}: {
  libelle: string;
  coche: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  aide?: string;
}) {
  const id = useId();
  return (
    <div className="flux-interrupteur">
      <span id={id} className="flux-interrupteur-libelle">
        {libelle}
        {aide && <span className="aide">{aide}</span>}
      </span>
      <Switch.Root
        className="interrupteur"
        checked={coche}
        disabled={disabled}
        aria-labelledby={id}
        onCheckedChange={(v) => onChange(v)}
      >
        <Switch.Thumb className="interrupteur-curseur" />
      </Switch.Root>
    </div>
  );
}

function ObjetJson({
  id,
  valeur,
  onChange,
  champ,
}: {
  id: string;
  valeur: unknown;
  onChange: (v: unknown) => void;
  champ: Champ;
}) {
  const [texte, setTexte] = useState(() => JSON.stringify(valeur ?? {}, null, 2));
  const [erreur, setErreur] = useState<string>();
  useEffect(() => setTexte(JSON.stringify(valeur ?? {}, null, 2)), [valeur]);
  return (
    <Cadre id={id} champ={champ} erreur={erreur}>
      <textarea
        id={id}
        className="controle controle-code"
        rows={5}
        spellCheck={false}
        value={texte}
        aria-invalid={erreur ? true : undefined}
        aria-describedby={decrit(id, champ, erreur)}
        onChange={(e) => setTexte(e.target.value)}
        onBlur={() => {
          try {
            const v = JSON.parse(texte || "{}") as unknown;
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
            setErreur(undefined);
            onChange(v);
          } catch {
            setErreur('Objet JSON attendu, par exemple { "client": "Durand" }.');
          }
        }}
      />
    </Cadre>
  );
}

type Ligne = Record<string, unknown>;

function Lignes<T>({
  champ,
  lignes,
  onChange,
  nouvelle,
  rendre,
  libelleAjout,
}: {
  champ: Champ;
  lignes: T[];
  onChange: (l: T[]) => void;
  nouvelle: () => T;
  rendre: (l: T, maj: (l: T) => void, i: number) => ReactNode;
  libelleAjout: string;
}) {
  const plein = champ.max !== undefined && lignes.length >= champ.max;
  const minimum = champ.min ?? 0;
  return (
    <div className="flux-lignes">
      {lignes.map((l, i) => (
        <div key={i} className="flux-ligne">
          {rendre(l, (x) => onChange(lignes.map((y, j) => (j === i ? x : y))), i)}
          <Bouton
            variante="fantome"
            icone={Trash2}
            aria-label={`Retirer la ligne ${i + 1}`}
            disabled={lignes.length <= minimum}
            onClick={() => onChange(lignes.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <Bouton variante="fantome" icone={Plus} disabled={plein} onClick={() => onChange([...lignes, nouvelle()])}>
        {libelleAjout}
      </Bouton>
    </div>
  );
}

export function ChampParametre({
  champ,
  valeur,
  onChange,
  erreur,
  operateurs,
}: {
  champ: Champ;
  valeur: unknown;
  onChange: (v: unknown) => void;
  erreur?: string;
  operateurs?: Champ["operateurs"];
}) {
  const id = useId();
  const aria = { "aria-describedby": decrit(id, champ, erreur), "aria-invalid": erreur ? true : undefined };

  switch (champ.genre) {
    case "booleen":
      return <Interrupteur libelle={champ.libelle} aide={champ.aide} coche={valeur === true} onChange={onChange} />;
    case "choix":
      return (
        <Cadre id={id} champ={champ} erreur={erreur}>
          <select
            id={id}
            className="controle"
            value={String(valeur ?? champ.defaut ?? "")}
            onChange={(e) => onChange(e.target.value)}
            {...aria}
          >
            {!champ.requis && champ.defaut === undefined && <option value="">—</option>}
            {champ.options?.map((o) => (
              <option key={o.valeur} value={o.valeur}>
                {o.libelle}
              </option>
            ))}
          </select>
        </Cadre>
      );
    case "nombre":
      return (
        <Cadre id={id} champ={champ} erreur={erreur} apres={<Apercu valeur={valeur} />}>
          <Texte
            id={id}
            inputMode="decimal"
            valeur={valeur === undefined || valeur === null ? "" : String(valeur as string | number)}
            placeholder={champ.min !== undefined && champ.max !== undefined ? `${champ.min} à ${champ.max}` : undefined}
            onTexte={(t) => onChange(versNombre(t))}
            {...aria}
          />
        </Cadre>
      );
    case "texte":
    case "zone":
      return (
        <Cadre id={id} champ={champ} erreur={erreur} apres={<Apercu valeur={valeur} />}>
          <Texte
            id={id}
            zone={champ.genre === "zone"}
            valeur={typeof valeur === "string" ? valeur : depuisLibre(valeur)}
            onTexte={onChange}
            {...aria}
          />
        </Cadre>
      );
    case "libre":
      return (
        <Cadre id={id} champ={champ} erreur={erreur} apres={<Apercu valeur={valeur} />}>
          <Texte
            id={id}
            zone={champ.cle === "corps"}
            className={champ.cle === "corps" ? "controle-code" : undefined}
            valeur={depuisLibre(valeur)}
            onTexte={(t) => onChange(versLibre(t))}
            {...aria}
          />
        </Cadre>
      );
    case "objet":
      return <ObjetJson id={id} champ={champ} valeur={valeur} onChange={onChange} />;
    case "liste": {
      const liste = Array.isArray(valeur) ? valeur.map((v) => String(v ?? "")) : [];
      const idListe = `${id}-suggestions`;
      return (
        <fieldset className="flux-groupe" aria-describedby={aria["aria-describedby"]}>
          <legend>
            {champ.libelle}
            {champ.requis && <span className="requis"> *</span>}
          </legend>
          {champ.suggestions && (
            <datalist id={idListe}>
              {champ.suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          <Lignes
            champ={champ}
            lignes={liste}
            onChange={onChange}
            nouvelle={() => ""}
            libelleAjout="Ajouter"
            rendre={(l, maj, i) => (
              <Texte
                valeur={l}
                onTexte={maj}
                list={champ.suggestions ? idListe : undefined}
                aria-label={`${champ.libelle} ${i + 1}`}
              />
            )}
          />
          {champ.aide && (
            <span id={`${id}-aide`} className="aide">
              {champ.aide}
            </span>
          )}
          {erreur && (
            <span id={`${id}-erreur`} className="erreur-champ">
              {erreur}
            </span>
          )}
        </fieldset>
      );
    }
    case "paires":
    case "conditions": {
      const lignes = (Array.isArray(valeur) ? valeur : []) as Ligne[];
      const conditions = champ.genre === "conditions";
      return (
        <fieldset className="flux-groupe" aria-describedby={aria["aria-describedby"]}>
          <legend>
            {champ.libelle}
            {champ.requis && <span className="requis"> *</span>}
          </legend>
          <Lignes
            champ={champ}
            lignes={lignes}
            onChange={onChange}
            nouvelle={() => elementVide(champ)}
            libelleAjout={conditions ? "Ajouter une condition" : "Ajouter un champ"}
            rendre={(l, maj, i) =>
              conditions ? (
                <div className="flux-condition">
                  <Texte
                    valeur={depuisLibre(l.gauche)}
                    onTexte={(t) => maj({ ...l, gauche: versLibre(t) })}
                    placeholder="{{ $json.champ }}"
                    aria-label={`Valeur comparée, condition ${i + 1}`}
                  />
                  <Apercu valeur={l.gauche} />
                  <select
                    className="controle"
                    value={String(l.operateur ?? "egal")}
                    aria-label={`Opérateur, condition ${i + 1}`}
                    onChange={(e) => {
                      const operateur = e.target.value;
                      const { droite, ...reste } = l;
                      maj(
                        UNAIRES.has(operateur)
                          ? { ...reste, operateur }
                          : { ...reste, operateur, droite: droite ?? "" },
                      );
                    }}
                  >
                    {(operateurs ?? champ.operateurs ?? []).map((o) => (
                      <option key={o.valeur} value={o.valeur}>
                        {o.libelle}
                      </option>
                    ))}
                  </select>
                  {!UNAIRES.has(String(l.operateur)) && (
                    <Texte
                      valeur={depuisLibre(l.droite)}
                      onTexte={(t) => maj({ ...l, droite: versNombreOuTexte(t) })}
                      placeholder="valeur"
                      aria-label={`Valeur attendue, condition ${i + 1}`}
                    />
                  )}
                </div>
              ) : (
                <div className="flux-paire">
                  <Texte
                    valeur={String(l.nom ?? "")}
                    onTexte={(t) => maj({ ...l, nom: t })}
                    placeholder="nom"
                    aria-label={`Nom, ligne ${i + 1}`}
                  />
                  <Texte
                    valeur={depuisLibre(l.valeur)}
                    onTexte={(t) => maj({ ...l, valeur: versLibre(t) })}
                    placeholder="valeur ou {{ expression }}"
                    aria-label={`Valeur, ligne ${i + 1}`}
                  />
                  <Apercu valeur={l.valeur} />
                </div>
              )
            }
          />
          {erreur && (
            <span id={`${id}-erreur`} className="erreur-champ">
              {erreur}
            </span>
          )}
        </fieldset>
      );
    }
    case "objets": {
      const lignes = (Array.isArray(valeur) ? valeur : []) as Ligne[];
      const sous = champ.sousChamps ?? [];
      return (
        <fieldset className="flux-groupe" aria-describedby={aria["aria-describedby"]}>
          <legend>
            {champ.libelle}
            {champ.requis && <span className="requis"> *</span>}
          </legend>
          <Lignes
            champ={champ}
            lignes={lignes}
            onChange={onChange}
            nouvelle={() => elementVide(champ)}
            libelleAjout="Ajouter une ligne"
            rendre={(l, maj, i) => (
              <div className="flux-condition">
                {sous.map((s) =>
                  s.genre === "booleen" ? (
                    <Interrupteur
                      key={s.cle}
                      libelle={s.libelle}
                      coche={l[s.cle] === true}
                      onChange={(v) => maj({ ...l, [s.cle]: v })}
                    />
                  ) : (
                    <Texte
                      key={s.cle}
                      valeur={depuisLibre(l[s.cle])}
                      onTexte={(t) => maj({ ...l, [s.cle]: s.genre === "nombre" ? versNombre(t) : t })}
                      placeholder={`${s.libelle.toLowerCase()}${s.requis ? "" : " (facultatif)"}`}
                      aria-label={`${s.libelle}, ligne ${i + 1}`}
                    />
                  ),
                )}
              </div>
            )}
          />
          {champ.aide && (
            <span id={`${id}-aide`} className="aide">
              {champ.aide}
            </span>
          )}
          {erreur && (
            <span id={`${id}-erreur`} className="erreur-champ">
              {erreur}
            </span>
          )}
        </fieldset>
      );
    }
  }
}

/** Valeur de droite d'une condition : nombre si c'en est un (comparaisons numériques), sinon texte. */
const versNombreOuTexte = (t: string) => (/^-?\d+([.,]\d+)?$/.test(t.trim()) ? versNombre(t) : t);

export function FormulaireParametres({
  schema,
  valeurs,
  erreurs,
  onChange,
}: {
  schema: SchemaJson;
  valeurs: Record<string, unknown>;
  erreurs: Record<string, string>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const champs = champsDepuisSchema(schema);
  if (!champs.length) return <p className="attenue">Ce nœud n'a aucun paramètre.</p>;
  return (
    <div className="flux-formulaire">
      {champs.map((c) => (
        <ChampParametre
          key={c.cle}
          champ={c}
          valeur={valeurs[c.cle]}
          erreur={erreurs[c.cle]}
          onChange={(v) => onChange({ ...valeurs, [c.cle]: v })}
        />
      ))}
    </div>
  );
}

const DESCRIPTIONS_FILTRES: Record<string, string> = {
  majuscules: "en majuscules",
  minuscules: "en minuscules",
  rogner: "sans espaces autour",
  texte: "en texte",
  json: "en JSON",
  nombre: "en nombre",
  arrondi: "arrondi (arrondi:2)",
  euros: "montant en euros",
  centimes: "centimes affichés en euros",
  longueur: "longueur d'un texte ou d'une liste",
  premier: "premier élément",
  dernier: "dernier élément",
  joindre: "liste jointe (joindre:', ')",
  defaut: "valeur de repli (defaut:'—')",
  date: "date lisible (date:'iso', date:'jour')",
  plus_jours: "date décalée (plus_jours:30)",
};

const VARIABLES = [
  { expr: "{{ $json }}", aide: "élément courant" },
  { expr: "{{ $index }}", aide: "rang de l'élément" },
  { expr: "{{ $maintenant }}", aide: "date et heure ISO" },
  { expr: "{{ $aujourdhui }}", aide: "date du jour" },
  { expr: "{{ $workflow.nom }}", aide: "nom du workflow" },
  { expr: "{{ $execution.id }}", aide: "identifiant de l'exécution" },
];

/** Aide aux expressions : champs de l'entrée, autres nœuds, secrets, variables et filtres, insérés au curseur. */
export function AideExpressions({
  chemins,
  noeuds,
  secrets,
}: {
  chemins: string[];
  noeuds: { id: string; nom: string }[];
  secrets: string[];
}) {
  const cible = useContext(ContexteInsertion);
  const [message, setMessage] = useState("");
  const inserer = (texte: string) => {
    if (cible.current && cible.current.element.isConnected) {
      insererAuCurseur(cible.current, texte);
      setMessage(`${texte} inséré`);
    } else {
      void navigator.clipboard?.writeText(texte);
      setMessage(`${texte} copié : placez le curseur dans un champ pour l'insérer directement`);
    }
  };
  const puce = (texte: string, titre?: string) => (
    <button
      key={texte}
      type="button"
      className="flux-puce"
      title={titre}
      // Le champ garde le focus et sa sélection : la puce s'insère au curseur.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => inserer(texte)}
    >
      {texte}
    </button>
  );
  return (
    <details className="flux-aide">
      <summary>Expressions et filtres</summary>
      <p className="aide">
        Entre doubles accolades, une valeur prise dans les données : <code>{"{{ $json.client.email }}"}</code>, suivie
        de filtres : <code>{"{{ $json.total | centimes }}"}</code>. Cliquez une puce pour l'insérer dans le champ actif.
      </p>
      {chemins.length > 0 && (
        <>
          <h4>Champs de l'entrée (dernier essai)</h4>
          <div className="flux-puces">{chemins.map((c) => puce(`{{ $json${c} }}`))}</div>
        </>
      )}
      {noeuds.length > 0 && (
        <>
          <h4>Autres nœuds</h4>
          <div className="flux-puces">{noeuds.map((n) => puce(`{{ $noeud.${n.id}.json }}`, n.nom))}</div>
        </>
      )}
      <h4>Secrets</h4>
      {secrets.length ? (
        <div className="flux-puces">{secrets.map((s) => puce(`{{ $secret.${s} }}`))}</div>
      ) : (
        <p className="aide">Aucun secret : ajoutez-en depuis l'onglet Secrets des automatisations.</p>
      )}
      <h4>Variables</h4>
      <div className="flux-puces">{VARIABLES.map((v) => puce(v.expr, v.aide))}</div>
      <h4>Filtres</h4>
      <div className="flux-puces">{Object.keys(FILTRES).map((f) => puce(` | ${f}`, DESCRIPTIONS_FILTRES[f]))}</div>
      <p className="visuellement-cache" aria-live="polite">
        {message}
      </p>
    </details>
  );
}

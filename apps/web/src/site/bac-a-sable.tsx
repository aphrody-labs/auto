// Bac à sable de l'accueil : le moteur de production (@auto/automate) exécute un vrai workflow dans le navigateur.
// Expressions, filtres et conditions sont ceux du serveur ; seules les requêtes sortantes sont interceptées et montrées
// telles qu'elles partiraient (méthode, URL, en-têtes, corps).
import { MdFilledButton, MdIcon } from "@aphrody/m3-react";
import { executer, valider, type Resultat } from "@auto/automate/moteur";
import { CATALOGUE } from "@auto/automate/noeuds";
import { useState, type CSSProperties, type FormEvent } from "react";

const noeud = (id: string, type: string, nom: string, x: number, parametres: Record<string, unknown>) => ({
  id,
  type,
  nom,
  position: [x, 0] as [number, number],
  parametres,
});

/** Commande reçue → mise en forme → grosse commande ou mot « urgent » ? → Slack des ventes, sinon notification ntfy. */
const DEFINITION = valider({
  noeuds: [
    noeud("formulaire", "declencheur.manuel", "Commande reçue", 0, {}),
    noeud("preparer", "donnees.definir", "Mettre en forme", 1, {
      champs: [
        { nom: "client", valeur: "{{ $json.client | rogner | majuscules }}" },
        { nom: "total", valeur: "{{ $json.montant | nombre | euros }}" },
      ],
    }),
    noeud("tri", "logique.si", "Grosse commande ou urgente ?", 2, {
      combinaison: "ou",
      conditions: [
        { gauche: "{{ $json.montant | nombre }}", operateur: "superieur", droite: 1000 },
        { gauche: "{{ $json.message | minuscules }}", operateur: "contient", droite: "urgent" },
      ],
    }),
    noeud("ventes", "communication.slack", "Prévenir les ventes", 3, {
      webhook: "https://hooks.slack.com/services/T000/B000/demo",
      texte: "Commande de {{ $json.total }} pour {{ $json.client }} : « {{ $json.message | defaut:'sans message' }} »",
    }),
    noeud("suivi", "communication.ntfy", "Notifier le suivi", 3, {
      serveur: "https://ntfy.sh",
      sujet: "auto-commandes",
      titre: "{{ $json.client }}",
      texte: "Commande de {{ $json.total }} enregistrée.",
      priorite: 2,
    }),
  ],
  connexions: [
    { de: "formulaire", vers: "preparer", sortie: 0 },
    { de: "preparer", vers: "tri", sortie: 0 },
    { de: "tri", vers: "ventes", sortie: 0 },
    { de: "tri", vers: "suivi", sortie: 1 },
  ],
});

interface Requete {
  noeud: string;
  methode: string;
  url: string;
  entetes: Record<string, string>;
  corps: string;
}

async function lancer(entree: Record<string, string>) {
  const requetes: Requete[] = [];
  const resultat = await executer(DEFINITION, [{ json: entree }], {
    workflow: { id: "demo", nom: "Démonstration" },
    executionId: crypto.randomUUID(),
    services: {
      async fetch(url, init) {
        requetes.push({
          noeud: "",
          methode: init.method ?? "GET",
          url,
          entetes: Object.fromEntries(new Headers(init.headers)),
          corps: typeof init.body === "string" ? init.body : "",
        });
        return Response.json({ ok: true });
      },
      async appelerAuto() {
        throw new Error("indisponible dans la démonstration");
      },
      async envoyerMail() {
        throw new Error("indisponible dans la démonstration");
      },
    },
  });
  // Chaque requête interceptée revient à l'étape de communication qui l'a émise, dans l'ordre d'exécution.
  const emetteurs = resultat.etapes.filter((e) => e.type.startsWith("communication."));
  requetes.forEach((r, i) => (r.noeud = emetteurs[i]?.noeud ?? ""));
  return { resultat, requetes };
}

const champ =
  "w-full rounded-medium border border-outline bg-surface px-4 py-3 text-body-large text-on-surface placeholder:text-on-surface-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

const SORTIES_SI = ["vrai", "faux"];

function resumeSorties(type: string, sorties: number[]) {
  if (type === "logique.si") {
    const i = sorties.findIndex((n) => n > 0);
    return i < 0 ? "aucun élément" : `vers « ${SORTIES_SI[i]} »`;
  }
  const total = sorties.reduce((a, b) => a + b, 0);
  return `${total} élément${total > 1 ? "s" : ""}`;
}

export function BacASable() {
  const [execution, setExecution] = useState<{ resultat: Resultat; requetes: Requete[]; numero: number } | null>(null);
  const [enCours, setEnCours] = useState(false);

  async function soumettre(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setEnCours(true);
    try {
      const r = await lancer({
        client: String(f.get("client") ?? ""),
        montant: String(f.get("montant") ?? ""),
        message: String(f.get("message") ?? ""),
      });
      setExecution((x) => ({ ...r, numero: (x?.numero ?? 0) + 1 }));
    } finally {
      setEnCours(false);
    }
  }

  const etapes = execution?.resultat.etapes ?? [];

  return (
    <section
      className="mx-auto w-full max-w-[1240px] px-4 pt-24 md:px-6 md:pt-32"
      id="essai"
      aria-labelledby="titre-essai"
    >
      <h2
        id="titre-essai"
        className="m-0 max-w-[22ch] font-brand text-headline-large tracking-tight text-balance md:text-display-small"
      >
        Faites tourner le vrai moteur, ici même
      </h2>
      <p className="mb-10 mt-4 max-w-[62ch] text-body-large text-on-surface-variant">
        Le code qui exécute vos workflows en production tourne dans votre navigateur. Changez le montant ou écrivez «
        urgent » : l'aiguillage change de branche. Rien ne part : chaque requête s'affiche telle qu'elle serait envoyée.
      </p>

      <div className="grid gap-6 lg:grid-cols-[5fr_7fr] lg:items-start">
        <form
          onSubmit={soumettre}
          className="grid gap-5 rounded-extra-large border border-outline-variant bg-surface-container-low p-6 md:p-8"
        >
          <label className="grid gap-2 text-label-large">
            Client
            <input name="client" className={champ} defaultValue="  atelier dupont " autoComplete="off" required />
          </label>
          <label className="grid gap-2 text-label-large">
            Montant de la commande (€)
            <input name="montant" className={champ} defaultValue="1 480,50" inputMode="decimal" required />
          </label>
          <label className="grid gap-2 text-label-large">
            Message
            <textarea name="message" className={`${champ} min-h-24 resize-y`} defaultValue="Livraison avant vendredi" />
          </label>
          <div className="flex flex-wrap items-center gap-4">
            <MdFilledButton type="submit" disabled={enCours}>
              Exécuter le workflow
            </MdFilledButton>
            {execution && (
              <span className="text-body-medium text-on-surface-variant">Exécution n° {execution.numero}</span>
            )}
          </div>
          <ol
            className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-label-medium text-on-surface-variant"
            aria-label="Nœuds du workflow"
          >
            {DEFINITION.noeuds.map((n, i) => (
              <li key={n.id} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden="true">→</span>}
                {n.nom}
              </li>
            ))}
          </ol>
        </form>

        <div className="rounded-extra-large border border-outline-variant bg-surface p-4 md:p-6" aria-live="polite">
          {!execution ? (
            <p className="m-0 grid min-h-64 place-items-center text-center text-body-large text-on-surface-variant">
              Lancez le workflow : chaque étape apparaîtra ici avec ses données.
            </p>
          ) : (
            <ol key={execution.numero} className="essai-etapes m-0 grid list-none gap-3 p-0">
              {etapes.map((e, i) => {
                const type = CATALOGUE.get(e.type);
                const requete = execution.requetes.find((r) => r.noeud === e.noeud);
                return (
                  <li
                    key={e.noeud}
                    className="rounded-large border border-outline-variant bg-surface-container-low p-4"
                    style={{ "--i": i } as CSSProperties}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className="grid size-10 shrink-0 place-items-center rounded-medium bg-secondary-container text-on-secondary-container"
                        aria-hidden="true"
                      >
                        <MdIcon className="text-[22px]">{type?.icone ?? "circle"}</MdIcon>
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block text-label-large">{e.nom}</strong>
                        <span className="text-body-medium text-on-surface-variant">{type?.libelle ?? e.type}</span>
                      </span>
                      <span className="text-label-medium tabular-nums text-on-surface-variant">
                        {e.erreur ? "échec" : resumeSorties(e.type, e.sorties)} · {e.dureeMs.toFixed(1)} ms
                      </span>
                    </div>
                    {e.erreur && <p className="mb-0 mt-3 text-body-medium text-error">{e.erreur}</p>}
                    {requete ? (
                      <div className="mt-3 overflow-x-auto rounded-medium bg-surface-container-highest p-3 font-mono text-body-small">
                        <div className="text-on-surface">
                          <strong>{requete.methode}</strong> {requete.url}
                        </div>
                        {Object.entries(requete.entetes)
                          .filter(([k]) => k !== "content-type")
                          .map(([k, v]) => (
                            <div key={k} className="text-on-surface-variant">
                              {k}: {v}
                            </div>
                          ))}
                        <pre className="m-0 mt-2 whitespace-pre-wrap break-words text-on-surface">{requete.corps}</pre>
                      </div>
                    ) : (
                      e.apercu.length > 0 && (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-label-large text-primary">Données produites</summary>
                          <pre className="m-0 mt-2 overflow-x-auto rounded-medium bg-surface-container-highest p-3 font-mono text-body-small">
                            {JSON.stringify(e.apercu[0]!.json, null, 2)}
                          </pre>
                        </details>
                      )
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

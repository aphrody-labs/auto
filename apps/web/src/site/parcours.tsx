// Parcours d'un événement : récit piloté par le défilement. À gauche, un rail épinglé de quatre stations ; à droite,
// quatre étapes de texte. Chaque étape anime sa station par une timeline de vue CSS (scroll-driven animations),
// sans JavaScript ; sans prise en charge du navigateur ou avec le mouvement réduit, tout reste lisible et statique.
import { MdIcon } from "@aphrody/m3-react";
import { TYPES } from "@auto/automate/noeuds";

const ETAPES = [
  {
    icone: "payments",
    titre: "Un paiement arrive",
    texte:
      "Votre client règle la facture F-2026-118. auto l'enregistre et publie l'événement paiement.enregistre, avec le client, le montant et la facture.",
    detail: "Déclencheur « Événement auto »",
  },
  {
    icone: "account_tree",
    titre: "Le workflow s'en saisit",
    texte:
      "Le workflow abonné à cet événement démarre. Si un service répond mal, le nœud réessaie, avec une attente qui double à chaque essai. Chaque modification du workflow reste dans ses versions.",
    detail: "Nouveaux essais, versions, historique des exécutions",
  },
  {
    icone: "notifications_active",
    titre: "Il prévient là où vous êtes",
    texte:
      "Un sous-workflow commun envoie le remerciement au client et prévient l'équipe : Slack, Matrix, ntfy, Mastodon ou e-mail, selon vos canaux.",
    detail: `Sous-workflow, ${TYPES.length} types de nœuds`,
  },
  {
    icone: "auto_awesome",
    titre: "Et une IA locale garde la mémoire",
    texte:
      "Un modèle servi par Ollama résume l'échange et l'ajoute à la base de connaissances de l'entreprise. Vos données restent sur votre serveur.",
    detail: "Modèle compatible OpenAI, base de connaissances",
  },
];

export function Parcours() {
  return (
    <section
      className="parcours mx-auto w-full max-w-[1240px] px-4 pt-24 md:px-6 md:pt-32"
      id="parcours"
      aria-labelledby="titre-parcours"
    >
      <h2
        id="titre-parcours"
        className="m-0 max-w-[22ch] font-brand text-headline-large tracking-tight text-balance md:text-display-small"
      >
        Le parcours d'un paiement, d'un bout à l'autre
      </h2>
      <div className="mt-10 grid gap-10 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <div className="parcours-rail max-lg:hidden" aria-hidden="true">
          <div className="parcours-rail-epingle">
            <span className="parcours-ligne">
              <span />
            </span>
            {ETAPES.map((e, i) => (
              <div key={e.titre} className={`parcours-station parcours-station-${i + 1}`}>
                <span className="parcours-pastille">
                  <MdIcon className="text-[26px]">{e.icone}</MdIcon>
                </span>
                <span className="text-title-medium">{e.titre}</span>
              </div>
            ))}
          </div>
        </div>
        <ol className="parcours-etapes m-0 grid list-none gap-6 p-0">
          {ETAPES.map((e, i) => (
            <li key={e.titre} className={`parcours-etape parcours-etape-${i + 1}`}>
              <span
                className="mb-4 grid size-12 place-items-center rounded-large bg-primary-container text-on-primary-container lg:hidden"
                aria-hidden="true"
              >
                <MdIcon className="text-[26px]">{e.icone}</MdIcon>
              </span>
              <p className="m-0 text-label-large text-primary">Étape {i + 1} sur 4</p>
              <h3 className="m-0 mt-2 font-brand text-headline-small md:text-headline-medium">{e.titre}</h3>
              <p className="m-0 mt-4 max-w-[52ch] text-body-large text-on-surface-variant">{e.texte}</p>
              <p className="m-0 mt-4 text-label-large text-on-surface">{e.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

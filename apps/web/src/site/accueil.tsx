// Vitrine BTP : captures réelles d’une entreprise de démonstration isolée.
import { Icone, Image } from "./medias";
import { IMAGES } from "./images.gen";

const INSCRIPTION = "/app/inscription";
const CONTACT = "mailto:contact@aphrody.com?subject=Installation%20auto%20pour%20mon%20entreprise";
const DEMONSTRATIONS = [
  {
    id: "chantiers",
    nom: "Chantiers",
    capture: "analytique",
    alt: "Le chantier Villa des Pins dans auto : synthèse des ventes, achats et solde HT, avec son avancement.",
    titre: "Le bon dossier, du premier devis à la dernière livraison.",
    texte:
      "Rattachez les devis, factures et achats au chantier. Consultez les ventes et les achats HT dans sa synthèse, avec les commandes non facturées à part.",
    precision: "Le solde HT exclut la main-d’œuvre et les charges non saisies : ce n’est pas une marge nette.",
    points: [
      ["Rattacher les pièces", "Devis, factures et achats liés au bon chantier."],
      ["Suivre les montants", "Ventes et achats HT dans une même synthèse."],
      ["Garder l’historique", "Les pièces archivées restent consultables."],
    ],
  },
  {
    id: "devis",
    nom: "Devis et factures",
    capture: "devis-editeur",
    alt: "L’éditeur de devis réel d’auto, avec le client, le chantier et les lignes de travaux.",
    titre: "Votre devis prend forme, ligne après ligne.",
    texte:
      "Choisissez votre client et votre chantier, détaillez les prestations et préparez votre document. Retrouvez ensuite les factures, acomptes, avoirs et paiements dans le même outil.",
    precision:
      "Vous vérifiez le document avant son émission. Le raccordement à une plateforme agréée reste en qualification.",
    points: [
      ["Chiffrer les travaux", "Des lignes de prestations, des quantités et des prix HT."],
      ["Retrouver le client", "Ses coordonnées et son chantier au même endroit."],
      ["Suivre la facturation", "Factures, acomptes, avoirs et paiements enregistrés."],
    ],
  },
  {
    id: "achats",
    nom: "Achats",
    capture: "achats",
    alt: "La liste réelle des factures fournisseurs dans auto, avec les pièces à vérifier et leurs montants.",
    titre: "Les achats fournisseurs rejoignent le bon chantier.",
    texte:
      "Déposez vos factures reçues, vérifiez les informations et classez-les par fournisseur et par chantier. Retrouvez aussi vos bons de livraison et confirmations de commande.",
    precision:
      "L’extraction assistée dépend des services configurés. Une vérification humaine reste nécessaire avant validation.",
    points: [
      ["Rassembler les factures", "Des pièces reçues au même endroit, avec leur statut."],
      ["Vérifier avant de valider", "Corrigez les informations extraites si nécessaire."],
      ["Classer par chantier", "Les achats validés alimentent la synthèse HT."],
    ],
  },
  {
    id: "documents",
    nom: "Documents",
    capture: "recherche",
    alt: "La recherche réelle d’auto retrouve des devis, factures et pièces de chantier par référence.",
    titre: "Une référence suffit pour retrouver le fil.",
    texte:
      "Recherchez une pièce par référence, client, fournisseur ou chantier. Les dossiers raccordés et les documents indexés rejoignent la recherche selon les droits de chaque membre.",
    precision:
      "Le raccordement d’un serveur de fichiers nécessite sa configuration. Les originaux ne sont ni déplacés ni supprimés.",
    points: [
      ["Retrouver un document", "Une recherche par référence, tiers ou chantier."],
      ["Raccorder vos dossiers", "Des copies indexées, sans déplacer les originaux."],
      ["Partager le bon accès", "Des permissions par membre et espace de gestion."],
    ],
  },
] as const;
const OFFRES = [
  {
    nom: "Gratuit",
    prix: "0 €",
    pour: "Pour découvrir auto",
    points: ["10 factures par mois", "2 employés", "1 Go de stockage"],
    note: "20 appels d’IA par mois.",
  },
  {
    nom: "Pro",
    prix: "14 €",
    pour: "Pour les petites équipes",
    points: ["200 factures par mois", "10 employés", "2 boîtes mail"],
    note: "500 appels d’IA par mois, API publique. 30 jours d’essai.",
  },
  {
    nom: "Business",
    prix: "39 €",
    pour: "Pour les structures en croissance",
    points: ["Factures illimitées", "50 employés", "10 boîtes mail"],
    note: "5 000 appels d’IA par mois.",
  },
] as const;
const QUESTIONS = [
  [
    "Est-ce adapté à une entreprise du bâtiment ?",
    "Auto rassemble vos devis, factures, fournisseurs, chantiers et pièces. Vous gardez la main sur les vérifications et les validations. Le suivi HT par chantier porte sur les documents affectés ; il ne remplace pas un calcul de marge nette intégrant toutes vos charges.",
  ],
  [
    "Faut-il installer un logiciel ?",
    "Vous pouvez commencer sur le site depuis votre navigateur, avec un compte auto. Sur un navigateur compatible, ajoutez l’application à votre écran d’accueil ou installez-la depuis le menu du navigateur. Une installation locale et le raccordement de vos dossiers se préparent avec votre accompagnant informatique.",
  ],
  [
    "Que fait l’extraction des documents ?",
    "Selon les services configurés, auto lit les informations des factures et devis reçus pour vous aider à les saisir. Vous vérifiez les montants et les lignes, corrigez les erreurs et validez. Un document extrait n’est pas une facture émise automatiquement.",
  ],
  [
    "Et la facturation électronique ?",
    "Auto produit des factures au format Factur-X. Le raccordement à une plateforme agréée est en cours de qualification ; nous ne le présentons pas comme un service déjà ouvert. Les paiements Stripe sont actuellement en mode test.",
  ],
  [
    "Puis-je récupérer mes données ?",
    "Les exports permettent de récupérer vos données et vos pièces selon vos droits. Les espaces de gestion disposent notamment d’exports Excel et PDF ; l’analytique d’un chantier s’exporte aussi en CSV. Retrouvez les conditions de chaque offre sur la page Tarifs.",
  ],
] as const;

function Fleche() {
  return <Icone nom="arrow_forward" />;
}
function Marque() {
  return (
    <a className="btp-marque" href="/" aria-label="auto, accueil">
      <Icone nom="receipt_long" />
      <span>auto</span>
    </a>
  );
}
function Entete() {
  return (
    <header className="btp-entete">
      <nav className="btp-conteneur btp-navigation" aria-label="Navigation du site">
        <Marque />
        <div className="btp-liens-principaux">
          <a href="#produit">Le produit</a>
          <a href="#installation">Installation</a>
          <a href="/telechargements">Applications</a>
          <a href="/tarifs">Tarifs</a>
        </div>
        <div className="btp-compte">
          <a href="/app/connexion">Se connecter</a>
          <a className="btp-bouton btp-bouton-menthe" href={INSCRIPTION}>
            Essayer gratuitement
          </a>
        </div>
      </nav>
    </header>
  );
}
function Heros() {
  return (
    <section className="btp-heros" aria-labelledby="titre">
      <Image nom="btp-plan" className="btp-heros-fond" sizes="100vw" alt="" fetchPriority="high" />
      <div className="btp-conteneur btp-heros-grille">
        <div className="btp-heros-texte">
          <h1 id="titre">
            Du chantier
            <br />
            au bureau,
            <br />
            <span>tout se retrouve.</span>
          </h1>
          <p>Devis, factures, achats et documents : gardez le fil de vos chantiers, au même endroit.</p>
          <div className="btp-actions">
            <a className="btp-bouton btp-bouton-menthe" href={INSCRIPTION}>
              Créer mon compte gratuit
            </a>
            <a className="btp-lien" href="#produit">
              Découvrir le produit <Fleche />
            </a>
          </div>
        </div>
        <FilmHero />
      </div>
      <div className="btp-conteneur btp-rail" aria-label="Les espaces de gestion">
        <span>
          <Icone nom="description" />
          Devis et factures
        </span>
        <span>
          <Icone nom="shopping_cart" />
          Achats fournisseurs
        </span>
        <span>
          <Icone nom="folder_open" />
          Chantiers et documents
        </span>
      </div>
    </section>
  );
}
/**
 * Capture du héros ; le film (modèle inerte) la remplace si /media répond (ilots.ts). Balisage statique : la
 * page est prérendue au build et animée sans React dans le navigateur.
 */
function FilmHero() {
  return (
    <>
      <a className="btp-heros-capture" href="#produit" aria-label="Découvrir les écrans réels d’auto">
        <Image
          nom="btp-analytique"
          sizes="(min-width: 1101px) 950px, 100vw"
          alt="Le dossier Villa des Pins dans auto : ventes, achats et suivi du chantier."
        />
      </a>
      <template id="modele-film">
        <figure className="btp-heros-film" id="film-lancement">
          {/* Ni affiche ni source avant le clic (ilots.ts) : rien n'est téléchargé tant que le film n'est pas lancé. */}
          <video
            playsInline
            preload="none"
            width={IMAGES["btp-analytique"].largeur}
            height={IMAGES["btp-analytique"].hauteur}
            aria-label="Présentation d’auto en français : usages BTP et installation"
          >
            Votre navigateur ne peut pas lire cette vidéo. Retrouvez les écrans du produit ci-dessous.
          </video>
          <Image
            nom="btp-analytique"
            className="btp-heros-film-affiche"
            sizes="(min-width: 1101px) 950px, 100vw"
            alt=""
            loading="lazy"
          />
          <div className="btp-heros-film-voile">
            <div className="btp-heros-film-action">
              <p>
                Présentation d’auto <span>· 4 min 20</span>
              </p>
              <button className="btp-film-lancer" type="button" aria-label="Voir la présentation vidéo d’auto">
                <Icone nom="play_arrow" />
                Voir la présentation
              </button>
            </div>
          </div>
          <figcaption className="btp-visuellement-cache">
            Usages BTP et installation expliqués en français. La vidéo ne démarre qu’à votre demande.
          </figcaption>
        </figure>
      </template>
    </>
  );
}

function Produit() {
  return (
    <section className="btp-section btp-produit" id="produit" aria-labelledby="titre-produit">
      <div className="btp-conteneur">
        <h2 id="titre-produit">Un chantier. Toutes ses pièces.</h2>
        <p className="btp-introduction">
          Retrouvez le devis, les achats et les livraisons sans passer d’un dossier à l’autre.
        </p>
        {/* Onglets ARIA (clavier et sélection : ilots.ts) ; tous les panneaux sont dans le HTML prérendu. */}
        <div>
          <div className="btp-onglets" role="tablist" aria-label="Découvrir les espaces d’auto">
            {DEMONSTRATIONS.map((demo, i) => (
              <button
                key={demo.id}
                type="button"
                role="tab"
                id={`onglet-${demo.id}`}
                aria-controls={`panneau-${demo.id}`}
                aria-selected={i === 0}
                tabIndex={i === 0 ? 0 : -1}
                className="btp-onglet"
              >
                {demo.nom}
              </button>
            ))}
          </div>
          {DEMONSTRATIONS.map((demo, i) => (
            <div
              key={demo.id}
              role="tabpanel"
              id={`panneau-${demo.id}`}
              aria-labelledby={`onglet-${demo.id}`}
              tabIndex={0}
              hidden={i !== 0}
              className="btp-panneau"
            >
              <figure className="btp-demonstration">
                <a
                  href={`/img/btp-${demo.capture}.webp`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Agrandir la capture : ${demo.nom} (nouvel onglet)`}
                >
                  <Image
                    nom={`btp-${demo.capture}`}
                    sizes="(min-width: 1280px) 1180px, 100vw"
                    alt={demo.alt}
                    loading="lazy"
                  />
                </a>
                <figcaption>
                  Écrans réels, données de démonstration.{" "}
                  <a href={`/img/btp-${demo.capture}.webp`} target="_blank" rel="noreferrer">
                    Agrandir<span className="btp-sr"> la capture (nouvel onglet)</span> <Icone nom="open_in_new" />
                  </a>
                </figcaption>
              </figure>
              <div className="btp-points">
                {demo.points.map(([titre, texte]) => (
                  <div key={titre}>
                    <h3>{titre}</h3>
                    <p>{texte}</p>
                  </div>
                ))}
              </div>
              <p className="btp-note">{demo.precision}</p>
              <details className="btp-cas">
                <summary>
                  {demo.titre}
                  <Icone nom="keyboard_arrow_down" />
                </summary>
                <p>{demo.texte}</p>
              </details>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
function Installation() {
  return (
    <section className="btp-section btp-installation" id="installation" aria-labelledby="titre-installation">
      <div className="btp-conteneur">
        <div className="btp-installation-grille">
          <div>
            <h2 id="titre-installation">
              Commencez dans
              <br />
              votre navigateur.
            </h2>
            <p className="btp-introduction">
              Au bureau ou sur le chantier, retrouvez auto sur votre ordinateur, votre tablette ou votre téléphone.
            </p>
            <ol className="btp-etapes">
              <li>
                <h3>Créez votre compte</h3>
                <p>Renseignez votre entreprise et ses coordonnées.</p>
              </li>
              <li>
                <h3>Retrouvez vos premiers dossiers</h3>
                <p>Ajoutez un client, créez un chantier, préparez votre devis.</p>
              </li>
              <li>
                <h3>Gardez auto à portée de main</h3>
                <p>Ajoutez l’application à l’écran d’accueil depuis votre navigateur compatible.</p>
              </li>
            </ol>
            <a className="btp-bouton btp-bouton-vert" href={INSCRIPTION}>
              Créer mon compte <Fleche />
            </a>
            <p className="btp-note">
              <a className="btp-lien" href="/telechargements">
                Voir les applications disponibles <Fleche />
              </a>
            </p>
          </div>
          <figure className="btp-appareils">
            <div className="btp-ordinateur">
              <Image
                nom="btp-tableau"
                sizes="(min-width: 1024px) 50vw, 90vw"
                alt="Le tableau de bord d’auto sur ordinateur, avec des données de démonstration."
                loading="lazy"
              />
            </div>
            <div className="btp-telephone">
              <Image
                nom="btp-mobile"
                sizes="(min-width: 1024px) 160px, 30vw"
                alt="Le chantier Villa des Pins affiché sur téléphone dans auto."
                loading="lazy"
              />
            </div>
            <figcaption>Application web installable selon votre navigateur.</figcaption>
          </figure>
        </div>
        <div className="btp-installation-locale">
          <Icone nom="dns" />
          <div>
            <h3>Vous avez un serveur de fichiers ?</h3>
            <p>
              Une installation locale et le raccordement de vos dossiers se préparent avec votre accompagnant
              informatique.
            </p>
          </div>
          <a className="btp-lien" href={CONTACT}>
            Parlons de votre installation <Fleche />
          </a>
        </div>
      </div>
    </section>
  );
}
function Prix() {
  return (
    <section className="btp-section btp-prix" id="offres" aria-labelledby="titre-prix">
      <div className="btp-conteneur">
        <h2 id="titre-prix">
          Une offre pour démarrer,
          <br />
          de la place pour grandir.
        </h2>
        <div className="btp-offres">
          {OFFRES.map((offre) => (
            <article className={`btp-offre${offre.nom === "Pro" ? " btp-offre-pro" : ""}`} key={offre.nom}>
              <h3>{offre.nom}</h3>
              <p className="btp-pour">{offre.pour}</p>
              <p className="btp-montant">
                {offre.prix}
                <span>HT par mois</span>
              </p>
              <ul>
                {offre.points.map((point) => (
                  <li key={point}>
                    <Icone nom="check" />
                    {point}
                  </li>
                ))}
              </ul>
              <p className="btp-note btp-note-offre">{offre.note}</p>
              <a className="btp-bouton btp-bouton-vert" href={INSCRIPTION}>
                Créer mon compte gratuit
              </a>
            </article>
          ))}
        </div>
        <div className="btp-comparer">
          <a className="btp-lien" href="/tarifs">
            Comparer les offres <Fleche />
          </a>
          <p className="btp-note">Les paiements d’abonnement sont actuellement en mode test.</p>
        </div>
      </div>
    </section>
  );
}
function Questions() {
  return (
    <section className="btp-section btp-questions" id="questions" aria-labelledby="titre-questions">
      <div className="btp-conteneur">
        <h2 id="titre-questions">Des réponses avant de commencer.</h2>
        <div className="btp-faq">
          {QUESTIONS.map(([question, reponse], index) => (
            <details key={question} open={index === 0}>
              <summary>
                {question}
                <Icone nom="add" />
              </summary>
              <p>{reponse}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
function Pied() {
  return (
    <>
      <section className="btp-appel" aria-labelledby="titre-appel">
        <div className="btp-conteneur">
          <h2 id="titre-appel">
            Votre prochain
            <br />
            chantier commence ici.
          </h2>
          <a className="btp-bouton btp-bouton-menthe" href={INSCRIPTION}>
            Créer mon compte gratuit <Fleche />
          </a>
        </div>
      </section>
      <footer className="btp-pied">
        <div className="btp-conteneur">
          <Marque />
          <nav aria-label="Liens utiles">
            <a href="/tarifs">Tarifs</a>
            <a href="/telechargements">Applications</a>
            <a href="mailto:contact@aphrody.com">Contact</a>
            <a href="/mentions-legales">Mentions légales</a>
            <a href="/confidentialite">Confidentialité</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
export function Accueil() {
  return (
    <>
      <a className="btp-evitement" href="#contenu">
        Aller au contenu
      </a>
      <Entete />
      <main id="contenu">
        <Heros />
        <Produit />
        <Installation />
        <Prix />
        <Questions />
      </main>
      <Pied />
    </>
  );
}

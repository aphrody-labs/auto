export interface Scene {
  id: string;
  chapter: string;
  title: string;
  subtitle: string;
  speech: string;
  kind?: "intro" | "screen" | "steps" | "phone" | "outro";
  image?: string;
  points?: string[];
  note?: string;
  duration?: number;
  start?: number;
}

/** Texte métier : les captures proviennent du vrai front et d'une base PostgreSQL jetable. */
export const lancement: Scene[] = [
  {
    id: "ouverture",
    chapter: "AUTO POUR LE BTP",
    kind: "intro",
    title: "Du chantier au bureau,\ntout se retrouve.",
    subtitle: "Devis · factures · achats · chantiers",
    speech:
      "Un devis à préparer. Une facture fournisseur à retrouver. Un chantier à suivre. Avec auto, rassemblez votre gestion dans un même espace.",
  },
  {
    id: "vue-ensemble",
    chapter: "01 · VOTRE ENTREPRISE",
    image: "tableau",
    title: "La journée commence\navec une vue claire.",
    subtitle: "Vos documents et vos échéances, au même endroit.",
    points: ["Ce qui est facturé", "Ce qui reste à encaisser", "Les prochaines actions"],
    speech:
      "Depuis le tableau de bord, retrouvez vos documents et les montants à encaisser. Nous suivons ici une entreprise fictive du bâtiment, Bâtir ensemble.",
  },
  {
    id: "chantier",
    chapter: "LE CAS CONCRET · VILLA DES PINS",
    image: "chantier",
    title: "Un dossier pour\nchaque chantier.",
    subtitle: "Client, adresse, budget et avancement.",
    points: ["Villa des Pins", "Budget : 48 000 € HT", "Avancement : 70 %"],
    speech:
      "Pour la Villa des Pins, le dossier réunit le client, l'adresse, le budget et l'avancement. Les documents peuvent être rattachés à ce chantier.",
  },
  {
    id: "devis",
    chapter: "02 · PRÉPARER ET FACTURER",
    image: "devis-editeur",
    title: "Préparez le devis\ndepuis le chantier.",
    subtitle: "Ajoutez les prestations, les quantités et les prix.",
    points: ["Le client est repris", "Le chantier est déjà choisi", "Vous vérifiez avant émission"],
    speech:
      "Cliquez sur Créer un devis. Le client et le chantier sont déjà repris. Complétez vos prestations, quantités et prix, puis vérifiez le brouillon.",
  },
  {
    id: "facture",
    chapter: "SUIVRE LES ENCAISSEMENTS",
    image: "facture",
    title: "Une facture claire.\nUn paiement suivi.",
    subtitle: "Document, échéance et règlements dans le même dossier.",
    speech:
      "Émettez vos factures et enregistrez les règlements reçus. Le dossier conserve les montants, les échéances et l'accès au document PDF.",
  },
  {
    id: "achats",
    chapter: "03 · LES ACHATS FOURNISSEURS",
    image: "achats",
    title: "Chaque achat rejoint\nle bon chantier.",
    subtitle: "Recevoir → vérifier → classer → valider",
    points: ["Fournisseur identifié", "Chantier associé", "Validation humaine"],
    speech:
      "Une facture de matériaux arrive. Vérifiez les informations extraites, choisissez le fournisseur et le chantier, puis validez. Vous gardez la main sur les informations.",
  },
  {
    id: "devis-recus",
    chapter: "RÉUTILISER LES DOCUMENTS REÇUS",
    image: "devis-recu-detail",
    title: "Un devis reçu peut\npréparer le vôtre.",
    subtitle: "Contrôlez les données avant de créer le brouillon client.",
    note: "Extraction à contrôler · aucune émission automatique",
    speech:
      "Vous recevez le devis d’un fournisseur. Auto vous aide à reprendre les informations. Vérifiez les montants, puis choisissez votre client pour préparer un brouillon. Vous validez avant l’envoi.",
  },
  {
    id: "analytique",
    chapter: "04 · COMPRENDRE LE CHANTIER",
    image: "analytique",
    title: "Voyez ce qui entre.\nEt ce qui sort.",
    subtitle: "20 000 € de ventes HT − 8 500 € d’achats HT = 11 500 €",
    note: "Solde HT des pièces saisies · hors main-d’œuvre et charges non saisies",
    speech:
      "Dans notre exemple, vingt mille euros de ventes, moins huit mille cinq cents euros d'achats, donnent un solde de onze mille cinq cents euros hors taxes. Ce n'est pas une marge nette.",
  },
  {
    id: "livraisons",
    chapter: "LIVRAISONS ET COMMANDES",
    image: "livraisons",
    title: "Reliez les pièces\nà leur chantier.",
    subtitle: "Bons de livraison et confirmations de commande.",
    speech:
      "Conservez aussi vos bons de livraison et confirmations de commande. Leurs références restent liées au fournisseur et au chantier pour faciliter le suivi.",
  },
  {
    id: "recherche",
    chapter: "05 · RETROUVER ET TRANSMETTRE",
    image: "recherche",
    title: "Retrouvez une pièce\nsans ouvrir dix dossiers.",
    subtitle: "Cherchez par référence, tiers ou chantier.",
    speech:
      "Tapez le nom du chantier, d'un fournisseur ou une référence. La recherche rassemble les documents que votre compte est autorisé à consulter.",
  },
  {
    id: "exports",
    chapter: "TRAVAILLER AVEC LE COMPTABLE",
    image: "exports",
    title: "Préparez les éléments\nà transmettre.",
    subtitle: "Exports Excel, PDF et données comptables disponibles.",
    speech:
      "Depuis Exports, récupérez les données utiles à votre comptable. Les espaces de gestion peuvent être réunis dans un classeur Excel ou un rapport PDF.",
  },
  {
    id: "installation",
    chapter: "06 · DÉMARRER SIMPLEMENT",
    image: "site",
    title: "Commencez\ndans le navigateur.",
    subtitle: "auto.aphrody.com",
    points: ["Ouvrez le site", "Choisissez Créer un compte", "Préparez votre e-mail et votre SIRET"],
    speech:
      "Pour commencer, ouvrez auto point aphrody point com dans votre navigateur. Le service en ligne s'utilise directement, sans installer de serveur dans votre entreprise.",
  },
  {
    id: "compte",
    chapter: "ÉTAPE 1 SUR 4 · LE COMPTE",
    image: "inscription",
    title: "Créez votre\ncompte professionnel.",
    subtitle: "Votre e-mail et un mot de passe d’au moins 12 caractères.",
    speech:
      "Choisissez Créer votre compte. Saisissez votre adresse professionnelle et un mot de passe d'au moins douze caractères, puis cliquez sur Continuer.",
  },
  {
    id: "entreprise",
    chapter: "ÉTAPE 2 SUR 4 · L’ENTREPRISE",
    image: "entreprise",
    title: "Renseignez\nvotre entreprise.",
    subtitle: "SIREN, raison sociale, SIRET et adresse.",
    points: ["Recherchez votre SIREN", "Vérifiez les informations proposées", "Créez l’entreprise"],
    speech:
      "Recherchez votre entreprise avec son SIREN, ou complétez les informations demandées. Vérifiez la raison sociale, le SIRET et l'adresse avant de créer l'entreprise.",
  },
  {
    id: "connexion",
    chapter: "RETROUVER VOTRE ESPACE",
    image: "connexion",
    title: "Connectez-vous\nà votre espace.",
    subtitle: "Avec votre e-mail et votre mot de passe.",
    note: "Les autres méthodes dépendent de la configuration du service",
    speech:
      "Pour revenir, utilisez la page de connexion avec votre adresse et votre mot de passe. Les autres méthodes proposées dépendent de la configuration du service.",
  },
  {
    id: "installer",
    chapter: "ÉTAPE 3 SUR 4 · SUR VOS APPAREILS",
    kind: "phone",
    image: "mobile",
    title: "Gardez auto\nà portée de main.",
    subtitle: "Le même espace, au bureau et sur le terrain.",
    points: [
      "Chrome / Edge : Installer l’application, si proposé",
      "iPhone : Partager → Sur l’écran d’accueil",
      "Reconnectez-vous avec le même compte",
    ],
    speech:
      "Sur ordinateur, utilisez Installer l'application si votre navigateur le propose. Sur iPhone, choisissez Partager, puis Sur l'écran d'accueil. Retrouvez ensuite le même compte sur vos appareils.",
  },
  {
    id: "equipe",
    chapter: "ÉTAPE 4 SUR 4 · LES ACCÈS",
    image: "parametres",
    title: "Invitez les bonnes\npersonnes.",
    subtitle: "Définissez les rôles et les espaces autorisés.",
    speech:
      "Dans Paramètres, invitez les personnes concernées et attribuez leurs droits. La direction, la comptabilité et les équipes n'ont pas besoin des mêmes accès.",
  },
  {
    id: "mail",
    chapter: "RACCORDER VOTRE QUOTIDIEN",
    image: "courrier",
    title: "Rassemblez\nles courriels utiles.",
    subtitle: "Connectez une boîte autorisée avec les réglages de votre fournisseur.",
    speech:
      "La boîte unifiée peut recevoir vos courriels professionnels. Faites configurer la connexion à votre messagerie, puis vérifiez la relève et l'envoi avec votre fournisseur.",
  },
  {
    id: "dossiers",
    chapter: "RACCORDER LES DOSSIERS EXISTANTS",
    image: "sources",
    title: "Retrouvez les fichiers\ndéjà sur votre serveur.",
    subtitle: "Dossier autorisé → synchronisation → copies consultables",
    note: "Le partage doit d’abord être raccordé par votre responsable informatique",
    speech:
      "Pour vos dossiers partagés, votre responsable informatique prépare d'abord l'accès. Choisissez ensuite la source autorisée et synchronisez. Les originaux restent à leur emplacement.",
  },
  {
    id: "bureautique",
    chapter: "VOS DOCUMENTS DE TRAVAIL",
    image: "atelier",
    title: "Gardez vos documents\nprès de votre gestion.",
    subtitle: "Espaces Word, Excel et PDF intégrés au produit.",
    speech:
      "L'espace Word, Excel et PDF accueille vos documents de travail. Les fichiers peuvent être conservés dans auto, à côté des pièces de votre entreprise.",
  },
  {
    id: "automatisations",
    chapter: "ALLER PLUS LOIN, À VOTRE RYTHME",
    image: "automatisations",
    title: "Faites préparer\nles tâches répétitives.",
    subtitle: "Des automatisations à configurer et à vérifier.",
    note: "Les connexions externes nécessitent leurs accès et leur configuration",
    speech:
      "Les automatisations permettent de préparer des enchaînements de tâches. Faites configurer un premier scénario simple, puis vérifiez son résultat avant de l'utiliser au quotidien.",
  },
  {
    id: "local",
    chapter: "ET SI VOUS VOULEZ UNE INSTALLATION LOCALE ?",
    kind: "steps",
    title: "Une installation locale\nse prépare avec vous.",
    subtitle: "À confier au responsable informatique de l’entreprise.",
    points: [
      "Choisir Auto local ou Aphrody Box",
      "Préparer stockage, accès et sauvegardes",
      "Vérifier la messagerie et les connexions",
      "Tester avec un premier chantier",
    ],
    note: "Windows / Android natifs : disponibilité des distributions à vérifier",
    speech:
      "Une installation locale est aussi possible. Confiez-la à votre responsable informatique : il prépare le stockage, les sauvegardes et les connexions. Commencez ensuite avec un chantier pilote.",
  },
  {
    id: "fin",
    chapter: "AUTO · VOTRE GESTION, AU MÊME ENDROIT",
    kind: "outro",
    title: "Moins de pièces éparpillées.\nPlus de visibilité.",
    subtitle: "Commencez avec votre prochain chantier.",
    points: ["auto.aphrody.com", "Créer un compte → renseigner l’entreprise → démarrer"],
    speech:
      "Un chantier, ses documents, ses achats et son suivi. Découvrez auto sur auto point aphrody point com, et commencez avec votre prochain chantier.",
  },
];

// Modèles prêts à l'emploi : un workflow complet que l'entreprise copie puis adapte (URL, secrets, adresses).
import type { Definition } from "./schema";

export interface Modele {
  id: string;
  nom: string;
  description: string;
  /** Types de nœuds mis en avant dans la galerie. */
  categories: string[];
  definition: Definition;
}

const n = (
  id: string,
  type: string,
  nom: string,
  x: number,
  y: number,
  parametres: Record<string, unknown> = {},
): Definition["noeuds"][number] => ({
  id,
  type,
  nom,
  parametres,
  position: [x, y],
  desactive: false,
  continuerSurErreur: false,
  tentatives: 0,
  delaiEssaiMs: 1000,
});
const c = (de: string, vers: string, sortie = 0) => ({ de, vers, sortie });

export const MODELES: Modele[] = [
  {
    id: "facture-slack",
    nom: "Annoncer chaque facture émise sur Slack",
    description: "Dès qu'une facture part, l'équipe voit le client, le numéro et le montant dans son canal.",
    categories: ["auto", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.evenement", "Facture émise", 0, 0, { types: ["document.emis"] }),
        n("facture", "logique.si", "C'est une facture ?", 280, 0, {
          conditions: [{ gauche: "{{ $json.data.data.type }}", operateur: "egal", droite: "facture" }],
          combinaison: "et",
        }),
        n("slack", "communication.slack", "Prévenir l'équipe", 560, -80, {
          webhook: "{{ $secret.slack_ventes }}",
          texte:
            "Facture {{ $json.data.numero }} émise pour {{ $json.data.data.client.nom }} : {{ $json.data.totaux.ttcCents | centimes }}",
        }),
      ],
      connexions: [c("declencheur", "facture"), c("facture", "slack", 0)],
    },
  },
  {
    id: "paiement-merci",
    nom: "Remercier le client à réception du paiement",
    description: "Un mail de remerciement part depuis votre boîte dès qu'un paiement est enregistré.",
    categories: ["auto", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.evenement", "Paiement reçu", 0, 0, { types: ["paiement.enregistre"] }),
        n("document", "auto.requete", "Lire la facture", 280, 0, {
          methode: "GET",
          chemin: "/v1/documents/{{ $json.data.documentId }}",
        }),
        n("email", "logique.si", "Le client a un mail ?", 560, 0, {
          conditions: [{ gauche: "{{ $json.data.client.email }}", operateur: "non_vide" }],
          combinaison: "et",
        }),
        n("mail", "communication.mail", "Remercier", 840, -80, {
          a: "{{ $json.data.client.email }}",
          sujet: "Merci pour votre règlement de la facture {{ $json.numero }}",
          texte:
            "Bonjour {{ $json.data.client.nom }},\n\nNous avons bien reçu votre paiement pour la facture {{ $json.numero }}. Merci pour votre confiance.\n\n{{ $json.data.emetteur.nom }}",
        }),
      ],
      connexions: [c("declencheur", "document"), c("document", "email"), c("email", "mail", 0)],
    },
  },
  {
    id: "retards-lundi",
    nom: "Récapitulatif des impayés chaque lundi",
    description: "Chaque lundi à 8 h, la liste des factures en retard arrive dans votre boîte, triée par ancienneté.",
    categories: ["planifie", "auto", "donnees"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.planifie", "Lundi 8 h", 0, 0, { cron: "0 8 * * 1", fuseau: "Europe/Paris" }),
        n("retards", "auto.requete", "Factures à relancer", 280, 0, {
          methode: "GET",
          chemin: "/v1/relances",
          eclater: true,
        }),
        n("tri", "donnees.trier", "Plus anciennes d'abord", 560, 0, { champ: "joursRetard", ordre: "decroissant" }),
        n("ligne", "donnees.definir", "Mettre en forme", 840, 0, {
          champs: [
            {
              nom: "ligne",
              valeur:
                "{{ $json.numero }} · {{ $json.client.nom }} · {{ $json.resteCents | centimes }} · {{ $json.joursRetard }} j",
            },
          ],
          conserver: false,
        }),
        n("regrouper", "donnees.agreger", "Regrouper", 1120, 0, { champ: "lignes", valeur: "ligne" }),
        n("mail", "communication.mail", "Envoyer le récapitulatif", 1400, 0, {
          a: "{{ $secret.mail_gerant }}",
          sujet: "{{ $json.nombre }} factures en retard",
          texte: "{{ $json.lignes | joindre:'\n' }}",
        }),
      ],
      connexions: [
        c("declencheur", "retards"),
        c("retards", "tri"),
        c("tri", "ligne"),
        c("ligne", "regrouper"),
        c("regrouper", "mail"),
      ],
    },
  },
  {
    id: "formulaire-client",
    nom: "Créer un client depuis le formulaire de votre site",
    description: "Votre formulaire de contact appelle l'URL du webhook : le prospect devient un client dans auto.",
    categories: ["webhook", "auto"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.webhook", "Formulaire reçu", 0, 0, { reponse: "fin" }),
        n("valide", "donnees.filtrer", "Nom et mail présents", 280, 0, {
          conditions: [
            { gauche: "{{ $json.corps.nom }}", operateur: "non_vide" },
            { gauche: "{{ $json.corps.email }}", operateur: "correspond", droite: "^[^@\\s]+@[^@\\s]+$" },
          ],
          combinaison: "et",
        }),
        n("client", "auto.requete", "Créer le client", 560, 0, {
          methode: "POST",
          chemin: "/v1/clients",
          corps: {
            nom: "{{ $json.corps.nom }}",
            email: "{{ $json.corps.email }}",
            adresse: "{{ $json.corps.adresse | defaut:'' }}",
          },
        }),
      ],
      connexions: [c("declencheur", "valide"), c("valide", "client")],
    },
  },
  {
    id: "absence-telegram",
    nom: "Prévenir le responsable d'une demande d'absence",
    description: "Une demande de congé arrive sur Telegram, avec les dates et le salarié concerné.",
    categories: ["auto", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.evenement", "Absence demandée", 0, 0, { types: ["absence.demandee"] }),
        n("telegram", "communication.telegram", "Message au responsable", 280, 0, {
          jeton: "{{ $secret.telegram_bot }}",
          chat: "{{ $secret.telegram_chat }}",
          texte: "Demande d'absence du {{ $json.data.debut | date }} au {{ $json.data.fin | date }}.",
        }),
      ],
      connexions: [c("declencheur", "telegram")],
    },
  },
  {
    id: "ia-tri-messages",
    nom: "Trier les messages entrants avec un modèle local",
    description: "Un modèle Ollama classe chaque message reçu (devis, support, autre) et le dirige vers le bon canal.",
    categories: ["webhook", "ia", "logique"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.webhook", "Message reçu", 0, 0, { reponse: "fin" }),
        n("ia", "ia.texte", "Classer le message", 280, 0, {
          url: "http://localhost:11434/v1",
          modele: "llama3.2",
          systeme:
            'Classe le message dans une catégorie : "devis", "support" ou "autre". Réponds en JSON : {"categorie": "…", "resume": "…"}.',
          prompt: "{{ $json.corps.message }}",
          json: true,
        }),
        n("aiguillage", "logique.aiguillage", "Selon la catégorie", 560, 0, {
          valeur: "{{ $json.reponse.categorie }}",
          cas: ["devis", "support"],
        }),
        n("devis", "communication.slack", "Canal ventes", 840, -120, {
          webhook: "{{ $secret.slack_ventes }}",
          texte: "Demande de devis : {{ $json.reponse.resume }}",
        }),
        n("support", "communication.slack", "Canal support", 840, 0, {
          webhook: "{{ $secret.slack_support }}",
          texte: "Support : {{ $json.reponse.resume }}",
        }),
      ],
      connexions: [
        c("declencheur", "ia"),
        c("ia", "aiguillage"),
        c("aiguillage", "devis", 0),
        c("aiguillage", "support", 1),
      ],
    },
  },
  {
    id: "veille-api",
    nom: "Surveiller une API et alerter sur Discord",
    description: "Toutes les heures, un service web est interrogé ; une réponse anormale déclenche une alerte.",
    categories: ["planifie", "reseau", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.planifie", "Toutes les heures", 0, 0, {
          cron: "0 * * * *",
          fuseau: "Europe/Paris",
        }),
        n("http", "reseau.http", "Interroger le service", 280, 0, {
          methode: "GET",
          url: "https://auto.aphrody.com/health",
          echecSiErreur: false,
        }),
        n("ko", "logique.si", "Réponse anormale ?", 560, 0, {
          conditions: [{ gauche: "{{ $json.statut }}", operateur: "superieur", droite: 299 }],
          combinaison: "et",
        }),
        n("discord", "communication.discord", "Alerter", 840, -80, {
          webhook: "{{ $secret.discord_alertes }}",
          texte: "Service en erreur : HTTP {{ $json.statut }} à {{ $maintenant | date:'iso' }}",
        }),
      ],
      connexions: [c("declencheur", "http"), c("http", "ko"), c("ko", "discord", 0)],
    },
  },
  {
    id: "veille-rss",
    nom: "Veille : nouveaux articles d'un flux résumés sur Slack",
    description:
      "Toutes les heures, les nouveaux articles d'un flux RSS sont résumés en une phrase par un modèle local puis publiés.",
    categories: ["planifie", "reseau", "ia", "communication"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.planifie", "Toutes les heures", 0, 0, {
          cron: "0 * * * *",
          fuseau: "Europe/Paris",
        }),
        n("flux", "reseau.flux", "Lire le flux", 280, 0, { url: "https://www.economie.gouv.fr/rss", max: 20 }),
        n("nouveaux", "donnees.nouveaux", "Seulement les nouveaux", 560, 0, { champ: "id" }),
        n("resume", "ia.texte", "Résumer", 840, 0, {
          url: "http://localhost:11434/v1",
          modele: "llama3.2",
          systeme: "Résume l'article en une phrase en français, sans préambule.",
          prompt: "{{ $json.titre }}\n\n{{ $json.resume }}",
        }),
        n("slack", "communication.slack", "Publier", 1120, 0, {
          webhook: "{{ $secret.slack_veille }}",
          texte: "{{ $json.titre }} : {{ $json.reponse }} {{ $json.lien }}",
        }),
      ],
      connexions: [c("declencheur", "flux"), c("flux", "nouveaux"), c("nouveaux", "resume"), c("resume", "slack")],
    },
  },
  {
    id: "questions-documents",
    nom: "Répondre aux questions avec vos documents",
    description:
      "Un webhook reçoit une question ; les passages les plus proches de votre base de connaissances sont retrouvés puis un modèle de langage répond en citant ses sources. Indexez d'abord vos documents avec « Indexer dans la base de connaissances ».",
    categories: ["webhook", "ia"],
    definition: {
      noeuds: [
        n("declencheur", "declencheur.webhook", "Question reçue", 0, 0, { reponse: "fin" }),
        n("recherche", "ia.rechercher", "Chercher dans les documents", 280, 0, {
          base: "documents",
          question: "{{ $json.corps.question }}",
          k: 4,
          api: "http://localhost:11434/v1",
          modele: "nomic-embed-text",
        }),
        n("reponse", "ia.texte", "Répondre", 560, 0, {
          url: "http://localhost:11434/v1",
          modele: "llama3.2",
          systeme:
            "Tu réponds en français à partir des extraits fournis seulement, en citant la source entre crochets. Si les extraits ne contiennent pas la réponse, dis-le simplement.",
          prompt: "Extraits :\n\n{{ $json.contexte }}\n\nQuestion : {{ $json.corps.question }}",
        }),
        n("sortie", "donnees.definir", "Réponse du webhook", 840, 0, {
          champs: [
            { nom: "reponse", valeur: "{{ $json.reponse }}" },
            { nom: "sources", valeur: "{{ $json.resultats }}" },
          ],
          conserver: false,
        }),
      ],
      connexions: [c("declencheur", "recherche"), c("recherche", "reponse"), c("reponse", "sortie")],
    },
  },
];

// Mails de la couche comptes (invitation, lien magique, réinitialisation, vérification d'adresse).
// L'envoi est injecté : par défaut les messages sont journalisés ; l'API branche l'envoi SMTP réel.

/** Adresse de contact de l'opérateur, expéditeur par défaut. */
export const EXPEDITEUR = "contact@aphrody.com";

export type ModeleMail = "invitation" | "lien-magique" | "reinitialisation" | "verification" | "code";

export interface MessageMail {
  /** Expéditeur : `AUTO_MAIL_EXPEDITEUR`, par défaut l'adresse de contact de l'opérateur. */
  de: string;
  a: string;
  sujet: string;
  texte: string;
  /** Gabarit et variables, pour un envoyeur qui met en forme. */
  modele: ModeleMail;
  donnees: Record<string, string>;
}

export type EnvoyeurMail = (m: MessageMail) => Promise<void>;

/** Envoyeur par défaut (dev) : journalise le sujet sans lien ni jeton, sans rien envoyer. */
export const envoyeurJournal: EnvoyeurMail = async (m) => {
  if (Bun.env.NODE_ENV === "production") throw new Error("Envoyeur des mails d'authentification non configuré");
  console.info(`[mail non envoyé] à ${m.a} : ${m.sujet}`);
};

let courant: EnvoyeurMail = envoyeurJournal;

/** Branche l'envoi réel (SMTP de l'opérateur) ; les tests y branchent une boîte en mémoire. */
export function brancherEnvoyeur(e: EnvoyeurMail) {
  courant = e;
}

export function envoyerMail(m: Omit<MessageMail, "de">) {
  return courant({ de: Bun.env.AUTO_MAIL_EXPEDITEUR ?? EXPEDITEUR, ...m });
}

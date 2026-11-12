// Envoi transactionnel du SaaS (invitations, alertes) par le relais SMTP de l'opérateur.
import type { Securite } from "./flux";
import { adresseDe, construire, type Adresse, type Message } from "./mime";
import { envoyerSmtp, type ConfigSmtp } from "./smtp";
import { envoyeurResend } from "./resend";

/** Message transactionnel : l'expéditeur par défaut est celui de l'envoyeur. */
export type MessageTransactionnel = Omit<Message, "de"> & { de?: Adresse };

/** Interface commune aux lots : `await envoyeur.envoyer({ a: [...], sujet, texte, html })`. */
export interface EnvoyeurMail {
  envoyer(m: MessageTransactionnel): Promise<{ messageId: string; idFournisseur?: string }>;
}

/** Envoyeur SMTP : construit le message MIME et le transmet au serveur. */
export function envoyeurSmtp(c: ConfigSmtp, expediteur: Adresse): EnvoyeurMail {
  adresseDe(expediteur);
  return {
    async envoyer(m) {
      const x = construire({ ...m, de: m.de ?? expediteur });
      await envoyerSmtp(c, x.expediteur, x.destinataires, x.octets);
      return { messageId: x.messageId };
    },
  };
}

/** Envoyeur des tests : garde les messages construits en mémoire. */
export function envoyeurMemoire(expediteur: Adresse = "no-reply@auto.localhost") {
  const envoyes: (Message & { messageId: string; octets: Uint8Array })[] = [];
  const e: EnvoyeurMail & { envoyes: typeof envoyes } = {
    envoyes,
    async envoyer(m) {
      const complet = { ...m, de: m.de ?? expediteur };
      const x = construire(complet);
      envoyes.push({ ...complet, messageId: x.messageId, octets: x.octets });
      return { messageId: x.messageId };
    },
  };
  return e;
}

/** Lit `Nom <adresse>` ou `adresse`. */
export function lireAdresse(s: string): Adresse {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s);
  return m ? { nom: m[1]!.replace(/^"|"$/g, "") || undefined, adresse: m[2]! } : s.trim();
}

export const EXPEDITEUR_DEFAUT = "Auto <contact@aphrody.com>";

/**
 * Relais de l'opérateur depuis l'environnement (identifiants jamais dans le dépôt) :
 * `AUTO_SMTP_HOTE` (`ssl0.ovh.net`), `AUTO_SMTP_PORT` (465 en `tls`, 587 sinon),
 * `AUTO_SMTP_SECURITE` (`tls` par défaut, `starttls`, `aucune`), `AUTO_SMTP_UTILISATEUR` (par défaut
 * l'adresse d'expédition), `AUTO_SMTP_MOT_DE_PASSE`, `AUTO_SMTP_EXPEDITEUR` (`Auto <contact@aphrody.com>`).
 * Préréglé pour la boîte OVHcloud MX Plan de l'opérateur. `smtp: null` sans mot de passe ni hôte explicite
 * (un hôte explicite sans mot de passe est un relais local sans authentification).
 */
export function configRelais(env: Record<string, string | undefined> = Bun.env) {
  const expediteur = lireAdresse(env.AUTO_SMTP_EXPEDITEUR ?? EXPEDITEUR_DEFAUT);
  adresseDe(expediteur);
  const motDePasse = env.AUTO_SMTP_MOT_DE_PASSE;
  if (!motDePasse && !env.AUTO_SMTP_HOTE) return { expediteur, smtp: null };
  const securite = (env.AUTO_SMTP_SECURITE ?? "tls") as Securite;
  if (!["tls", "starttls", "aucune"].includes(securite)) throw new Error(`AUTO_SMTP_SECURITE invalide : ${securite}`);
  const port = Number(env.AUTO_SMTP_PORT ?? (securite === "tls" ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AUTO_SMTP_PORT invalide");
  if (env.NODE_ENV === "production" && securite === "aucune") throw new Error("SMTP : TLS requis en production");
  const smtp: ConfigSmtp = {
    hote: env.AUTO_SMTP_HOTE ?? "ssl0.ovh.net",
    port,
    securite,
    identifiants: motDePasse
      ? { utilisateur: env.AUTO_SMTP_UTILISATEUR ?? adresseDe(expediteur), motDePasse }
      : undefined,
  };
  return { expediteur, smtp };
}

/** Envoyeur transactionnel du SaaS ; sans relais : journal en console hors production, erreur en production. */
export function envoyeurDepuisEnv(env: Record<string, string | undefined> = Bun.env): EnvoyeurMail {
  const fournisseur = env.AUTO_MAIL_FOURNISSEUR ?? "smtp";
  if (fournisseur === "resend") {
    return envoyeurResend({
      cle: env.AUTO_RESEND_CLE_API ?? "",
      expediteur: lireAdresse(env.AUTO_RESEND_EXPEDITEUR ?? "Auto <auto@notifications.aphrody.com>"),
      repondreA: lireAdresse(env.AUTO_RESEND_REPONDRE_A ?? "auto@aphrody.com"),
    });
  }
  if (fournisseur !== "smtp") throw new Error("AUTO_MAIL_FOURNISSEUR invalide");
  const { expediteur, smtp } = configRelais(env);
  if (smtp) return envoyeurSmtp(smtp, expediteur);
  if (env.NODE_ENV === "production") throw new Error("AUTO_SMTP_MOT_DE_PASSE (ou AUTO_SMTP_HOTE) requis en production");
  return {
    async envoyer(m) {
      const x = construire({ ...m, de: m.de ?? expediteur });
      console.info(`mail non envoyé (pas de relais) → ${x.destinataires.join(", ")} : ${m.sujet}`);
      return { messageId: x.messageId };
    },
  };
}

// Préréglages des fournisseurs courants pour l'écran de connexion de boîte (valeurs dans docs/MAIL.md).
import type { Securite } from "./flux";

export interface Prereglage {
  id: string;
  nom: string;
  imap: { hote: string; port: number; securite: Securite };
  smtp: { hote: string; port: number; securite: Securite };
  /** Conseil affiché à côté du formulaire. */
  note: string;
  doc: string;
}

export const FOURNISSEURS: Prereglage[] = [
  {
    id: "ovh-zimbra",
    nom: "OVHcloud Zimbra Starter",
    imap: { hote: "imap.mail.ovh.net", port: 993, securite: "tls" },
    smtp: { hote: "smtp.mail.ovh.net", port: 465, securite: "tls" },
    note: "Identifiant : l'adresse complète et le mot de passe de la boîte Zimbra. Offre Starter avec IMAP/SMTP.",
    doc: "https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/zimbra/mail-apps",
  },
  {
    id: "ovh-mxplan",
    nom: "OVHcloud MX Plan",
    imap: { hote: "ssl0.ovh.net", port: 993, securite: "tls" },
    smtp: { hote: "ssl0.ovh.net", port: 465, securite: "tls" },
    note: "Identifiant : l'adresse complète. Alias officiels : imap.mail.ovh.net et smtp.mail.ovh.net.",
    doc: "https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/mx-plan/email-generalities",
  },
  {
    id: "ovh-emailpro",
    nom: "OVHcloud E-mail Pro",
    imap: { hote: "pro1.mail.ovh.net", port: 993, securite: "tls" },
    smtp: { hote: "pro1.mail.ovh.net", port: 587, securite: "starttls" },
    note: "Remplacer pro1 par le numéro de serveur affiché dans l'espace client (pro?.mail.ovh.net).",
    doc: "https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/email-pro/outlook-windows-configuration",
  },
  {
    id: "ovh-exchange",
    nom: "OVHcloud Hosted Exchange",
    imap: { hote: "ex5.mail.ovh.net", port: 993, securite: "tls" },
    smtp: { hote: "ex5.mail.ovh.net", port: 587, securite: "starttls" },
    note: "Remplacer ex5 par le serveur indiqué dans l'espace client (ex?.mail.ovh.net) ; IMAP à activer sur le compte.",
    doc: "https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/microsoft-exchange",
  },
  {
    id: "google",
    nom: "Gmail / Google Workspace",
    imap: { hote: "imap.gmail.com", port: 993, securite: "tls" },
    smtp: { hote: "smtp.gmail.com", port: 465, securite: "tls" },
    note: "Mot de passe d'application obligatoire (validation en deux étapes activée), pas le mot de passe du compte.",
    doc: "https://support.google.com/mail/answer/185833",
  },
  {
    id: "microsoft",
    nom: "Outlook.com / Microsoft 365",
    imap: { hote: "outlook.office365.com", port: 993, securite: "tls" },
    smtp: { hote: "smtp.office365.com", port: 587, securite: "starttls" },
    note:
      "Microsoft retire l'authentification par mot de passe (IMAP et SMTP AUTH) au profit d'OAuth 2, non encore " +
      "pris en charge ici : ne fonctionne que si l'administrateur a laissé SMTP AUTH actif.",
    doc: "https://support.microsoft.com/fr-fr/office/paramètres-pop-imap-et-smtp-pour-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
  },
  {
    id: "ionos",
    nom: "IONOS",
    imap: { hote: "imap.ionos.fr", port: 993, securite: "tls" },
    smtp: { hote: "smtp.ionos.fr", port: 465, securite: "tls" },
    note: "Identifiant : l'adresse complète.",
    doc: "https://www.ionos.fr/assistance/email/configurer-une-adresse-email-ionos-dans-un-programme-de-messagerie/",
  },
  {
    id: "orange",
    nom: "Orange",
    imap: { hote: "imap.orange.fr", port: 993, securite: "tls" },
    smtp: { hote: "smtp.orange.fr", port: 465, securite: "tls" },
    note: "Identifiant : l'adresse @orange.fr complète ; mot de passe de la messagerie Orange.",
    doc: "https://assistance.orange.fr/ordinateurs-peripheriques/installer-et-utiliser/l-utilisation-du-mail-et-du-cloud/mail-orange/parametrer-la-boite-mail/",
  },
];

export const prereglage = (id: string) => FOURNISSEURS.find((f) => f.id === id);

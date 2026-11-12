// Envoie un seul message à la boîte configurée et vérifie sa réception IMAP, sans le marquer lu.
import { configRelais, envoyeurSmtp } from "../packages/mail/src/envoyeur";
import { Imap, type ConfigImap } from "../packages/mail/src/imap";
import { adresseDe, analyser, type Adresse } from "../packages/mail/src/mime";
import type { ConfigSmtp } from "../packages/mail/src/smtp";

export async function qualifierMail(smtp: ConfigSmtp, imap: ConfigImap, expediteur: Adresse, delaiMs = 45_000) {
  const debut = Date.now();
  const boite = await Imap.ouvrir(imap);
  try {
    const etat = await boite.examiner(imap.dossier);
    const anciens = await boite.uidsApres(0);
    let dernierUid = anciens.at(-1) ?? 0;
    const marqueur = crypto.randomUUID();
    const contenu = new TextEncoder().encode(`Qualification SMTP/IMAP auto : ${marqueur}\n`);
    const sujet = `Test mail auto ${marqueur}`;
    const { messageId } = await envoyeurSmtp(smtp, expediteur).envoyer({
      a: [adresseDe(expediteur)],
      sujet,
      texte: `Message de vérification automatique. Référence : ${marqueur}`,
      pieces: [{ nom: "diagnostic-auto.txt", type: "text/plain", octets: contenu }],
    });
    while (Date.now() - debut < delaiMs) {
      if ((await boite.examiner(imap.dossier)).uidValidity !== etat.uidValidity)
        throw new Error("UIDVALIDITY modifié pendant le test : relancer la qualification");
      for (const uid of (await boite.uidsApres(dernierUid)).slice(0, 50)) {
        const brut = await boite.lire(uid);
        dernierUid = uid;
        if (!brut) continue;
        const message = analyser(brut);
        if (message.messageId !== messageId) continue;
        const piece = message.pieces.find((p) => p.nom === "diagnostic-auto.txt");
        if (
          message.sujet !== sujet ||
          !message.texte.includes(marqueur) ||
          !piece ||
          !Bun.deepEquals(piece.octets, contenu)
        )
          throw new Error("Message reçu mais contenu ou pièce jointe altéré");
        return { ok: true, messageId, uid, dureeMs: Date.now() - debut };
      }
      await Bun.sleep(1000);
    }
    throw new Error("SMTP accepté, mais réception IMAP non confirmée avant le délai");
  } finally {
    await boite.fermer();
  }
}

if (import.meta.main) {
  try {
    const { smtp, expediteur } = configRelais({ ...Bun.env, NODE_ENV: "production" });
    if (!smtp?.identifiants) throw new Error("Relais SMTP authentifié requis pour le test réel");
    const resultat = await qualifierMail(
      smtp,
      {
        hote: Bun.env.AUTO_IMAP_HOTE ?? "imap.mail.ovh.net",
        port: 993,
        securite: "tls",
        identifiants: {
          utilisateur: Bun.env.AUTO_IMAP_UTILISATEUR ?? smtp.identifiants.utilisateur,
          motDePasse: Bun.env.AUTO_IMAP_MOT_DE_PASSE ?? smtp.identifiants.motDePasse,
        },
      },
      expediteur,
    );
    console.log(JSON.stringify(resultat));
  } catch {
    console.error(
      "Qualification mail échouée : configuration, connexion ou réception non validée. Aucun secret affiché.",
    );
    process.exitCode = 1;
  }
}

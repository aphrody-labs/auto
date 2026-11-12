// API transactionnelle Resend ; SMTP reste disponible par sélection explicite du fournisseur.
import type { EnvoyeurMail } from "./envoyeur";
import { adresseDe, construire, type Adresse } from "./mime";

export interface ConfigResend {
  cle: string;
  expediteur: Adresse;
  repondreA?: Adresse;
  transport?: (url: string, options: RequestInit) => Promise<Response>;
}

const formater = (a: Adresse) =>
  typeof a === "string" || !a.nom ? adresseDe(a) : `${JSON.stringify(a.nom)} <${adresseDe(a)}>`;

/** Pas de repli SMTP automatique après un timeout : l'acceptation distante peut déjà avoir eu lieu. */
export function envoyeurResend(c: ConfigResend): EnvoyeurMail {
  if (!/^re_[A-Za-z0-9_-]+$/.test(c.cle)) throw new Error("AUTO_RESEND_CLE_API invalide");
  adresseDe(c.expediteur);
  if (c.repondreA) adresseDe(c.repondreA);
  return {
    async envoyer(m) {
      const complet = { ...m, de: m.de ?? c.expediteur, repondreA: m.repondreA ?? c.repondreA };
      const mime = construire(complet);
      const r = await (c.transport ?? fetch)("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${c.cle}`,
          "content-type": "application/json",
          "idempotency-key": mime.messageId,
        },
        body: JSON.stringify({
          from: formater(complet.de),
          to: m.a.map(formater),
          ...(m.cc?.length ? { cc: m.cc.map(formater) } : {}),
          ...(complet.repondreA ? { reply_to: formater(complet.repondreA) } : {}),
          subject: m.sujet,
          text: m.texte,
          ...(m.html ? { html: m.html } : {}),
          headers: { "Message-ID": mime.messageId },
          ...(m.pieces?.length
            ? {
                attachments: m.pieces.map((p) => ({
                  filename: p.nom,
                  content_type: p.type,
                  content: p.octets.toBase64(),
                })),
              }
            : {}),
        }),
      });
      if (!r.ok) throw new Error(`Resend : envoi refusé (HTTP ${r.status})`);
      const resultat: unknown = await r.json();
      if (
        !resultat ||
        typeof resultat !== "object" ||
        !("id" in resultat) ||
        typeof resultat.id !== "string" ||
        !resultat.id
      )
        throw new Error("Resend : réponse d'envoi invalide");
      return { messageId: mime.messageId, idFournisseur: resultat.id };
    },
  };
}

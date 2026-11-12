import { expect, test } from "bun:test";
import { envoyeurDepuisEnv } from "./envoyeur";
import { envoyeurResend } from "./resend";

test("Resend : contenu, destinataires, réponse OVH et pièce jointe transmis sans redirection", async () => {
  const e = envoyeurResend({
    cle: "re_factice",
    expediteur: { nom: "Auto", adresse: "auto@notifications.aphrody.com" },
    repondreA: "auto@aphrody.com",
    transport: async (url, options) => {
      expect(url).toBe("https://api.resend.com/emails");
      expect(options?.redirect).toBe("error");
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBe("Bearer re_factice");
      const body = JSON.parse(String(options?.body));
      expect(body.to).toEqual(["client@example.test"]);
      expect(body.cc).toEqual(["copie@example.test"]);
      expect(body.from).toBe('"Auto" <auto@notifications.aphrody.com>');
      expect(body.reply_to).toBe("auto@aphrody.com");
      expect(body.attachments).toEqual([{ filename: "test.txt", content_type: "text/plain", content: "b2s=" }]);
      expect(body.headers["Message-ID"]).toBe(headers.get("idempotency-key"));
      return Response.json({ id: "envoi-factice" });
    },
  });
  const r = await e.envoyer({
    a: ["client@example.test"],
    cc: ["copie@example.test"],
    sujet: "Test",
    texte: "Texte",
    pieces: [{ nom: "test.txt", type: "text/plain", octets: new TextEncoder().encode("ok") }],
  });
  expect(r.messageId).toContain("@notifications.aphrody.com>");
});

test("Resend : refus fournisseur sans contenu sensible ni repli SMTP", async () => {
  const e = envoyeurResend({
    cle: "re_factice",
    expediteur: "auto@notifications.aphrody.com",
    transport: async () => Response.json({ message: "secret fournisseur" }, { status: 429 }),
  });
  await expect(e.envoyer({ a: ["client@example.test"], sujet: "secret sujet", texte: "secret lien" })).rejects.toThrow(
    "Resend : envoi refusé (HTTP 429)",
  );
});

test("Resend : configuration explicite, SMTP toujours sélectionné par défaut", () => {
  expect(() => envoyeurDepuisEnv({ NODE_ENV: "production", AUTO_MAIL_FOURNISSEUR: "resend" })).toThrow(
    "AUTO_RESEND_CLE_API",
  );
  expect(() => envoyeurDepuisEnv({ AUTO_MAIL_FOURNISSEUR: "inconnu" })).toThrow("AUTO_MAIL_FOURNISSEUR");
  expect(() => envoyeurDepuisEnv({ NODE_ENV: "production", AUTO_SMTP_HOTE: "smtp.mail.ovh.net" })).not.toThrow();
});

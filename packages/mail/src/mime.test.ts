import { expect, test } from "bun:test";
import { chiffrer, cleMaitre, dechiffrer } from "./chiffrement";
import { classer } from "./classement";
import { configRelais, envoyeurDepuisEnv, lireAdresse } from "./envoyeur";
import { FOURNISSEURS } from "./fournisseurs";
import { analyser, construire, ErreurMime, quotedPrintable } from "./mime";
import { preparerData } from "./smtp";

const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), 0, 255, 128, 13, 10, 46, 46, 1]);

test("construction puis analyse : en-têtes, texte, HTML, pièce binaire", () => {
  const x = construire(
    {
      de: { nom: "Société Énergie", adresse: "compta@alpha.fr" },
      a: ["client@beta.fr", { nom: 'Jean "JJ" Dupont', adresse: "jean@beta.fr" }],
      sujet: "Facture F-2026-0001 — Société Énergie, échéance au 21 novembre 2026, merci de votre confiance",
      texte: "Bonjour,\n.\nVeuillez trouver la facture ci-jointe : 2 160,00 €.\n",
      html: "<p>Bonjour,</p><p>Total : <b>2 160,00 €</b></p>",
      pieces: [{ nom: "F-2026-0001 é.pdf", type: "application/pdf", octets: pdf }],
    },
    { date: new Date("2026-10-22T10:00:00Z") },
  );
  const brut = new TextDecoder().decode(x.octets);
  expect(brut).toContain("Date: Thu, 22 Oct 2026 10:00:00 +0000");
  expect(brut).toContain("MIME-Version: 1.0");
  expect(brut).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  expect(brut).toContain("filename*=UTF-8''F-2026-0001%20%C3%A9.pdf");
  // Lignes de 998 octets au plus, CRLF partout.
  expect(brut.split("\r\n").every((l) => l.length <= 998 && !l.includes("\n"))).toBe(true);
  expect(x.destinataires).toEqual(["client@beta.fr", "jean@beta.fr"]);
  expect(x.messageId).toMatch(/^<[\w-]+@alpha\.fr>$/);

  const a = analyser(x.octets);
  expect(a.sujet).toBe("Facture F-2026-0001 — Société Énergie, échéance au 21 novembre 2026, merci de votre confiance");
  expect(a.de).toBe("compta@alpha.fr");
  expect(a.a).toEqual(["client@beta.fr", "jean@beta.fr"]);
  expect(a.messageId).toBe(x.messageId);
  expect(a.date?.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  expect(a.texte).toBe("Bonjour,\r\n.\r\nVeuillez trouver la facture ci-jointe : 2 160,00 €.\r\n");
  expect(a.html).toContain("2 160,00 €");
  expect(a.pieces).toHaveLength(1);
  expect(a.pieces[0]!.nom).toBe("F-2026-0001 é.pdf");
  expect(a.pieces[0]!.type).toBe("application/pdf");
  expect(a.pieces[0]!.octets).toEqual(pdf);
});

test("injection d'en-tête et adresses invalides refusées", () => {
  const base = { de: "a@b.fr", a: ["c@d.fr"], texte: "x" };
  expect(() => construire({ ...base, sujet: "x\r\nBcc: e@f.fr" })).toThrow(ErreurMime);
  expect(() => construire({ ...base, sujet: "x", a: ["c@d.fr>\r\nX: y"] })).toThrow(ErreurMime);
  expect(() => construire({ ...base, sujet: "x", a: [] })).toThrow("aucun destinataire");
});

test("quoted-printable : lignes de 76 caractères, = et espaces finaux encodés", () => {
  const qp = quotedPrintable(`${"é".repeat(60)} \na=b\t`);
  expect(qp.split("\r\n").every((l) => l.length <= 76)).toBe(true);
  expect(qp).toContain("a=3Db=09");
  expect(qp).toContain("=20\r\n");
});

test("analyse d'un message externe : multipart imbriqué, RFC 2231, ISO-8859-1, QP", () => {
  const m = [
    "From: =?ISO-8859-1?Q?Fran=E7ois?= <Francois@Exemple.FR>",
    "To: compta@alpha.fr",
    "Subject: =?utf-8?q?Votre_facture?= =?utf-8?b?IG4wwrA0Mg==?=",
    "Date: Wed, 21 Oct 2026 09:30:00 +0200",
    "Message-ID: <abc@exemple.fr>",
    'Content-Type: multipart/mixed; boundary="ext"',
    "",
    "préambule",
    "--ext",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Pi=E8ce jointe, ligne tr=",
    "=E8s longue.",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>ok</p>",
    "--alt--",
    "--ext",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment;",
    " filename*0*=utf-8''r%C3%A9cap;",
    " filename*1=itulatif.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--ext--",
    "",
  ].join("\r\n");
  const a = analyser(new TextEncoder().encode(m));
  expect(a.de).toBe("francois@exemple.fr");
  expect(a.sujet).toBe("Votre facture n0°42");
  expect(a.date?.toISOString()).toBe("2026-10-21T07:30:00.000Z");
  expect(a.texte).toBe("Pièce jointe, ligne très longue.");
  expect(a.html).toBe("<p>ok</p>");
  expect(a.pieces.map((p) => p.nom)).toEqual(["récapitulatif.pdf"]);
  expect(new TextDecoder().decode(a.pieces[0]!.octets)).toBe("%PDF-1.4\n");
});

test("dot-stuffing et terminaison DATA", () => {
  const d = new TextDecoder().decode(preparerData(new TextEncoder().encode(".a\r\nb\r\n..c")));
  expect(d).toBe("..a\r\nb\r\n...c\r\n.\r\n");
});

test("classement : Factur-X, PDF nommé facture, autre", () => {
  const p = (nom: string) => ({ nom, type: "application/pdf", octets: pdf });
  expect(classer("Bonjour", [p("doc.pdf")], () => true)).toEqual({ classement: "facture", facturx: [true] });
  expect(classer("Bonjour", [p("Facture-12.pdf")], () => false).classement).toBe("facture");
  expect(classer("Votre facture", [p("scan.pdf")], () => false).classement).toBe("facture");
  expect(classer("Votre facture", [], () => false).classement).toBe("autre");
  expect(classer("Bonjour", [{ nom: "a.png", type: "image/png", octets: pdf }], () => true)).toEqual({
    classement: "autre",
    facturx: [false],
  });
});

test("chiffrement AES-GCM : clé dérivée par tenant, liée au tenant", async () => {
  const k = "k".repeat(32);
  const c = await chiffrer(k, "t1", "mail", { motDePasse: "secret" });
  expect(new TextDecoder().decode(c)).not.toContain("secret");
  expect(await dechiffrer(k, "t1", "mail", c)).toEqual({ motDePasse: "secret" });
  await expect(dechiffrer(k, "t2", "mail", c)).rejects.toThrow("clé ou tenant incorrect");
  await expect(dechiffrer("x".repeat(32), "t1", "mail", c)).rejects.toThrow();
  expect(() => cleMaitre({ AUTO_CLE_MAITRE: "court" })).toThrow();
});

test("relais de l'opérateur : OVH préréglé, expéditeur contact@aphrody.com, surcharges", () => {
  expect(configRelais({})).toEqual({ expediteur: { nom: "Auto", adresse: "contact@aphrody.com" }, smtp: null });
  expect(configRelais({ AUTO_SMTP_MOT_DE_PASSE: "s" }).smtp).toEqual({
    hote: "ssl0.ovh.net",
    port: 465,
    securite: "tls",
    identifiants: { utilisateur: "contact@aphrody.com", motDePasse: "s" },
  });
  const c = configRelais({
    AUTO_SMTP_HOTE: "relais.local",
    AUTO_SMTP_SECURITE: "starttls",
    AUTO_SMTP_EXPEDITEUR: "x@y.fr",
  });
  expect(c).toEqual({
    expediteur: "x@y.fr",
    smtp: { hote: "relais.local", port: 587, securite: "starttls", identifiants: undefined },
  });
  expect(() => envoyeurDepuisEnv({ NODE_ENV: "production" })).toThrow("requis en production");
  expect(FOURNISSEURS.map((f) => f.id)).toContain("ovh-mxplan");
});

test("adresse d'expéditeur depuis l'environnement", () => {
  expect(lireAdresse("Auto <no-reply@auto.fr>")).toEqual({ nom: "Auto", adresse: "no-reply@auto.fr" });
  expect(lireAdresse("x@y.fr")).toBe("x@y.fr");
});

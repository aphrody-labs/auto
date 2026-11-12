import { expect, test } from "bun:test";
import { boiteJetable, greenmailDisponible } from "../packages/mail/src/greenmail";
import { qualifierMail } from "./test-mail";

test.skipIf(!greenmailDisponible)(
  "qualification SMTP → IMAP : message unique, texte et pièce jointe intacts",
  async () => {
    const boite = boiteJetable("qualification", true);
    const resultat = await qualifierMail(boite.smtp, boite.imap, boite.adresse, 10_000);
    expect(resultat.ok).toBe(true);
    expect(resultat.messageId).toContain("@");
    expect(resultat.uid).toBeGreaterThan(0);
  },
  15_000,
);

import { expect, test } from "bun:test";
import { envoyeurSmtp } from "./envoyeur";
import { boiteJetable, greenmailDisponible } from "./greenmail";
import { relever, testerImap } from "./imap";
import { analyser } from "./mime";
import { envoyerSmtp, testerSmtp } from "./smtp";

const avecGreenmail = test.skipIf(!greenmailDisponible);

avecGreenmail(
  "SMTP en clair puis IMAP : relève depuis le dernier UID",
  async () => {
    const b = boiteJetable("clair");
    await testerSmtp(b.smtp);
    expect((await testerImap(b.imap)).existe).toBe(0);

    const gros = crypto.getRandomValues(new Uint8Array(1_500_000));
    const e = envoyeurSmtp(b.smtp, { nom: "Expéditeur", adresse: "exp@exemple.test" });
    const { messageId } = await e.envoyer({
      a: [b.adresse],
      sujet: "Premier — accentué",
      texte: "Bonjour\n.\nfin",
      pieces: [{ nom: "gros.bin", type: "application/octet-stream", octets: gros }],
    });
    await e.envoyer({ a: [b.adresse], sujet: "Second", texte: "deux" });

    const r1 = await relever(b.imap, { uidValidity: null, dernierUid: 0 });
    expect(r1.messages).toHaveLength(2);
    const m = analyser(r1.messages[0]!.octets);
    expect(m.messageId).toBe(messageId);
    expect(m.sujet).toBe("Premier — accentué");
    expect(m.texte.trim()).toBe("Bonjour\r\n.\r\nfin");
    expect(m.pieces[0]!.octets).toEqual(gros);

    const dernier = r1.messages[1]!.uid;
    const r2 = await relever(b.imap, { uidValidity: r1.uidValidity, dernierUid: dernier });
    expect(r2.messages).toHaveLength(0);
    // UIDVALIDITY différent : tout est relu.
    expect((await relever(b.imap, { uidValidity: r1.uidValidity + 1, dernierUid: dernier })).messages).toHaveLength(2);
  },
  30_000,
);

avecGreenmail(
  "SMTPS et IMAPS (TLS implicite)",
  async () => {
    const b = boiteJetable("tls", true);
    await envoyerSmtp(b.smtp, "exp@exemple.test", [b.adresse], new TextEncoder().encode("Subject: tls\r\n\r\nok\r\n"));
    const r = await relever(b.imap, { uidValidity: null, dernierUid: 0 });
    expect(analyser(r.messages[0]!.octets).sujet).toBe("tls");
    // Certificat auto-signé refusé sans dérogation. Dans un processus à part : un échec de poignée de main
    // TLS après usage de crypto.subtle fait planter le runtime 1.4.6 de façon intermittente.
    const p = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { testerImap } = await import(${JSON.stringify(Bun.fileURLToPath(new URL("./imap.ts", import.meta.url)))});
       await testerImap(${JSON.stringify({ ...b.imap, certificatNonVerifie: false, delaiMs: 5000 })})
         .then(() => console.log("accepté"), (e) => console.log(e.message));`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    expect(await new Response(p.stdout).text()).toContain("certificat refusé");
  },
  30_000,
);

avecGreenmail("erreurs : port fermé, STARTTLS absent", async () => {
  const b = boiteJetable("err");
  await expect(testerSmtp({ ...b.smtp, port: 1 })).rejects.toThrow("connexion impossible");
  await expect(testerSmtp({ ...b.smtp, securite: "starttls" })).rejects.toThrow("STARTTLS non proposé");
});

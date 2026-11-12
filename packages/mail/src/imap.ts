// Client IMAP4rev1 minimal (RFC 3501) : LOGIN, SELECT, UID SEARCH, UID FETCH BODY.PEEK[], LOGOUT.
import { ErreurMail, Flux, type Serveur } from "./flux";
import type { Identifiants } from "./smtp";

export interface ConfigImap extends Serveur {
  identifiants: Identifiants;
  dossier?: string;
}

interface Untagged {
  texte: string;
  litteraux: Uint8Array[];
}

/** Chaîne IMAP entre guillemets (sans CR/LF ni NUL). */
function chaine(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new ErreurMail("IMAP : saut de ligne interdit");
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export class Imap {
  private n = 0;
  private constructor(private readonly f: Flux) {}

  static async ouvrir(c: ConfigImap): Promise<Imap> {
    const f = await Flux.ouvrir(c);
    const i = new Imap(f);
    try {
      const accueil = await f.ligne();
      if (!accueil.startsWith("* OK")) throw new ErreurMail(`IMAP : accueil inattendu : ${accueil}`);
      if (c.securite === "starttls") {
        await i.commande("STARTTLS");
        f.starttls();
      }
      await i.commande(`LOGIN ${chaine(c.identifiants.utilisateur)} ${chaine(c.identifiants.motDePasse)}`, "LOGIN");
    } catch (e) {
      f.fermer();
      throw e;
    }
    return i;
  }

  /** Réponse non étiquetée complète, littéraux `{n}` compris. */
  private async untagged(premiere: string): Promise<Untagged> {
    const u: Untagged = { texte: premiere, litteraux: [] };
    let l = premiere;
    for (let m = /\{(\d+)\+?\}$/.exec(l); m; m = /\{(\d+)\+?\}$/.exec(l)) {
      u.litteraux.push(await this.f.octets(Number(m[1])));
      l = await this.f.ligne();
      u.texte += ` ${l}`;
    }
    return u;
  }

  async commande(cmd: string, quoi = cmd.split(" ")[0]!): Promise<Untagged[]> {
    const tag = `A${++this.n}`;
    await this.f.ecrire(`${tag} ${cmd}\r\n`);
    const res: Untagged[] = [];
    for (;;) {
      const l = await this.f.ligne();
      if (l.startsWith(`${tag} `)) {
        const statut = l.slice(tag.length + 1);
        if (!statut.startsWith("OK")) throw new ErreurMail(`IMAP ${quoi} : ${statut}`);
        return res;
      }
      if (l.startsWith("+")) throw new ErreurMail(`IMAP ${quoi} : continuation inattendue`);
      res.push(await this.untagged(l));
    }
  }

  /** Sélectionne le dossier (lecture seule) ; renvoie UIDVALIDITY et le nombre de messages. */
  async examiner(dossier = "INBOX"): Promise<{ uidValidity: number; existe: number }> {
    const r = await this.commande(`EXAMINE ${chaine(dossier)}`, "EXAMINE");
    let uidValidity = 0;
    let existe = 0;
    for (const u of r) {
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.texte);
      if (v) uidValidity = Number(v[1]);
      const e = /^\* (\d+) EXISTS/i.exec(u.texte);
      if (e) existe = Number(e[1]);
    }
    if (!uidValidity) throw new ErreurMail("IMAP : UIDVALIDITY absent");
    return { uidValidity, existe };
  }

  /** UID strictement supérieurs à `apres`, croissants. */
  async uidsApres(apres: number): Promise<number[]> {
    const r = await this.commande(`UID SEARCH UID ${apres + 1}:*`, "SEARCH");
    const uids = r
      .filter((u) => /^\* SEARCH\b/i.test(u.texte))
      .flatMap((u) => u.texte.slice(8).trim().split(/\s+/).filter(Boolean).map(Number));
    // `n:*` renvoie toujours le dernier message, même si son UID est inférieur à n.
    return [...new Set(uids)].filter((u) => u > apres).sort((x, y) => x - y);
  }

  /** Message brut (sans marquer \Seen). */
  async lire(uid: number): Promise<Uint8Array | null> {
    const r = await this.commande(`UID FETCH ${uid} (UID BODY.PEEK[])`, "FETCH");
    const u = r.find((x) => /^\* \d+ FETCH/i.test(x.texte) && new RegExp(`UID ${uid}\\b`).test(x.texte));
    return u?.litteraux[0] ?? null;
  }

  async fermer() {
    await this.commande("LOGOUT").catch(() => {});
    this.f.fermer();
  }
}

/** Vérifie connexion, TLS, authentification et accès au dossier. */
export async function testerImap(c: ConfigImap): Promise<{ uidValidity: number; existe: number }> {
  const i = await Imap.ouvrir(c);
  try {
    return await i.examiner(c.dossier);
  } finally {
    await i.fermer();
  }
}

export interface MessageBrut {
  uid: number;
  octets: Uint8Array;
}

/**
 * Relève les messages d'UID supérieur à `dernierUid` (au plus `limite`). Si UIDVALIDITY a changé,
 * la numérotation repart de zéro : l'idempotence est assurée par l'appelant (clé UIDVALIDITY + UID).
 */
export async function relever(
  c: ConfigImap,
  etat: { uidValidity: number | null; dernierUid: number },
  limite = 50,
): Promise<{ uidValidity: number; messages: MessageBrut[] }> {
  const i = await Imap.ouvrir(c);
  try {
    const { uidValidity, existe } = await i.examiner(c.dossier);
    const depuis = etat.uidValidity === uidValidity ? etat.dernierUid : 0;
    const messages: MessageBrut[] = [];
    if (existe) {
      for (const uid of (await i.uidsApres(depuis)).slice(0, limite)) {
        const octets = await i.lire(uid);
        if (octets) messages.push({ uid, octets });
      }
    }
    return { uidValidity, messages };
  } finally {
    await i.fermer();
  }
}

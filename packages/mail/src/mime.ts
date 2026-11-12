// MIME (RFC 5322, 2045-2047, 2231) : construction des messages envoyés, analyse des messages reçus.

export type Adresse = string | { nom?: string; adresse: string };

export interface PieceJointe {
  nom: string;
  type: string;
  octets: Uint8Array;
}

export interface Message {
  de: Adresse;
  a: Adresse[];
  cc?: Adresse[];
  repondreA?: Adresse;
  sujet: string;
  texte: string;
  html?: string;
  pieces?: PieceJointe[];
}

export class ErreurMime extends Error {}

const ADRESSE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;

export const adresseValide = (a: string) => ADRESSE.test(a);

/** Adresse nue (enveloppe SMTP). */
export function adresseDe(a: Adresse): string {
  const x = typeof a === "string" ? a : a.adresse;
  if (!adresseValide(x)) throw new ErreurMime(`adresse invalide : ${x}`);
  return x;
}

const sansSautDeLigne = (v: string, quoi: string) => {
  if (/[\r\n\0]/.test(v)) throw new ErreurMime(`${quoi} : saut de ligne interdit`);
  return v;
};

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Mots encodés RFC 2047 (base64 UTF-8), découpés sur des caractères entiers, 75 octets maximum. */
function motsEncodes(s: string): string {
  const mots: string[] = [];
  let cur = "";
  for (const c of s) {
    const essai = cur + c;
    if (Math.ceil(new TextEncoder().encode(essai).length / 3) * 4 > 75 - 12 && cur) {
      mots.push(cur);
      cur = c;
    } else cur = essai;
  }
  if (cur) mots.push(cur);
  return mots.map((m) => `=?UTF-8?B?${new TextEncoder().encode(m).toBase64()}?=`).join("\r\n ");
}

const texteEntete = (s: string) => (ascii(s) && s.length <= 900 ? s : motsEncodes(s));

function formatAdresse(a: Adresse): string {
  const adr = adresseDe(a);
  const nom = typeof a === "string" ? undefined : a.nom && sansSautDeLigne(a.nom, "nom");
  if (!nom) return adr;
  const n = ascii(nom) ? `"${nom.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : motsEncodes(nom);
  return `${n} <${adr}>`;
}

const JOURS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** Date RFC 5322 en UTC. */
export const dateRfc5322 = (d: Date) =>
  `${JOURS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
  `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;

/** Quoted-printable (RFC 2045 §6.7) d'un texte UTF-8, fins de ligne CRLF, lignes de 76 caractères. */
export function quotedPrintable(texte: string): string {
  const lignes = texte.replace(/\r\n|\r|\n/g, "\n").split("\n");
  return lignes
    .map((l) => {
      const o = new TextEncoder().encode(l);
      let out = "";
      let len = 0;
      for (let i = 0; i < o.length; i++) {
        const b = o[i]!;
        const dernier = i === o.length - 1;
        const sur =
          (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !dernier) ? String.fromCharCode(b) : null;
        const t = sur ?? `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
        // Un point en début de ligne est encodé : le message reste sûr même sans dot-stuffing.
        const tok = len === 0 && t === "." ? "=2E" : t;
        if (len + tok.length > 75) {
          out += "=\r\n";
          len = 0;
        }
        out += tok;
        len += tok.length;
      }
      return out;
    })
    .join("\r\n");
}

const base64Lignes = (o: Uint8Array) => (o.toBase64().match(/.{1,76}/g) ?? []).join("\r\n");

/** Paramètre `filename` : ASCII entre guillemets, sinon RFC 2231 (`filename*=UTF-8''…`). */
function parametreNom(cle: string, nom: string): string {
  sansSautDeLigne(nom, "nom de fichier");
  if (ascii(nom) && !/["\\]/.test(nom)) return `${cle}="${nom}"`;
  return `${cle}*=UTF-8''${encodeURIComponent(nom).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

const frontiere = () => `=_auto_${crypto.randomUUID().replaceAll("-", "")}`;

export interface Construit {
  octets: Uint8Array;
  messageId: string;
  destinataires: string[];
  expediteur: string;
}

/** Construit un message RFC 5322 : multipart/mixed (alternative texte et HTML, puis pièces jointes). */
export function construire(m: Message, o: { date?: Date; domaine?: string } = {}): Construit {
  const expediteur = adresseDe(m.de);
  const destinataires = [...m.a, ...(m.cc ?? [])].map(adresseDe);
  if (!destinataires.length) throw new ErreurMime("aucun destinataire");
  const domaine = o.domaine ?? expediteur.split("@")[1]!;
  const messageId = `<${Bun.randomUUIDv7()}@${domaine}>`;
  const e: string[] = [
    `Date: ${dateRfc5322(o.date ?? new Date())}`,
    `From: ${formatAdresse(m.de)}`,
    `To: ${m.a.map(formatAdresse).join(",\r\n ")}`,
  ];
  if (m.cc?.length) e.push(`Cc: ${m.cc.map(formatAdresse).join(",\r\n ")}`);
  if (m.repondreA) e.push(`Reply-To: ${formatAdresse(m.repondreA)}`);
  e.push(`Message-ID: ${messageId}`, `Subject: ${texteEntete(sansSautDeLigne(m.sujet, "sujet"))}`, "MIME-Version: 1.0");

  const texte = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(m.texte),
  ];
  let corps: string[];
  if (m.html) {
    const b = frontiere();
    corps = [
      `Content-Type: multipart/alternative; boundary="${b}"`,
      "",
      `--${b}`,
      ...texte,
      `--${b}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintable(m.html),
      `--${b}--`,
    ];
  } else corps = texte;

  if (m.pieces?.length) {
    const b = frontiere();
    const parts = [
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      "Ce message est au format MIME.",
      `--${b}`,
      ...corps,
    ];
    for (const p of m.pieces) {
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(p.type)) throw new ErreurMime(`type de pièce invalide : ${p.type}`);
      parts.push(
        `--${b}`,
        `Content-Type: ${p.type}; ${parametreNom("name", p.nom)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; ${parametreNom("filename", p.nom)}`,
        "",
        base64Lignes(p.octets),
      );
    }
    parts.push(`--${b}--`);
    corps = parts;
  }
  const octets = new TextEncoder().encode([...e, ...corps].join("\r\n") + "\r\n");
  return { octets, messageId, destinataires, expediteur };
}

// Analyse ---------------------------------------------------------------------------------------

/** Octets → chaîne binaire (un caractère par octet), pour découper sans décoder. */
function binaire(o: Uint8Array): string {
  let s = "";
  for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode(...o.subarray(i, i + 0x8000));
  return s;
}

function octetsDe(s: string): Uint8Array {
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xff;
  return o;
}

function decoder(o: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(o);
  } catch {
    return new TextDecoder().decode(o);
  }
}

function decoderQp(s: string, entete = false): Uint8Array {
  if (entete) s = s.replaceAll("_", " ");
  s = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "=" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function decoderBase64(s: string): Uint8Array {
  const net = s.replace(/[^A-Za-z0-9+/]/g, "");
  try {
    return Uint8Array.fromBase64(net.padEnd(Math.ceil(net.length / 4) * 4, "="));
  } catch {
    return new Uint8Array();
  }
}

/** Décode les mots encodés RFC 2047 d'un en-tête (déjà en chaîne binaire). */
export function decoderEntete(v: string): string {
  const s = v.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1");
  const parts: string[] = [];
  let i = 0;
  for (const m of s.matchAll(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g)) {
    parts.push(decoder(octetsDe(s.slice(i, m.index))));
    const o = m[2]!.toLowerCase() === "b" ? decoderBase64(m[3]!) : decoderQp(m[3]!, true);
    parts.push(decoder(o, m[1]));
    i = m.index + m[0].length;
  }
  parts.push(decoder(octetsDe(s.slice(i))));
  return parts.join("");
}

type Entetes = Map<string, string[]>;

function lireEntetes(bloc: string): Entetes {
  const h: Entetes = new Map();
  for (const l of bloc.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    h.set(k, [...(h.get(k) ?? []), l.slice(i + 1).trim()]);
  }
  return h;
}

/** `type/sous-type; a=b; c="d"` avec les continuations RFC 2231. */
function lireParametres(v: string): { valeur: string; params: Record<string, string> } {
  const morceaux: string[] = [];
  let cur = "";
  let guillemets = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "\\" && guillemets) {
      cur += v[++i] ?? "";
      continue;
    }
    if (c === '"') guillemets = !guillemets;
    else if (c === ";" && !guillemets) {
      morceaux.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  morceaux.push(cur);
  const params: Record<string, string> = {};
  const etendus = new Map<string, { i: number; v: string; enc: boolean }[]>();
  for (const p of morceaux.slice(1)) {
    const j = p.indexOf("=");
    if (j < 0) continue;
    const k = p.slice(0, j).trim().toLowerCase();
    let val = p.slice(j + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(k);
    if (m && (m[2] !== undefined || m[3])) {
      etendus.set(m[1]!, [...(etendus.get(m[1]!) ?? []), { i: Number(m[2] ?? 0), v: val, enc: !!m[3] }]);
    } else params[k] = k === "name" || k === "filename" ? decoderEntete(val) : val;
  }
  for (const [k, l] of etendus) {
    l.sort((x, y) => x.i - y.i);
    let charset = "utf-8";
    const o: number[] = [];
    for (const { i, v: val, enc } of l) {
      let s = val;
      if (enc && i === 0) {
        const m = /^([^']*)'[^']*'(.*)$/.exec(s);
        if (m) {
          charset = m[1] || charset;
          s = m[2]!;
        }
      }
      if (enc) s = s.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      o.push(...octetsDe(s));
    }
    params[k] = decoder(new Uint8Array(o), charset);
  }
  return { valeur: morceaux[0]!.trim().toLowerCase(), params };
}

export interface Analyse {
  messageId: string | null;
  de: string | null;
  a: string[];
  sujet: string;
  date: Date | null;
  texte: string;
  html: string | null;
  pieces: PieceJointe[];
}

/** Adresses d'un en-tête `To`/`From` : `Nom <a@b>, c@d`. */
function lireAdresses(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const m of decoderEntete(v).matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s<>,;:"]+@[^\s<>,;:"]+)/g)) {
    out.push((m[1] ?? m[2])!.toLowerCase());
  }
  return out;
}

function decoderCorps(corps: string, cte: string | undefined): Uint8Array {
  switch ((cte ?? "").trim().toLowerCase()) {
    case "base64":
      return decoderBase64(corps);
    case "quoted-printable":
      return decoderQp(corps);
    default:
      return octetsDe(corps);
  }
}

function separer(s: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return [s, ""];
  if (m.index === 0) return ["", s.slice(m[0].length)];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}

function parcourir(partie: string, a: Analyse, profondeur: number) {
  if (profondeur > 20) return;
  const [bloc, corps] = separer(partie);
  const h = lireEntetes(bloc);
  const ct = lireParametres(h.get("content-type")?.[0] ?? "text/plain");
  const cd = lireParametres(h.get("content-disposition")?.[0] ?? "");
  const nom = cd.params.filename ?? ct.params.name;

  if (ct.valeur.startsWith("multipart/") && ct.params.boundary) {
    const b = `--${ct.params.boundary}`;
    const morceaux = corps.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    for (const m of morceaux.slice(1)) {
      if (m.startsWith("--")) break;
      parcourir(m.replace(/^[ \t]*\r?\n/, ""), a, profondeur + 1);
    }
    return;
  }
  const octets = decoderCorps(corps, h.get("content-transfer-encoding")?.[0]);
  const piece = cd.valeur === "attachment" || nom !== undefined || !ct.valeur.startsWith("text/");
  if (!piece && ct.valeur === "text/plain" && !a.texte) a.texte = decoder(octets, ct.params.charset);
  else if (!piece && ct.valeur === "text/html" && a.html === null) a.html = decoder(octets, ct.params.charset);
  else if (piece)
    a.pieces.push({
      nom: (nom ?? `piece-${a.pieces.length + 1}`).replace(/[/\\\0]/g, "_"),
      type: ct.valeur,
      octets,
    });
}

/** Analyse un message reçu : en-têtes principaux, corps texte et HTML, pièces jointes décodées. */
export function analyser(o: Uint8Array): Analyse {
  const s = binaire(o);
  const [bloc] = separer(s);
  const h = lireEntetes(bloc);
  const date = h.get("date")?.[0];
  const t = date ? Date.parse(date) : NaN;
  const a: Analyse = {
    messageId: h.get("message-id")?.[0]?.trim() ?? null,
    de: lireAdresses(h.get("from")?.[0])[0] ?? null,
    a: [...lireAdresses(h.get("to")?.join(",")), ...lireAdresses(h.get("cc")?.join(","))],
    sujet: decoderEntete(h.get("subject")?.[0] ?? ""),
    date: Number.isNaN(t) ? null : new Date(t),
    texte: "",
    html: null,
    pieces: [],
  };
  parcourir(s, a, 0);
  return a;
}

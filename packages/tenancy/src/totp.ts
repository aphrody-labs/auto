// TOTP (RFC 6238) sur HOTP (RFC 4226), HMAC par crypto.subtle. Base32 RFC 4648 sans remplissage.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(octets: Uint8Array): string {
  let bits = 0;
  let valeur = 0;
  let sortie = "";
  for (const o of octets) {
    valeur = (valeur << 8) | o;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += ALPHABET[(valeur << (5 - bits)) & 31];
  return sortie;
}

export function depuisBase32(texte: string): Uint8Array<ArrayBuffer> {
  const propre = texte.toUpperCase().replace(/[\s=-]/g, "");
  const sortie: number[] = [];
  let bits = 0;
  let valeur = 0;
  for (const c of propre) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`base32 : caractère invalide « ${c} »`);
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      sortie.push((valeur >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(sortie);
}

export type Algorithme = "SHA-1" | "SHA-256" | "SHA-512";

/** HOTP : HMAC(secret, compteur sur 8 octets gros-boutiste), troncature dynamique. */
export async function hotp(
  secret: Uint8Array<ArrayBuffer>,
  compteur: number,
  chiffres = 6,
  algo: Algorithme = "SHA-1",
) {
  const cle = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: algo }, false, ["sign"]);
  const message = new DataView(new ArrayBuffer(8));
  message.setBigUint64(0, BigInt(compteur));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", cle, message.buffer));
  const o = h[h.length - 1]! & 0x0f;
  const binaire = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(binaire % 10 ** chiffres).padStart(chiffres, "0");
}

export const PERIODE = 30;

/** Pas de temps T = floor(unix / 30). */
export const pas = (instantMs: number, periode = PERIODE) => Math.floor(instantMs / 1000 / periode);

export function totp(
  secret: Uint8Array<ArrayBuffer>,
  instantMs = Date.now(),
  chiffres = 6,
  algo: Algorithme = "SHA-1",
): Promise<string> {
  return hotp(secret, pas(instantMs), chiffres, algo);
}

/**
 * Vérifie un code à ±`fenetre` pas (dérive d'horloge) ; renvoie le pas reconnu, pour refuser
 * ensuite tout code d'un pas déjà utilisé (rejeu).
 */
export async function verifierTotp(
  secret: Uint8Array<ArrayBuffer>,
  code: string,
  instantMs = Date.now(),
  fenetre = 1,
): Promise<number | null> {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const t = pas(instantMs);
  let trouve: number | null = null;
  // Toutes les candidates sont calculées : durée indépendante de la position du code.
  for (let d = -fenetre; d <= fenetre; d++) {
    const attendu = await hotp(secret, t + d);
    if (egal(attendu, c) && trouve === null) trouve = t + d;
  }
  return trouve;
}

function egal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** URI d'enrôlement lue par les applications d'authentification (format Google Authenticator). */
export function uriOtpauth(secretBase32: string, compte: string, emetteur = "auto") {
  const libelle = `${encodeURIComponent(emetteur)}:${encodeURIComponent(compte)}`;
  const q = new URLSearchParams({
    secret: secretBase32,
    issuer: emetteur,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${libelle}?${q}`;
}

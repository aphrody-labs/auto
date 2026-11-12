// Identifiants de PA chiffrés au repos : AES-256-GCM, clé dérivée par HKDF-SHA256 du secret maître
// (AUTO_CLE_MAITRE) et du tenant. Le tenant est aussi la donnée authentifiée : un chiffré copié vers
// un autre tenant ne se déchiffre pas.

const enc = new TextEncoder();
const VERSION = 1;
const SEL = enc.encode("auto/pa/identifiants/v1");

async function cle(maitre: string, tenantId: string): Promise<CryptoKey> {
  if (maitre.length < 32) throw new Error("AUTO_CLE_MAITRE : au moins 32 caractères");
  const base = await crypto.subtle.importKey("raw", enc.encode(maitre), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SEL, info: enc.encode(tenantId) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Chiffré : octet de version, IV de 12 octets, puis texte chiffré et étiquette GCM. */
export async function chiffrer(maitre: string, tenantId: string, valeur: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(tenantId) },
    await cle(maitre, tenantId),
    enc.encode(JSON.stringify(valeur)),
  );
  const out = new Uint8Array(1 + 12 + ct.byteLength);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(new Uint8Array(ct), 13);
  return out;
}

export async function dechiffrer<T>(maitre: string, tenantId: string, chiffre: Uint8Array): Promise<T> {
  if (chiffre[0] !== VERSION) throw new Error("identifiants : version de chiffrement inconnue");
  const clair = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: chiffre.slice(1, 13), additionalData: enc.encode(tenantId) },
    await cle(maitre, tenantId),
    chiffre.slice(13),
  );
  return JSON.parse(new TextDecoder().decode(clair)) as T;
}

/** HMAC-SHA256 hexadécimal. */
export const hmac = (secret: string, donnees: string) =>
  new Bun.CryptoHasher("sha256", secret).update(donnees).digest("hex");

/** Comparaison en temps constant de deux chaînes. */
export function egal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const sha256 = (o: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(o).digest("hex");

/** Secret aléatoire (256 bits, hexadécimal). */
export const secretAleatoire = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

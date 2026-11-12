// Secrets au repos : AES-256-GCM, clé dérivée par HKDF-SHA-256 de la clé maître et du tenant.

const VERSION = 1;
const enc = (s: string) => new TextEncoder().encode(s);

export class ErreurCle extends Error {}

/** Clé maître de l'opérateur (`AUTO_CLE_MAITRE`), 32 caractères au moins. */
export function cleMaitre(env: Record<string, string | undefined> = Bun.env): string {
  const k = env.AUTO_CLE_MAITRE;
  if (!k || k.length < 32) throw new ErreurCle("AUTO_CLE_MAITRE absente ou trop courte (32 caractères au moins)");
  return k;
}

async function cle(maitre: string, tenantId: string, usage: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc(maitre), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc(tenantId), info: enc(`auto/${usage}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Chiffre une valeur JSON pour un tenant : `version ‖ nonce (12) ‖ chiffré + étiquette`. Le tenant est
 * aussi en données associées : un secret recopié chez un autre tenant ne se déchiffre pas.
 */
export async function chiffrer(maitre: string, tenantId: string, usage: string, valeur: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc(tenantId) },
    await cle(maitre, tenantId, usage),
    enc(JSON.stringify(valeur)),
  );
  const out = new Uint8Array(13 + c.byteLength);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(new Uint8Array(c), 13);
  return out;
}

export async function dechiffrer<T>(maitre: string, tenantId: string, usage: string, o: Uint8Array): Promise<T> {
  if (o[0] !== VERSION || o.length < 29) throw new ErreurCle("secret chiffré illisible");
  try {
    const clair = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: o.slice(1, 13), additionalData: enc(tenantId) },
      await cle(maitre, tenantId, usage),
      o.slice(13),
    );
    return JSON.parse(new TextDecoder().decode(clair)) as T;
  } catch {
    throw new ErreurCle("secret chiffré : clé ou tenant incorrect");
  }
}

// Chiffrement au repos : AES-256-GCM (crypto.subtle), clé dérivée par HKDF-SHA256 d'un secret maître.
//
// Secret maître : `AUTO_CLE_MAITRE` (32 octets en base64, ou toute chaîne longue). Chaque usage dérive
// sa propre clé avec un `info` distinct (`totp:<utilisateur>`, `sauvegarde`, …) : une clé dérivée
// compromise n'ouvre pas les autres données, et un chiffré copié vers un autre utilisateur ne se
// déchiffre pas (l'info sert aussi de donnée authentifiée).
//
// Sans `AUTO_CLE_MAITRE`, une clé de développement fixe est utilisée (CLE_DEV ci-dessous) ; elle est
// refusée en production (`NODE_ENV=production`). Perdre la clé maître rend illisibles les secrets 2FA
// et les sauvegardes : elle se conserve hors de la base, dans le coffre de l'hébergeur.

export const CLE_DEV = "auto-dev-cle-maitre-a-ne-jamais-utiliser-en-production";

const VERSION = 1;
const SEL = new TextEncoder().encode("auto/chiffrement/v1");

export function cleMaitre(env = Bun.env): Uint8Array<ArrayBuffer> {
  const v = env.AUTO_CLE_MAITRE;
  if (!v) {
    if (env.NODE_ENV === "production") throw new Error("AUTO_CLE_MAITRE requis en production");
    return new TextEncoder().encode(CLE_DEV);
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(v)) return Uint8Array.fromBase64(v);
  if (v.length < 32) throw new Error("AUTO_CLE_MAITRE : 32 caractères minimum (ou 32 octets en base64)");
  return new TextEncoder().encode(v);
}

async function deriver(info: string, maitre: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey("raw", maitre, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SEL, info: new TextEncoder().encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Format : version (1 octet) ‖ nonce (12 octets) ‖ chiffré + étiquette GCM. */
export async function chiffrer(info: string, clair: Uint8Array<ArrayBuffer>, maitre = cleMaitre()) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cle = await deriver(info, maitre);
  const c = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(info) }, cle, clair),
  );
  const sortie = new Uint8Array(1 + 12 + c.length);
  sortie[0] = VERSION;
  sortie.set(iv, 1);
  sortie.set(c, 13);
  return sortie;
}

export async function dechiffrer(info: string, blob: Uint8Array, maitre = cleMaitre()) {
  if (blob[0] !== VERSION || blob.length < 13 + 16) throw new Error("chiffré : format inconnu");
  const cle = await deriver(info, maitre);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(1, 13), additionalData: new TextEncoder().encode(info) },
      cle,
      blob.slice(13),
    ),
  );
}

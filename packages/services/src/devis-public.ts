// Lien public d'un devis : le client le consulte, télécharge le PDF et l'accepte ou le refuse sans compte.
// Jeton sans état : `<charge base64url>.<HMAC-SHA256 base64url>`, clé dérivée (HKDF) de la clé maître avec un
// usage propre ; la charge porte l'entreprise, le devis et l'expiration. Révoqué de fait dès que le devis quitte
// les statuts « émis » ou « envoyé » (la décision n'est plus possible).
import { cleMaitre } from "@auto/tenancy";

/** Durée de validité d'un lien (au-delà, l'émetteur en génère un nouveau). */
export const DUREE_LIEN_MS = 30 * 24 * 3600 * 1000;

export interface ChargeLien {
  /** Entreprise émettrice. */
  t: string;
  /** Devis. */
  d: string;
  /** Expiration (ms depuis l'époque). */
  e: number;
}

const b64 = (o: Uint8Array) => o.toBase64({ alphabet: "base64url", omitPadding: true });

async function cle(maitre: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey("raw", maitre, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("auto/devis-public/v1"),
      info: new TextEncoder().encode("devis-public"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signerLien(c: ChargeLien, maitre = cleMaitre()): Promise<string> {
  const charge = b64(new TextEncoder().encode(JSON.stringify(c)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await cle(maitre), new TextEncoder().encode(charge)));
  return `${charge}.${b64(sig)}`;
}

/** Charge du jeton si la signature est valide et le lien non expiré, sinon null. */
export async function verifierLien(jeton: string, maitre = cleMaitre(), maintenant = Date.now()) {
  const [charge, sig, ...reste] = jeton.split(".");
  if (!charge || !sig || reste.length) return null;
  let octets: Uint8Array<ArrayBuffer>;
  try {
    octets = Uint8Array.fromBase64(sig, { alphabet: "base64url" });
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", await cle(maitre), octets, new TextEncoder().encode(charge));
  if (!ok) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(charge, { alphabet: "base64url" })));
    if (typeof c?.t !== "string" || typeof c?.d !== "string" || typeof c?.e !== "number") return null;
    return c.e > maintenant ? (c as ChargeLien) : null;
  } catch {
    return null;
  }
}

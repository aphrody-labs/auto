// At-rest vault encryption: prefers Rust `auto-auth` ChaCha20-Poly1305 AEAD via Wasm (`VERSION = 2`)
// with Web Crypto AES-256-GCM + HKDF-SHA256 (`VERSION = 1`) compatibility fallback.
import { authOpenSecret, authSealSecret, isEnglishWasmReady } from "@aphrody/auto-native";

export const DEV_MASTER_KEY = "auto-dev-master-key-do-not-use-in-production";

const VERSION_AES_GCM = 1;
const VERSION_RUST_CHACHA = 2;
const SALT = new TextEncoder().encode("auto/vault/v1");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const keyHex = (keyMaterial: Uint8Array): string =>
  Array.from(keyMaterial, (b) => b.toString(16).padStart(2, "0")).join("");

export function masterKey(env: Record<string, string | undefined> = process.env): Uint8Array<ArrayBuffer> {
  const raw = env.AUTO_MASTER_KEY?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("AUTO_MASTER_KEY is required in production");
    }
    return encoder.encode(DEV_MASTER_KEY);
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    const decoded = atob(raw);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    return out;
  }
  if (raw.length < 32) {
    throw new Error("AUTO_MASTER_KEY must be at least 32 characters (or 32-byte base64)");
  }
  return encoder.encode(raw);
}

async function deriveSubkey(info: string, keyMaterial: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", keyMaterial, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveAuthSecret(env: Record<string, string | undefined> = process.env): Promise<string> {
  const key = await crypto.subtle.importKey("raw", masterKey(env), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("auto/better-auth/v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Envelope format:
 * - `v = 2`: `0x02 || utf8(auto-auth ChaCha20-Poly1305 sealed token)`
 * - `v = 1`: `0x01 || iv (12 bytes) || aes-gcm ciphertext+tag`
 */
export async function encryptSecret(
  info: string,
  plaintext: Uint8Array<ArrayBuffer>,
  keyMaterial = masterKey(),
): Promise<Uint8Array<ArrayBuffer>> {
  if (isEnglishWasmReady()) {
    const sealed = encoder.encode(authSealSecret(keyHex(keyMaterial), info, plaintext));
    const out = new Uint8Array(1 + sealed.length);
    out[0] = VERSION_RUST_CHACHA;
    out.set(sealed, 1);
    return out;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const subkey = await deriveSubkey(info, keyMaterial);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(info) }, subkey, plaintext),
  );
  const out = new Uint8Array(1 + 12 + cipher.length);
  out[0] = VERSION_AES_GCM;
  out.set(iv, 1);
  out.set(cipher, 13);
  return out;
}

export async function decryptSecret(
  info: string,
  envelope: Uint8Array,
  keyMaterial = masterKey(),
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope[0] === VERSION_RUST_CHACHA) {
    if (!isEnglishWasmReady()) {
      throw new Error("Rust native Wasm is required to open v2 ChaCha20-Poly1305 secret envelopes");
    }
    return authOpenSecret(keyHex(keyMaterial), info, decoder.decode(envelope.subarray(1)));
  }
  if (envelope[0] !== VERSION_AES_GCM || envelope.length < 13 + 16) {
    throw new Error("Encrypted payload has invalid version or length");
  }
  const subkey = await deriveSubkey(info, keyMaterial);
  const iv = new Uint8Array(envelope.slice(1, 13));
  const cipher = new Uint8Array(envelope.slice(13));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(info) },
    subkey,
    cipher,
  );
  return new Uint8Array(plain);
}

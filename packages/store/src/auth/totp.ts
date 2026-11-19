// RFC 6238 TOTP & RFC 4226 HOTP delegating standard 6-digit SHA-1 TOTP to Rust `auto-auth`
// when Wasm is initialized, with Web Crypto (`crypto.subtle`) fallback, plus unpadded RFC 4648 Base32.
import { authTotpCode, isEnglishWasmReady } from "@aphrody/auto-native";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(encoded: string): Uint8Array<ArrayBuffer> {
  const clean = encoded.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid Base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export const TOTP_PERIOD_SECONDS = 30;

export const totpStep = (timeMs: number, periodSec = TOTP_PERIOD_SECONDS): number =>
  Math.floor(timeMs / 1000 / periodSec);

export async function hotp(
  secret: Uint8Array<ArrayBuffer>,
  counter: number,
  digits = 6,
  algorithm: TotpAlgorithm = "SHA-1",
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const msg = new DataView(new ArrayBuffer(8));
  msg.setBigUint64(0, BigInt(counter));
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer));
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(
  secret: Uint8Array<ArrayBuffer>,
  timeMs = Date.now(),
  digits = 6,
  algorithm: TotpAlgorithm = "SHA-1",
): Promise<string> {
  if (digits === 6 && algorithm === "SHA-1" && isEnglishWasmReady()) {
    return Promise.resolve(authTotpCode(encodeBase32(secret), Math.floor(timeMs / 1000)).code);
  }
  return hotp(secret, totpStep(timeMs), digits, algorithm);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a 6-digit TOTP code within `window` steps and return the matched step (for replay protection). */
export async function verifyTotp(
  secret: Uint8Array<ArrayBuffer>,
  code: string,
  timeMs = Date.now(),
  window = 1,
): Promise<number | null> {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const center = totpStep(timeMs);
  let matchedStep: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const candidate = await hotp(secret, center + delta);
    if (constantTimeEq(candidate, clean) && matchedStep === null) {
      matchedStep = center + delta;
    }
  }
  return matchedStep;
}

export function otpauthUri(issuer: string, account: string, secret: Uint8Array): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${encodeBase32(secret)}&issuer=${encodeURIComponent(issuer)}&digits=6&period=${TOTP_PERIOD_SECONDS}`;
}

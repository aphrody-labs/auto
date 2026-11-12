import { expect, test } from "bun:test";
import { chiffrer, cleMaitre, dechiffrer } from "./chiffrement";
import { base32, depuisBase32, hotp, totp, uriOtpauth, verifierTotp, type Algorithme } from "./totp";

const ascii = (s: string) => new TextEncoder().encode(s);

test("HOTP : vecteurs de la RFC 4226 (annexe D)", async () => {
  const secret = ascii("12345678901234567890");
  const attendus = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (const [i, code] of attendus.entries()) expect(await hotp(secret, i)).toBe(code);
});

test("TOTP : vecteurs de la RFC 6238 (annexe B), 8 chiffres, SHA-1/256/512", async () => {
  const graines: Record<Algorithme, Uint8Array<ArrayBuffer>> = {
    "SHA-1": ascii("12345678901234567890"),
    "SHA-256": ascii("12345678901234567890123456789012"),
    "SHA-512": ascii("1234567890123456789012345678901234567890123456789012345678901234"),
  };
  const vecteurs: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [t, sha1, sha256, sha512] of vecteurs) {
    expect(await totp(graines["SHA-1"], t * 1000, 8, "SHA-1")).toBe(sha1);
    expect(await totp(graines["SHA-256"], t * 1000, 8, "SHA-256")).toBe(sha256);
    expect(await totp(graines["SHA-512"], t * 1000, 8, "SHA-512")).toBe(sha512);
  }
});

test("vérification : fenêtre de ±1 pas, pas reconnu renvoyé", async () => {
  const s = ascii("12345678901234567890");
  const t = 1111111111 * 1000;
  const code = await totp(s, t);
  expect(await verifierTotp(s, code, t)).toBe(Math.floor(1111111111 / 30));
  expect(await verifierTotp(s, code, t + 30_000)).toBe(Math.floor(1111111111 / 30));
  expect(await verifierTotp(s, code, t + 90_000)).toBeNull();
  expect(await verifierTotp(s, "abc", t)).toBeNull();
});

test("base32 RFC 4648 et URI otpauth", () => {
  expect(base32(ascii("foobar"))).toBe("MZXW6YTBOI");
  expect(base32(ascii("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  expect(new TextDecoder().decode(depuisBase32("mzxw 6ytb-oi"))).toBe("foobar");
  const uri = uriOtpauth("MZXW6YTBOI", "a@exemple.fr");
  expect(uri).toStartWith("otpauth://totp/auto:a%40exemple.fr?secret=MZXW6YTBOI&issuer=auto");
});

test("chiffrement au repos : AES-GCM, clé HKDF liée à l'info", async () => {
  const clair = ascii("secret totp");
  const c = await chiffrer("totp:u1", clair);
  expect(c[0]).toBe(1);
  expect(new TextDecoder().decode(await dechiffrer("totp:u1", c))).toBe("secret totp");
  // Chiffré déplacé vers un autre utilisateur, ou altéré : refusé.
  await expect(dechiffrer("totp:u2", c)).rejects.toThrow();
  const altere = c.slice();
  altere[20]! ^= 1;
  await expect(dechiffrer("totp:u1", altere)).rejects.toThrow();
  const autre = new Uint8Array(32).fill(7);
  await expect(dechiffrer("totp:u1", c, autre)).rejects.toThrow();
  expect(cleMaitre({ AUTO_CLE_MAITRE: autre.toBase64() })).toEqual(autre);
  expect(() => cleMaitre({ NODE_ENV: "production" })).toThrow("AUTO_CLE_MAITRE");
  expect(() => cleMaitre({ AUTO_CLE_MAITRE: "court" })).toThrow();
});

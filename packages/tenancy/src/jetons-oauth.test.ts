import { expect, test } from "bun:test";
import { testDb } from "@auto/store";
import { setTokenUtil, decryptOAuthToken } from "better-auth/oauth2";
import { creerAuth } from "./auth";
import { betterAuth, type BetterAuthOptions } from "better-auth";
test("Jetons OAuth SSO : chiffrement officiel et reprise des anciens jetons sans couper les connexions", async () => {
  const { sql, drop } = await testDb();
  try {
    const ba = creerAuth(sql, {
      baseURL: "https://auto.example.test",
      secret: "cle-auth-test-chiffrement-0123456789abcdef",
    });
    const options: BetterAuthOptions = {
      secret: ba.options.secret,
      baseURL: ba.options.baseURL,
      account: ba.options.account,
      logger: { disabled: true },
    };
    const ctx = await betterAuth(options).$context;
    expect(ba.options.account?.encryptOAuthTokens).toBe(true);
    const secret = "ya29.factice-de-recette",
      chiffre = await setTokenUtil(secret, ctx);
    expect(chiffre).not.toBe(secret);
    expect(await decryptOAuthToken(chiffre!, ctx)).toBe(secret);
    expect(await decryptOAuthToken("ya29.ancien-jeton-factice", ctx)).toBe("ya29.ancien-jeton-factice");
  } finally {
    await drop();
  }
}, 30000);

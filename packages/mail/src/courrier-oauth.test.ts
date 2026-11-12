import { expect, test } from "bun:test";
import { autorisationCourrier, configurationCourrier, urlGraphCourrier, echangerCourrier } from "./courrier-oauth";
test("Outlook : un curseur ne peut pas transmettre le jeton hors de Graph", () => {
  for (const u of [
    "https://evil.example/v1.0/me/messages",
    "https://graph.microsoft.com.evil.example/v1.0/me/messages",
    "https://a:b@graph.microsoft.com/v1.0/me/messages",
    "https://graph.microsoft.com/v1.0/users/other/messages",
    "http://graph.microsoft.com/v1.0/me/messages",
  ])
    expect(() => urlGraphCourrier(u)).toThrow();
  expect(
    urlGraphCourrier("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=123"),
  ).toContain("deltatoken");
});
test("OAuth mail : lecture seule, PKCE et retour fixe indépendant de la requête", async () => {
  const precedent = {
    AUTO_URL_APP: Bun.env.AUTO_URL_APP,
    AUTO_GOOGLE_CLIENT_ID: Bun.env.AUTO_GOOGLE_CLIENT_ID,
    AUTO_GOOGLE_CLIENT_SECRET: Bun.env.AUTO_GOOGLE_CLIENT_SECRET,
  };
  Object.assign(Bun.env, {
    AUTO_URL_APP: "https://auto.example.test",
    AUTO_GOOGLE_CLIENT_ID: "id-test",
    AUTO_GOOGLE_CLIENT_SECRET: "secret-test",
  });
  try {
    const u = new URL(await autorisationCourrier("google", "etat-test", "verifier-test"));
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).not.toBe("verifier-test");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe("https://auto.example.test/api/auth/callback/google");
    expect(configurationCourrier("google").secret).not.toBe("");
    const t = await echangerCourrier(
      "google",
      { grant_type: "refresh_token", refresh_token: "factice" },
      async (_url, o) => {
        expect(o?.redirect).toBe("error");
        return Response.json({ access_token: "nouveau", expires_in: 3600 });
      },
    );
    expect(t.access_token).toBe("nouveau");
    expect(t.expires_at).toBeGreaterThan(Date.now());
    await expect(
      echangerCourrier("google", {}, async () => Response.json({ access_token: "incorrect" })),
    ).rejects.toThrow("invalide");
  } finally {
    for (const [k, v] of Object.entries(precedent)) {
      if (v === undefined) delete Bun.env[k];
      else Bun.env[k] = v;
    }
  }
});

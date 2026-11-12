import { beforeAll, afterAll, expect, test, spyOn } from "bun:test";
import { testDb, type Sql, avecCourrier, type CompteCourrier } from "@auto/store";
import { chiffrer, dechiffrer, construire, cleMaitre } from "@auto/mail";
import { synchroniserCourrier, debutCourrier, retourCourrier } from "./courrier";
let sql: Sql, drop: () => Promise<void>, user: string, autre: string;
const avant = {
  AUTO_CLE_MAITRE: Bun.env.AUTO_CLE_MAITRE,
  AUTO_URL_APP: Bun.env.AUTO_URL_APP,
  AUTO_GOOGLE_CLIENT_ID: Bun.env.AUTO_GOOGLE_CLIENT_ID,
  AUTO_GOOGLE_CLIENT_SECRET: Bun.env.AUTO_GOOGLE_CLIENT_SECRET,
};
test("Outlook : MIME et pièces jointes, curseur delta, retrait et rejet des redirections de jeton", async () => {
  const secret = await chiffrer(cleMaitre(), user, `courrier/${user}`, {
    access_token: "outlook-factice",
    refresh_token: "refresh-factice",
    expires_at: Date.now() + 3600000,
  });
  const c = await avecCourrier(
    sql,
    user,
    user,
    async (tx) =>
      (
        await tx<
          CompteCourrier[]
        >`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret)VALUES(${user},'microsoft','outlook@example.test',${secret})RETURNING *`
      )[0]!,
  );
  const a = { userId: user, tenantId: user, role: "owner" as const },
    brut = construire({
      de: "contact@example.test",
      a: ["outlook@example.test"],
      sujet: "Pièce Outlook",
      texte: "Corps Outlook",
      pieces: [{ nom: "outlook.txt", type: "text/plain", octets: new TextEncoder().encode("contenu joint") }],
    });
  let mode: "ajout" | "retrait" | "malveillant" = "ajout",
    appelsHorsGraph = 0;
  const original = fetch,
    mock = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, options?: RequestInit) => {
      const u = new URL(String(input));
      if (u.origin !== "https://graph.microsoft.com") {
        appelsHorsGraph++;
        return original(input, options);
      }
      expect(new Headers(options?.headers).get("prefer")).toContain("ImmutableId");
      expect(options?.redirect).toBe("error");
      if (u.pathname.endsWith("/$value")) return new Response(new Uint8Array(brut.octets));
      return Response.json({
        value:
          mode === "ajout"
            ? [{ id: "graph-stable", isRead: true }]
            : mode === "retrait"
              ? [{ id: "graph-stable", "@removed": { reason: "deleted" } }]
              : [],
        "@odata.deltaLink":
          mode === "malveillant"
            ? "https://evil.example/collecter"
            : "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=factice",
      });
    }) as typeof fetch);
  try {
    expect((await synchroniserCourrier(sql, a, c.id)).nouveaux).toBe(1);
    const [m] = await avecCourrier(
      sql,
      user,
      user,
      (tx) => tx`SELECT id,sujet,texte FROM courrier_message WHERE compte_id=${c.id}`,
    );
    expect(m!.sujet).toBe("Pièce Outlook");
    expect(m!.texte).toContain("Corps Outlook");
    expect(
      (await avecCourrier(sql, user, user, (tx) => tx`SELECT nom FROM courrier_piece WHERE message_id=${m!.id}`))[0]!
        .nom,
    ).toBe("outlook.txt");
    mode = "retrait";
    await synchroniserCourrier(sql, a, c.id);
    expect(
      (await avecCourrier(sql, user, user, (tx) => tx`SELECT present FROM courrier_message WHERE id=${m!.id}`))[0]!
        .present,
    ).toBe(false);
    mode = "malveillant";
    await expect(synchroniserCourrier(sql, a, c.id)).rejects.toThrow("Synchronisation impossible");
    expect(appelsHorsGraph).toBe(0);
  } finally {
    mock.mockRestore();
  }
});
beforeAll(async () => {
  Object.assign(Bun.env, {
    AUTO_CLE_MAITRE: "cle-mail-courrier-tests-0123456789012345",
    AUTO_URL_APP: "https://auto.example.test",
    AUTO_GOOGLE_CLIENT_ID: "factice",
    AUTO_GOOGLE_CLIENT_SECRET: "secret-factice",
  });
  ({ sql, drop } = await testDb());
  user = crypto.randomUUID();
  autre = crypto.randomUUID();
  for (const u of [user, autre])
    await sql`INSERT INTO app_user(id,email,name)VALUES(${u},${`${u}@example.test`},'Test')`;
}, 30000);
afterAll(async () => {
  await drop?.();
  for (const [k, v] of Object.entries(avant)) {
    if (v === undefined) delete Bun.env[k];
    else Bun.env[k] = v;
  }
});
test("Gmail : pagination puis historique, suppression distante locale, reprise et rotation du jeton hors ligne", async () => {
  const secret = await chiffrer(cleMaitre(), user, `courrier/${user}`, {
    access_token: "expire",
    refresh_token: "refresh-conserve",
    expires_at: 0,
  });
  const c = await avecCourrier(
    sql,
    user,
    user,
    async (tx) =>
      (
        await tx<
          CompteCourrier[]
        >`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret)VALUES(${user},'google','gmail@example.test',${secret})RETURNING *`
      )[0]!,
  );
  const auth = { userId: user, tenantId: user, role: "owner" as const };
  let retrait = false,
    renouvellements = 0;
  const brut = construire({
    de: "ami@example.test",
    a: ["gmail@example.test"],
    sujet: "Message",
    texte: "Contenu",
  }).octets;
  const fetchOriginal = fetch;
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.origin === "https://oauth2.googleapis.com") {
      renouvellements++;
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh-conserve");
      return Response.json({ access_token: "renouvele", expires_in: 3600 });
    }
    if (u.origin !== "https://gmail.googleapis.com") return fetchOriginal(input, init);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer renouvele");
    if (u.pathname.endsWith("/profile")) return Response.json({ historyId: "100" });
    if (u.pathname.endsWith("/history"))
      return Response.json({ history: [{ messages: [{ id: "m3" }] }], historyId: "200" });
    if (u.pathname.endsWith("/messages"))
      return Response.json(
        u.searchParams.has("pageToken")
          ? { messages: [{ id: "m2" }] }
          : { messages: [{ id: "m1" }], nextPageToken: "suite" },
      );
    return Response.json({
      raw: brut.toBase64({ alphabet: "base64url", omitPadding: true }),
      labelIds: retrait ? [] : ["INBOX", "UNREAD"],
    });
  }) as typeof fetch);
  try {
    expect((await synchroniserCourrier(sql, auth, c.id)).suite).toBe(true);
    expect((await synchroniserCourrier(sql, auth, c.id)).suite).toBe(false);
    expect((await synchroniserCourrier(sql, auth, c.id)).nouveaux).toBe(1);
    retrait = true;
    await synchroniserCourrier(sql, auth, c.id);
    const rows = await avecCourrier(
      sql,
      user,
      user,
      (tx) => tx`SELECT distant_id,present FROM courrier_message WHERE compte_id=${c.id} ORDER BY distant_id`,
    );
    expect(rows.length).toBe(3);
    expect(rows.find((r: { distant_id: string; present: boolean }) => r.distant_id === "m3")!.present).toBe(false);
    expect(renouvellements).toBe(1);
    const [s] = await avecCourrier(sql, user, user, (tx) => tx`SELECT secret FROM courrier_compte WHERE id=${c.id}`);
    expect(
      (await dechiffrer<{ refresh_token: string }>(cleMaitre(), user, `courrier/${user}`, new Uint8Array(s!.secret)))
        .refresh_token,
    ).toBe("refresh-conserve");
  } finally {
    mock.mockRestore();
  }
});
test("Gmail : diagnostique un refus fournisseur sans persister le texte de réponse", async () => {
  const secret = await chiffrer(cleMaitre(), user, `courrier/${user}`, {
    access_token: "jeton-factice",
    refresh_token: "refresh-factice",
    expires_at: Date.now() + 3600000,
  });
  const c = await avecCourrier(
    sql,
    user,
    user,
    async (tx) =>
      (
        await tx<
          CompteCourrier[]
        >`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret)VALUES(${user},'google','diagnostic@example.test',${secret})RETURNING *`
      )[0]!,
  );
  const original = fetch,
    mock = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).origin === "https://gmail.googleapis.com")
        return Response.json(
          { error: { errors: [{ reason: "accessNotConfigured" }], message: "private provider response" } },
          { status: 403 },
        );
      return original(input);
    }) as typeof fetch);
  try {
    await expect(synchroniserCourrier(sql, { userId: user, tenantId: user, role: "owner" }, c.id)).rejects.toThrow(
      "Synchronisation google indisponible (403:accessNotConfigured)",
    );
    const [row] = await avecCourrier(sql, user, user, (tx) => tx`SELECT erreur FROM courrier_compte WHERE id=${c.id}`);
    expect(row!.erreur).toBe("Synchronisation google indisponible (403:accessNotConfigured)");
    expect(row!.erreur).not.toContain("private provider response");
  } finally {
    mock.mockRestore();
  }
});
test("Gmail : reprend avec un backoff borné et conserve le curseur sous limitation", async () => {
  const secret = await chiffrer(cleMaitre(), user, `courrier/${user}`, {
    access_token: "jeton-factice",
    refresh_token: "refresh-factice",
    expires_at: Date.now() + 3600000,
  });
  const c = await avecCourrier(
    sql,
    user,
    user,
    async (tx) =>
      (
        await tx<
          CompteCourrier[]
        >`INSERT INTO courrier_compte(user_id,fournisseur,adresse,secret,curseur)VALUES(${user},'google','limite@example.test',${secret},${JSON.stringify({ initialHistory: "100", page: "suite", suite: true })}::text::jsonb)RETURNING *`
      )[0]!,
  );
  const original = fetch,
    hasard = spyOn(Math, "random").mockReturnValue(0),
    mock = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (new URL(String(input)).origin === "https://gmail.googleapis.com")
        return Response.json(
          { error: { errors: [{ reason: "rateLimitExceeded" }] } },
          { status: 403, headers: { "retry-after": "0.01" } },
        );
      return original(input);
    }) as typeof fetch);
  try {
    const auth = { userId: user, tenantId: user, role: "owner" as const };
    await expect(synchroniserCourrier(sql, auth, c.id)).rejects.toThrow("403:rateLimitExceeded");
    const [row] = await avecCourrier(
      sql,
      user,
      user,
      (tx) => tx`SELECT curseur,erreur FROM courrier_compte WHERE id=${c.id}`,
    );
    expect(row!.erreur).toContain("reprise automatique dans cinq minutes");
    expect(row!.curseur).toMatchObject({ initialHistory: "100", page: "suite", suite: true });
    expect(Number(row!.curseur.repriseApresLimitation)).toBeGreaterThan(Date.now());
    const calls = mock.mock.calls.length;
    await expect(synchroniserCourrier(sql, auth, c.id)).resolves.toMatchObject({
      nouveaux: 0,
      suite: false,
      repriseApresLimitation: true,
    });
    expect(mock.mock.calls.length).toBe(calls);
  } finally {
    mock.mockRestore();
    hasard.mockRestore();
  }
});
test("OAuth : état privé à usage unique, PKCE, aucun échange depuis une autre session", async () => {
  const a = { userId: user, tenantId: user, role: "owner" as const },
    b = { userId: autre, tenantId: autre, role: "owner" as const };
  const { url } = await debutCourrier(sql, a, "google"),
    state = new URL(url).searchParams.get("state")!;
  await expect(retourCourrier(sql, b, "google", state, "code-factice")).rejects.toThrow("expirée");
  const fetchOriginal = fetch;
  let appels = 0;
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    options?: RequestInit,
  ) => {
    const u = new URL(String(input));
    if (u.origin === "https://oauth2.googleapis.com") {
      appels++;
      expect(new URLSearchParams(String(options?.body)).get("code_verifier")!.length).toBeGreaterThan(42);
      return Response.json({ access_token: "jeton-factice", refresh_token: "refresh-factice", expires_in: 3600 });
    }
    if (u.origin === "https://gmail.googleapis.com") return Response.json({ emailAddress: "autorise@example.test" });
    return fetchOriginal(input, options);
  }) as typeof fetch);
  try {
    const compte = await retourCourrier(sql, a, "google", state, "code-factice");
    expect(compte!.adresse).toBe("autorise@example.test");
    await expect(retourCourrier(sql, a, "google", state, "code-factice")).rejects.toThrow("expirée");
    expect(appels).toBe(1);
  } finally {
    mock.mockRestore();
  }
});

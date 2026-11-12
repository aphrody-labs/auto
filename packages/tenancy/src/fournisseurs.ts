import type { BetterAuthOptions } from "better-auth";

/** Une configuration partielle doit échouer au démarrage, pas masquer un bouton de connexion. */
export function sociaux(env: Record<string, string | undefined>): BetterAuthOptions["socialProviders"] {
  for (const nom of ["GOOGLE", "MICROSOFT"]) {
    const id = env[`AUTO_${nom}_CLIENT_ID`]?.trim();
    const secret = env[`AUTO_${nom}_CLIENT_SECRET`]?.trim();
    if (Boolean(id) !== Boolean(secret))
      throw new Error(`AUTO_${nom}_CLIENT_ID et AUTO_${nom}_CLIENT_SECRET requis ensemble`);
  }
  return {
    ...(env.AUTO_GOOGLE_CLIENT_ID?.trim() && env.AUTO_GOOGLE_CLIENT_SECRET?.trim()
      ? {
          google: {
            clientId: env.AUTO_GOOGLE_CLIENT_ID.trim(),
            clientSecret: env.AUTO_GOOGLE_CLIENT_SECRET.trim(),
            prompt: "select_account" as const,
          },
        }
      : {}),
    ...(env.AUTO_MICROSOFT_CLIENT_ID?.trim() && env.AUTO_MICROSOFT_CLIENT_SECRET?.trim()
      ? {
          microsoft: {
            clientId: env.AUTO_MICROSOFT_CLIENT_ID.trim(),
            clientSecret: env.AUTO_MICROSOFT_CLIENT_SECRET.trim(),
            tenantId: env.AUTO_MICROSOFT_TENANT_ID?.trim() || "common",
          },
        }
      : {}),
  };
}

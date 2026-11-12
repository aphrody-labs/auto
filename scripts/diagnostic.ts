// Qualification locale sans mutation et sans afficher les secrets. --reseau teste Postgres et SMTP.
import { SQL } from "bun";
import { configRelais, envoyeurDepuisEnv } from "../packages/mail/src/envoyeur";
import { testerSmtp } from "../packages/mail/src/smtp";
import { sociaux } from "../packages/tenancy/src/fournisseurs";

export interface Controle {
  service: string;
  ok: boolean;
  detail: string;
}

export function verifierConfiguration(env: Record<string, string | undefined>): Controle[] {
  const controles: Controle[] = [];
  const verifier = (service: string, fn: () => string) => {
    try {
      controles.push({ service, ok: true, detail: fn() });
    } catch {
      controles.push({ service, ok: false, detail: "Configuration absente ou invalide ; voir docs/PRODUCTION.md" });
    }
  };
  verifier("origine", () => {
    const url = new URL(env.BETTER_AUTH_URL ?? env.AUTO_URL_APP ?? env.AUTO_APP_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error();
    return "Origine HTTPS configurée";
  });
  verifier("chiffrement", () => {
    if (!env.AUTO_CLE_MAITRE || env.AUTO_CLE_MAITRE.length < 32) throw new Error();
    return "Clé maître présente";
  });
  for (const fournisseur of ["google", "microsoft"]) {
    verifier(fournisseur, () => {
      if (!Object.hasOwn(sociaux(env) ?? {}, fournisseur)) throw new Error();
      return "Identifiants présents (consentement OAuth à qualifier dans le navigateur)";
    });
  }
  verifier(env.AUTO_MAIL_FOURNISSEUR === "resend" ? "resend" : "smtp", () => {
    envoyeurDepuisEnv({ ...env, NODE_ENV: "production" });
    if (env.AUTO_MAIL_FOURNISSEUR === "resend")
      return "API Resend configurée (livraison réelle à qualifier avec scripts/test-resend.ts)";
    return "Relais TLS configuré (délivrabilité à qualifier)";
  });
  verifier("postgres", () => {
    const url = new URL(env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    return "Connexion configurée";
  });
  verifier("stripe", () => {
    if (!env.STRIPE_SECRET_KEY?.startsWith("sk_live_") || !env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"))
      throw new Error();
    return "Clés de production présentes (paiement et webhook à qualifier)";
  });
  return controles;
}

if (import.meta.main) {
  const controles = verifierConfiguration(Bun.env);
  if (Bun.argv.includes("--reseau")) {
    for (const service of ["postgres", "smtp"]) {
      if (!controles.find((c) => c.service === service)?.ok) continue;
      try {
        if (service === "smtp") await testerSmtp(configRelais(Bun.env).smtp!);
        else {
          const sql = new SQL({ url: Bun.env.DATABASE_URL!, connectionTimeout: 5 });
          try {
            await sql`SELECT 1`;
          } finally {
            await sql.close();
          }
        }
        controles.push({ service: `${service}/reseau`, ok: true, detail: "Connexion réelle réussie" });
      } catch {
        controles.push({
          service: `${service}/reseau`,
          ok: false,
          detail: "Connexion impossible (détail masqué pour protéger les identifiants)",
        });
      }
    }
  }
  console.log(JSON.stringify({ ok: controles.every((c) => c.ok), controles }, null, 2));
  if (controles.some((c) => !c.ok)) process.exitCode = 1;
}

// Exécuter uniquement sur le serveur avec son environnement protégé. Aucune clé n'est affichée.
import { SQL } from "bun";
import { synchroniserOperateurs, estSuperAdmin } from "../packages/tenancy/src/index";
const destination = Bun.argv[2];
if (!destination || !Bun.env.AUTO_COURRIER_PROPRIETAIRE)
  throw Error("Destination privée et propriétaire configuré requis");
const sql = new SQL(Bun.env.DATABASE_URL!);
try {
  await synchroniserOperateurs(sql);
  const [user] =
    await sql`SELECT id,email,email_verified,role FROM app_user WHERE lower(email)=${Bun.env.AUTO_COURRIER_PROPRIETAIRE.toLowerCase()}`;
  if (!user || !estSuperAdmin(user.email, user.email_verified, user.role))
    throw Error("Propriétaire vérifié et super-administrateur requis");
  if (await Bun.file(destination).exists()) throw Error("Fichier de clés déjà présent : aucune rotation implicite");
  const config: Record<string, string> = { AUTO_ADMIN_URL: Bun.env.AUTO_URL_APP! };
  await sql.begin(async (tx) => {
    for (const [nom, variable] of [
      ["Codex — administration Auto", "AUTO_CODEX_ADMIN_TOKEN"],
      ["Automatisations — administration Auto", "AUTO_AUTOMATISATIONS_ADMIN_TOKEN"],
    ]) {
      const token =
        "auto_agent_" +
        crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
      const empreinte = new Bun.CryptoHasher("sha256").update(token).digest("hex");
      await tx`INSERT INTO agent_admin(proprietaire_id,nom,empreinte,expire_at) VALUES(${user.id},${nom!},${empreinte},now()+interval '365 days')`;
      config[variable!] = token;
    }
    await Bun.write(
      destination,
      Object.entries(config)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  });
  console.log(JSON.stringify({ proprietaire: user.email, role: "super_admin", agents: 2, clesEcrites: true }));
} finally {
  await sql.close();
}

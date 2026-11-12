// Sauvegarde chiffrée de Postgres : pg_dump (format custom) dans le conteneur local, ou depuis une base distante
// (Neon) par `DATABASE_URL_DIRECT` avec le pg_dump de l'image postgres:18-alpine, puis AES-256-GCM (clé dérivée
// de AUTO_CLE_MAITRE, info « sauvegarde:<base> »), écriture dans AUTO_SAUVEGARDES (data/sauvegardes),
// rotation des AUTO_SAUVEGARDES_GARDER dernières (14 par défaut).
//
//   bun scripts/sauvegarde.ts [base]
//
// La clé maître est indispensable à la restauration : elle se conserve hors du serveur sauvegardé.
// Le dump est tenu en mémoire (adapté à la taille actuelle de la base) ; copie hors site à brancher
// (rclone vers un seau S3 à verrou d'objet).
import { chiffrer } from "../packages/tenancy/src/chiffrement";

export const ENTETE = new TextEncoder().encode("AUTOSAV1");

export interface OptionsSauvegarde {
  base?: string;
  conteneur?: string;
  utilisateur?: string;
  dossier?: string;
  garder?: number;
  cle?: Uint8Array<ArrayBuffer>;
  /** Base distante (point d'accès direct, jamais le pooler) ; prioritaire sur le conteneur. */
  url?: string;
}

const defauts = (o: OptionsSauvegarde) => ({
  base: o.base ?? "auto",
  conteneur: o.conteneur ?? Bun.env.AUTO_PG_CONTENEUR ?? "auto-pg",
  utilisateur: o.utilisateur ?? Bun.env.AUTO_PG_UTILISATEUR ?? "auto",
  dossier: o.dossier ?? Bun.env.AUTO_SAUVEGARDES ?? "data/sauvegardes",
  garder: o.garder ?? Number(Bun.env.AUTO_SAUVEGARDES_GARDER ?? 14),
  url: o.url ?? (Bun.env.AUTO_PG_CONTENEUR ? undefined : Bun.env.DATABASE_URL_DIRECT || undefined),
});

/** Variables libpq d'une URL : le mot de passe passe par l'environnement, jamais par la ligne de commande. */
export function envLibpq(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "require",
  };
}

/** pg_dump et pg_restore installés localement (image `sauvegarde` de docker/app.Dockerfile). */
export const local = () => Bun.env.AUTO_PG_LOCAL === "1";

export const infoCle = (base: string) => `sauvegarde:${base}`;

export async function executer(cmd: string[], entree?: Uint8Array, env?: Record<string, string>): Promise<Uint8Array> {
  const p = Bun.spawn(cmd, {
    stdin: entree ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...Bun.env, ...env } : undefined,
  });
  const [sortie, erreur, code] = await Promise.all([
    new Response(p.stdout).bytes(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 4).join(" ")} : code ${code}\n${erreur}`);
  return sortie;
}

/** Renvoie le chemin de la sauvegarde écrite. */
export async function sauvegarder(options: OptionsSauvegarde = {}): Promise<string> {
  const o = defauts(options);
  const libpq = o.url ? envLibpq(o.url) : null;
  // AUTO_PG_LOCAL=1 (image `sauvegarde`) : pg_dump présent dans le conteneur, sans appel à docker.
  const dump = libpq
    ? local()
      ? await executer(["pg_dump", "--format=custom", "--no-owner"], undefined, libpq)
      : await executer(
          [
            "docker",
            "run",
            "--rm",
            ...Object.keys(libpq).flatMap((k) => ["-e", k]),
            Bun.env.AUTO_PG_IMAGE ?? "postgres:18-alpine",
            "pg_dump",
            "--format=custom",
            "--no-owner",
          ],
          undefined,
          libpq,
        )
    : await executer([
        "docker",
        "exec",
        o.conteneur,
        "pg_dump",
        "-U",
        o.utilisateur,
        "-d",
        o.base,
        "--format=custom",
        "--no-owner",
      ]);
  const chiffre = await chiffrer(infoCle(o.base), new Uint8Array(dump), options.cle);
  const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
  const chemin = `${o.dossier}/${o.base}-${horodatage}.dump.chiffre`;
  await Bun.write(chemin, new Blob([ENTETE, chiffre]));

  // Rotation : les noms sont horodatés, le tri lexical est chronologique.
  const existantes = (await Array.fromAsync(new Bun.Glob(`${o.base}-*.dump.chiffre`).scan(o.dossier))).sort();
  for (const ancienne of existantes.slice(0, Math.max(0, existantes.length - o.garder)))
    await Bun.file(`${o.dossier}/${ancienne}`).delete();
  return chemin;
}

if (import.meta.main) {
  const chemin = await sauvegarder({ base: Bun.argv[2] });
  console.log(chemin);
}

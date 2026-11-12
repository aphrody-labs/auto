// Base PostgreSQL de production sur Neon : projet retrouvé ou créé par nom dans l'organisation, branches et URL
// de connexion (poolée pour l'API et le worker, directe pour les migrations, pg_dump et pg_restore).
// Module partagé par le déploiement VPS, la CI et tout futur déployeur ; aucune URL n'est jamais affichée.
//
//   bun scripts/neon.ts projet                                  identifiant du projet (créé au besoin)
//   bun scripts/neon.ts env <fichier> [--branche=nom] [--direct]  ajoute DATABASE_URL et DATABASE_URL_DIRECT
//   bun scripts/neon.ts branche-creer <nom> [--parent=nom] [--ttl-heures=24] [--env=<fichier>] [--direct] [--masquer]
//
// --direct : DATABASE_URL vise aussi le point d'accès direct (tests : CREATE DATABASE, DDL) ;
// --masquer : masque les URL dans les journaux GitHub Actions (::add-mask::).
//   bun scripts/neon.ts branche-supprimer <nom>
//
// Configuration : NEON_API_KEY (obligatoire), NEON_ORG_ID, NEON_PROJECT_ID ou NEON_PROJECT (nom, « auto »),
// NEON_REGION (aws-eu-central-1), NEON_PG_VERSION (18), NEON_DATABASE (auto), NEON_ROLE (auto).

const API = "https://console.neon.tech/api/v2";

export interface ConfigNeon {
  apiKey: string;
  orgId?: string;
  projectId?: string;
  projet: string;
  region: string;
  pgVersion: number;
  database: string;
  role: string;
}

export interface Branche {
  id: string;
  name: string;
  default?: boolean;
  parent_id?: string;
}

export function configDepuisEnv(env: Record<string, string | undefined> = Bun.env): ConfigNeon {
  const apiKey = env.NEON_API_KEY;
  if (!apiKey) throw new Error("NEON_API_KEY requis");
  const c: ConfigNeon = {
    apiKey,
    orgId: env.NEON_ORG_ID || undefined,
    projectId: env.NEON_PROJECT_ID || undefined,
    projet: env.NEON_PROJECT || "auto",
    region: env.NEON_REGION || "aws-eu-central-1",
    pgVersion: Number(env.NEON_PG_VERSION || 18),
    database: env.NEON_DATABASE || "auto",
    role: env.NEON_ROLE || "auto",
  };
  if (c.orgId && !/^org-[a-z0-9-]+$/.test(c.orgId)) throw new Error("NEON_ORG_ID invalide");
  if (c.projectId && !/^[a-z0-9-]+$/.test(c.projectId)) throw new Error("NEON_PROJECT_ID invalide");
  if (!/^aws-[a-z]+-[a-z]+-\d$|^azure-[a-z0-9]+$/.test(c.region)) throw new Error("NEON_REGION invalide");
  if (!Number.isInteger(c.pgVersion)) throw new Error("NEON_PG_VERSION invalide");
  for (const [nom, v] of [
    ["NEON_DATABASE", c.database],
    ["NEON_ROLE", c.role],
  ] as const)
    if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`${nom} invalide`);
  return c;
}

/** Appel de l'API Neon ; le corps d'une erreur est tronqué et ne contient jamais l'URL de connexion. */
export async function neon<T>(
  c: ConfigNeon,
  chemin: string,
  init: RequestInit & { query?: Record<string, string> } = {},
) {
  const url = new URL(`${API}${chemin}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  for (let essai = 0; ; essai++) {
    const r = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${c.apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    // 423 : une opération est en cours sur le projet ; on réessaie brièvement.
    if ((r.status === 423 || r.status === 429 || r.status >= 500) && essai < 10) {
      await Bun.sleep(1000 * (essai + 1));
      continue;
    }
    if (!r.ok)
      throw new Error(`Neon API ${init.method ?? "GET"} ${chemin} : ${r.status} ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }
}

/** Projet retrouvé par identifiant ou par nom dans l'organisation, créé (région, version, base, rôle) sinon. */
export async function projet(c: ConfigNeon): Promise<string> {
  if (c.projectId) return c.projectId;
  const projets: { id: string; name: string }[] = [];
  let curseur = "";
  for (let page = 0; page < 100; page++) {
    const query: Record<string, string> = { limit: "100", search: c.projet };
    if (c.orgId) query.org_id = c.orgId;
    if (curseur) query.cursor = curseur;
    const body = await neon<{ projects?: { id: string; name: string }[]; pagination?: { cursor?: string } }>(
      c,
      "/projects",
      { query },
    );
    projets.push(...(body.projects ?? []));
    const suivant = body.pagination?.cursor;
    if (!suivant || suivant === curseur || !body.projects?.length) break;
    curseur = suivant;
  }
  const existants = projets.filter((p) => p.name === c.projet);
  if (existants.length > 1)
    throw new Error(`Plusieurs projets Neon portent le nom ${c.projet} ; fixer NEON_PROJECT_ID`);
  if (existants[0]) return existants[0].id;
  const cree = await neon<{ project: { id: string } }>(c, "/projects", {
    method: "POST",
    body: JSON.stringify({
      project: {
        name: c.projet,
        region_id: c.region,
        pg_version: c.pgVersion,
        ...(c.orgId ? { org_id: c.orgId } : {}),
        branch: { name: "main", database_name: c.database, role_name: c.role },
      },
    }),
  });
  return cree.project.id;
}

export async function branches(c: ConfigNeon, projectId: string): Promise<Branche[]> {
  return (await neon<{ branches: Branche[] }>(c, `/projects/${projectId}/branches`)).branches;
}

/** Branche par nom, ou branche par défaut (production) sans nom. */
export async function branche(c: ConfigNeon, projectId: string, nom?: string): Promise<Branche> {
  const liste = await branches(c, projectId);
  const b = nom ? liste.find((x) => x.name === nom || x.id === nom) : liste.find((x) => x.default);
  if (!b) throw new Error(`Branche Neon introuvable : ${nom ?? "par défaut"}`);
  return b;
}

/**
 * Branche copie-sur-écriture de `parent` (par défaut la production) avec son point de calcul ; `ttlHeures`
 * fixe une expiration pour que les branches de CI oubliées disparaissent d'elles-mêmes.
 */
export async function creerBranche(
  c: ConfigNeon,
  projectId: string,
  nom: string,
  options: { parent?: string; ttlHeures?: number } = {},
): Promise<Branche> {
  if (!/^[\w.-]{1,128}$/.test(nom)) throw new Error("Nom de branche invalide");
  const existante = (await branches(c, projectId)).find((b) => b.name === nom);
  if (existante) return existante;
  const parent = await branche(c, projectId, options.parent);
  const body = await neon<{ branch: Branche }>(c, `/projects/${projectId}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: {
        name: nom,
        parent_id: parent.id,
        ...(options.ttlHeures ? { expires_at: new Date(Date.now() + options.ttlHeures * 3600_000).toISOString() } : {}),
      },
      endpoints: [{ type: "read_write" }],
    }),
  });
  return body.branch;
}

export async function supprimerBranche(c: ConfigNeon, projectId: string, nom: string): Promise<boolean> {
  const b = (await branches(c, projectId)).find((x) => x.name === nom || x.id === nom);
  if (!b) return false;
  if (b.default) throw new Error("La branche par défaut (production) ne se supprime pas");
  await neon(c, `/projects/${projectId}/branches/${b.id}`, { method: "DELETE" });
  return true;
}

/** URL de connexion `sslmode=require` : poolée (PgBouncer, API et worker) ou directe (migrations, dump). */
export async function urlConnexion(
  c: ConfigNeon,
  projectId: string,
  options: { branche?: string; pooled: boolean },
): Promise<string> {
  const b = await branche(c, projectId, options.branche);
  const body = await neon<{ uri: string }>(c, `/projects/${projectId}/connection_uri`, {
    query: { branch_id: b.id, database_name: c.database, role_name: c.role, pooled: String(options.pooled) },
  });
  const u = new URL(body.uri);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("Neon API : protocole inattendu");
  u.searchParams.set("sslmode", "require");
  u.searchParams.delete("channel_binding");
  return u.toString();
}

/** Nouveau mot de passe du rôle applicatif (toutes les branches qui n'ont pas divergé le partagent). */
export async function reinitialiserMotDePasse(c: ConfigNeon, projectId: string, nomBranche?: string) {
  const b = await branche(c, projectId, nomBranche);
  await neon(c, `/projects/${projectId}/branches/${b.id}/roles/${c.role}/reset_password`, { method: "POST" });
}

/** Variables d'environnement de l'application pour une branche. */
export async function envBranche(c: ConfigNeon, projectId: string, nomBranche?: string, direct = false) {
  const DATABASE_URL_DIRECT = await urlConnexion(c, projectId, { branche: nomBranche, pooled: false });
  return {
    DATABASE_URL: direct
      ? DATABASE_URL_DIRECT
      : await urlConnexion(c, projectId, { branche: nomBranche, pooled: true }),
    DATABASE_URL_DIRECT,
  };
}

async function ajouterEnv(fichier: string, valeurs: Record<string, string>, masquer: boolean) {
  if (masquer) for (const v of Object.values(valeurs)) console.log(`::add-mask::${v}`);
  const { appendFile, chmod } = await import("node:fs/promises");
  await appendFile(
    fichier,
    Object.entries(valeurs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    { mode: 0o600 },
  );
  await chmod(fichier, 0o600).catch(() => {});
}

if (import.meta.main) {
  const [commande, arg] = Bun.argv.slice(2);
  const option = (nom: string) => Bun.argv.find((a) => a.startsWith(`--${nom}=`))?.slice(nom.length + 3);
  const masquer = Bun.argv.includes("--masquer");
  const direct = Bun.argv.includes("--direct");
  const c = configDepuisEnv();
  const id = await projet(c);
  if (commande === "projet") console.log(id);
  else if (commande === "env") {
    if (!arg) throw new Error("Fichier d'environnement requis");
    await ajouterEnv(arg, await envBranche(c, id, option("branche"), direct), masquer);
    console.log(`DATABASE_URL et DATABASE_URL_DIRECT ajoutées (${option("branche") ?? "branche par défaut"})`);
  } else if (commande === "branche-creer") {
    if (!arg) throw new Error("Nom de branche requis");
    const ttl = option("ttl-heures");
    const b = await creerBranche(c, id, arg, { parent: option("parent"), ttlHeures: ttl ? Number(ttl) : undefined });
    console.log(`Branche ${b.name} (${b.id})`);
    const env = option("env");
    if (env) await ajouterEnv(env, await envBranche(c, id, b.id, direct), masquer);
  } else if (commande === "branche-supprimer") {
    if (!arg) throw new Error("Nom de branche requis");
    console.log((await supprimerBranche(c, id, arg)) ? `Branche ${arg} supprimée` : `Branche ${arg} absente`);
  } else throw new Error("Commande : projet, env, branche-creer ou branche-supprimer");
}

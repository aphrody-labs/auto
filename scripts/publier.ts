// Publication npm des paquets du dépôt sous `@aphrody/auto-*` (le scope `@auto` appartient à un autre projet).
// Chaque paquet est copié dans .cache/publication, renommé, ses dépendances `workspace:*` et ses imports `@auto/…`
// réécrits, puis publié dans l'ordre des dépendances. Le paquet native embarque les binaires de dist/native.
// Usage : bun scripts/publier.ts [--publier] [--version 0.1.0] (sans --publier : `bun publish --dry-run`).
import { $ } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const RACINE = join(import.meta.dir, "..");
const SORTIE = join(RACINE, ".cache", "publication");
const publier = Bun.argv.includes("--publier");
const iv = Bun.argv.indexOf("--version");
const version = iv > 0 ? Bun.argv[iv + 1]! : "0.1.0";
const DEPOT = { type: "git", url: "git+https://github.com/aphrody-labs/auto.git" };

/** `@auto/store` → `@aphrody/auto-store`. */
const renommer = (nom: string) => nom.replace(/^@auto\//, "@aphrody/auto-");

interface Manifeste {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [k: string]: unknown;
}

const dossiers = [
  ...[...new Bun.Glob("packages/*/package.json").scanSync(RACINE)].map((f) => join(RACINE, f, "..")),
  join(RACINE, "apps/cli"),
];
const paquets = new Map<string, { dossier: string; m: Manifeste }>();
for (const d of dossiers) {
  const m = (await Bun.file(join(d, "package.json")).json()) as Manifeste;
  if (!m.private) paquets.set(m.name, { dossier: d, m });
}

// Ordre topologique (dépendances internes d'abord).
const ordre: string[] = [];
const visiter = (nom: string, pile = new Set<string>()) => {
  if (ordre.includes(nom) || !paquets.has(nom)) return;
  if (pile.has(nom)) throw new Error(`cycle de dépendances : ${[...pile, nom].join(" → ")}`);
  pile.add(nom);
  for (const d of Object.keys(paquets.get(nom)!.m.dependencies ?? {})) visiter(d, pile);
  pile.delete(nom);
  ordre.push(nom);
};
for (const nom of paquets.keys()) visiter(nom);

const ignorer = (chemin: string) =>
  /[\\/](node_modules|dist|e2e)([\\/]|$)/.test(chemin) ||
  /\.test\.tsx?$/.test(chemin) ||
  basename(chemin) === "bunfig.toml";

await rm(SORTIE, { recursive: true, force: true });
for (const nom of ordre) {
  const { dossier, m } = paquets.get(nom)!;
  const cible = join(SORTIE, renommer(nom).replace("/", "__"));
  await mkdir(cible, { recursive: true });
  await cp(dossier, cible, { recursive: true, filter: (s) => !ignorer(s) });

  // Imports `@auto/x` → `@aphrody/auto-x` dans les sources publiées.
  for (const f of new Bun.Glob("**/*.{ts,tsx,css,md}").scanSync(cible)) {
    const p = join(cible, f);
    const t = await Bun.file(p).text();
    if (t.includes("@auto/")) await Bun.write(p, t.replaceAll(/(["'])@auto\//g, "$1@aphrody/auto-"));
  }

  const deps = Object.fromEntries(
    Object.entries(m.dependencies ?? {}).map(([k, v]) => (paquets.has(k) ? [renommer(k), `^${version}`] : [k, v])),
  );
  const { devDependencies: _, scripts: __, ...reste } = m;
  await Bun.write(
    join(cible, "package.json"),
    `${JSON.stringify(
      {
        ...reste,
        name: renommer(nom),
        version,
        license: "Apache-2.0",
        repository: { ...DEPOT, directory: dossier.slice(RACINE.length + 1).replaceAll("\\", "/") },
        homepage: "https://auto.aphrody.com",
        publishConfig: { access: "public" },
        dependencies: deps,
      },
      null,
      2,
    )}\n`,
  );
  await cp(join(RACINE, "LICENSE"), join(cible, "LICENSE"));
  await cp(join(RACINE, "NOTICE"), join(cible, "NOTICE"));
  if (nom === "@auto/native") await cp(join(RACINE, "dist", "native"), join(cible, "native"), { recursive: true });

  const r = await $`bun publish ${publier ? [] : ["--dry-run"]} --access public`.cwd(cible).nothrow().quiet();
  const sortie = `${r.stdout}${r.stderr}`;
  const taille = /Unpacked size:\s*([^\n]+)/.exec(sortie)?.[1] ?? "?";
  if (r.exitCode !== 0) {
    console.error(`✗ ${renommer(nom)}@${version}\n${sortie.trim().split("\n").slice(-8).join("\n")}`);
    process.exit(1);
  }
  console.log(`${publier ? "publié" : "essai"} ${renommer(nom)}@${version} (${taille})`);
}

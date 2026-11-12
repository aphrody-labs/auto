// Clone partiel épinglé de bun-distribution : seulement les crates listés dans vendor/suite.toml
// et la fermeture de leurs dépendances path. Sans sous-modules, sans le Cargo.toml racine
// (mode non-cône), pour que Cargo charge chaque crate comme dépendance path autonome.
import { $ } from "bun";
import { resolve, relative } from "node:path";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
// Le même point d’entrée importe les distributions WASM qualifiées du propriétaire Bun OS.
if (Bun.argv[2] === "--craft-web") {
  const source = resolve(Bun.argv[3] ?? "");
  if (!Bun.argv[3]) throw new Error("dossier de distribution Craft requis");
  const sortie = resolve(root, "apps/web/public/craft");
  const sources = await Bun.file(resolve(source, "sources.json")).json();
  const editeurs: Record<string, unknown> = {},
    revision = new Bun.CryptoHasher("sha256");
  for (const studio of ["grid", "word", "pdf"]) {
    const fichiers: Record<string, { sha256: string; taille: number; gzip?: string }> = {};
    const dossier = resolve(source, studio);
    for await (const chemin of new Bun.Glob("**/*").scan({ cwd: dossier, onlyFiles: true, followSymlinks: false })) {
      const nom = chemin.replaceAll("\\", "/");
      if (nom.split("/").some((p) => !p || p === ".." || p.startsWith(".")))
        throw new Error("chemin de ressource invalide");
      let bytes = await Bun.file(resolve(dossier, chemin)).bytes();
      if (nom === "index.html") {
        const html = new TextDecoder().decode(bytes),
          module = html.match(/<script type="module">([\s\S]*?)<\/script>/);
        if (!module) throw new Error(studio + " : point d’entrée WASM non reconnu");
        const script = new TextEncoder().encode(module[1]!);
        await Bun.write(resolve(sortie, studio, "auto-start.js"), script);
        fichiers["auto-start.js"] = {
          sha256: new Bun.CryptoHasher("sha256").update(script).digest("hex"),
          taille: script.length,
        };
        bytes = new TextEncoder().encode(
          html.replace(module[0], '<script type="module" src="./auto-start.js"></script>'),
        );
      }
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (nom.endsWith(".wasm")) {
        if (bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109) throw new Error("WASM invalide");
        const compresse = Bun.gzipSync(bytes, { level: 9 });
        await Bun.write(resolve(sortie, studio, nom + ".gz"), compresse);
        fichiers[nom] = { sha256, taille: bytes.length, gzip: nom + ".gz" };
      } else {
        await Bun.write(resolve(sortie, studio, nom), bytes);
        fichiers[nom] = { sha256, taille: bytes.length };
      }
    }
    if (
      !fichiers["index.html"] ||
      !Object.keys(fichiers).some((n) => n.endsWith(".wasm")) ||
      !Object.keys(fichiers).some((n) => n.startsWith("licenses/"))
    )
      throw new Error(studio + " : distribution incomplète (WASM/notices requis)");
    revision.update(studio).update(JSON.stringify(fichiers));
    editeurs[studio] = { source: sources[studio], fichiers };
  }
  if (relative(resolve(root, "apps/web/public"), sortie).startsWith(".."))
    throw new Error("sortie hors des ressources publiques");
  await Bun.write(
    resolve(sortie, "manifest.json"),
    JSON.stringify({ schema: 1, version: revision.digest("hex").slice(0, 16), editeurs }, null, 2) + "\n",
  );
  console.log(
    "Craft WASM importé : grid, word, pdf ; notices conservées, WASM compressés, bootstrap sans script inline.",
  );
  process.exit(0);
}
const dest = `${root}vendor/bun-distribution`;
const conf = Bun.TOML.parse(await Bun.file(`${root}vendor/suite.toml`).text()) as {
  repo: string;
  commit: string;
  crates: string[];
  extra?: string[];
};

if (!(await Bun.file(`${dest}/.git/HEAD`).exists())) {
  await $`git clone --filter=blob:none --no-checkout --sparse ${conf.repo} ${dest}`;
}
await $`git -C ${dest} fetch --filter=blob:none origin ${conf.commit}`.quiet();

const voulus = new Set<string>();
const file = [...conf.crates];
while (file.length) {
  const c = file.pop()!;
  if (voulus.has(c)) continue;
  voulus.add(c);
  const manifest = await $`git -C ${dest} show ${conf.commit}:${c}/Cargo.toml`.text();
  const m = Bun.TOML.parse(manifest) as Record<string, Record<string, { path?: string } | string> | undefined>;
  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    for (const dep of Object.values(m[section] ?? {})) {
      if (typeof dep === "object" && dep.path)
        file.push(new URL(dep.path, `file:///${c}/`).pathname.slice(1).replace(/\/$/, ""));
    }
  }
}

const motifs = [...[...voulus].sort(), ...(conf.extra ?? [])].map((c) => `/${c}/`);
// Réécritures précédentes (héritage de workspace) annulées avant de changer de commit.
await $`git -C ${dest} checkout --quiet -- .`.nothrow().quiet();
await $`git -C ${dest} sparse-checkout set --no-cone ${motifs}`.quiet();
await $`git -C ${dest} -c advice.detachedHead=false checkout --quiet ${conf.commit}`;
// Les crates sont chargés hors de leur workspace : on remplace chaque héritage `workspace = true`
// par la valeur du Cargo.toml racine du commit épinglé.
const racine = Bun.TOML.parse(await $`git -C ${dest} show ${conf.commit}:Cargo.toml`.text()) as {
  workspace: { package?: Record<string, unknown>; dependencies?: Record<string, unknown> };
};
const toml = (v: unknown): string =>
  typeof v === "string"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(toml).join(", ")}]`
      : typeof v === "object" && v
        ? `{ ${Object.entries(v)
            .map(([k, x]) => `${k} = ${toml(x)}`)
            .join(", ")} }`
        : String(v);
for (const c of voulus) {
  const chemin = `${dest}/${c}/Cargo.toml`;
  const avant = await Bun.file(chemin).text();
  let section = "";
  const apres = avant
    .split("\n")
    .map((ligne) => {
      const s = /^\s*\[([^\]]+)\]/.exec(ligne);
      if (s) section = s[1]!;
      // champ.workspace = true (section [package])
      const champ = /^(\s*)([\w-]+)\.workspace\s*=\s*true\s*$/.exec(ligne);
      if (champ && section === "package") {
        const v = racine.workspace.package?.[champ[2]!];
        if (v === undefined) throw new Error(`${c} : ${champ[2]} absent de [workspace.package]`);
        return `${champ[1]}${champ[2]} = ${toml(v)}`;
      }
      // dep = { workspace = true, features = [...], optional = true } (sections de dépendances)
      const dep =
        /^(\s*)([\w-]+)\s*=\s*\{\s*workspace\s*=\s*true\s*(?:,(.*))?\}\s*$/.exec(ligne) ??
        (/^(\s*)([\w-]+)\.workspace\s*=\s*true\s*$/.exec(ligne) && section.endsWith("dependencies")
          ? /^(\s*)([\w-]+)\.workspace\s*=\s*true\s*$/.exec(ligne)
          : null);
      if (dep && section.endsWith("dependencies")) {
        const base = racine.workspace.dependencies?.[dep[2]!];
        if (base === undefined) throw new Error(`${c} : ${dep[2]} absent de [workspace.dependencies]`);
        const spec: Record<string, unknown> = typeof base === "string" ? { version: base } : { ...(base as object) };
        const extra = dep[3] ? (Bun.TOML.parse(`x = {${dep[3]}}`) as { x: Record<string, unknown> }).x : {};
        if (Array.isArray(extra.features))
          spec.features = [...new Set([...((spec.features as string[]) ?? []), ...(extra.features as string[])])];
        if (extra.optional !== undefined) spec.optional = extra.optional;
        return `${dep[1]}${dep[2]} = ${toml(spec)}`;
      }
      return ligne;
    })
    .join("\n");
  if (apres !== avant) await Bun.write(chemin, apres);
}

console.log(`bun-distribution@${conf.commit.slice(0, 12)} : ${motifs.length} crates\n${[...voulus].sort().join("\n")}`);

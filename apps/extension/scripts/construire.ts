// Construit l'extension dans apps/extension/dist : scripts groupés par Bun.build, fichiers statiques, jetons M3 de
// @auto/ui et icônes PNG de @auto/ui/icone (aucune image binaire versionnée). `--zip` produit le paquet du Chrome Web
// Store (dist/auto-extension-<version>.zip, sans fichiers de développement).
import { icone } from "@auto/ui/icone";

const racine = new URL("..", import.meta.url);
const DIST = new URL("dist/", racine);
const chemin = (u: URL) => Bun.fileURLToPath(u);

export const TAILLES = [16, 32, 48, 128] as const;

/**
 * `hotes` ajoute des autorisations d'hôte au manifeste (tests de bout en bout sur 127.0.0.1 seulement : une
 * autorisation facultative ne peut pas être accordée sans l'utilisateur).
 */
export async function construire(o: { dist?: URL; hotes?: string[] } = {}): Promise<string[]> {
  const dist = o.dist ?? DIST;
  await Bun.$`rm -rf ${chemin(dist)}`.quiet();
  const r = await Bun.build({
    entrypoints: ["service-worker.ts", "popup.ts"].map((f) => chemin(new URL(`src/${f}`, racine))),
    outdir: chemin(dist),
    target: "browser",
    format: "esm",
    naming: "[name].[ext]",
    minify: false,
  });
  if (!r.success) throw new AggregateError(r.logs, "échec de Bun.build");
  for (const f of ["popup.html", "popup.css"])
    await Bun.write(new URL(f, dist), Bun.file(new URL(`static/${f}`, racine)));
  const manifeste = await Bun.file(new URL("static/manifest.json", racine)).json();
  if (o.hotes?.length) manifeste.host_permissions = [...manifeste.host_permissions, ...o.hotes];
  await Bun.write(new URL("manifest.json", dist), `${JSON.stringify(manifeste, null, 2)}\n`);
  await Bun.write(new URL("tokens.css", dist), Bun.file(new URL("../../packages/ui/src/tokens.css", racine)));
  for (const t of TAILLES) await Bun.write(new URL(`icons/icon-${t}.png`, dist), icone(t));
  return [...new Bun.Glob("**/*").scanSync({ cwd: chemin(dist) })].sort();
}

if (import.meta.main) {
  const fichiers = await construire();
  console.log(`dist : ${fichiers.join(", ")}`);
  if (Bun.argv.includes("--zip")) {
    const { version } = (await Bun.file(new URL("static/manifest.json", racine)).json()) as { version: string };
    const contenu = Object.fromEntries(
      await Promise.all(fichiers.map(async (f) => [f, await Bun.file(new URL(f, DIST)).bytes()] as const)),
    );
    const zip = chemin(new URL(`auto-extension-${version}.zip`, DIST));
    await Bun.Archive.write(zip, contenu, { format: "zip", mtime: 0 });
    console.log(`paquet : ${zip}`);
  }
}

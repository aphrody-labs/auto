// Importe les distributions WASM qualifiées de Craft (grid, word, pdf) dans apps/web/public/craft.
// Usage : bun scripts/craft-web.ts <dossier de distribution>
import { resolve, relative } from "node:path";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
{
  const source = resolve(Bun.argv[2] ?? "");
  if (!Bun.argv[2]) throw new Error("dossier de distribution Craft requis");
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
}

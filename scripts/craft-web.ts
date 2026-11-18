// Hydrate apps/web/public/craft depuis Cloudflare R2 (ou importe un dossier local Craft WASM + option --publier-r2).
// Usage :
//   bun scripts/craft-web.ts                      (télécharge et vérifie SHA-256 depuis R2 vers apps/web/public/craft)
//   bun scripts/craft-web.ts <dossier>            (importe une distribution locale et met à jour apps/web/craft.manifest.json)
//   bun scripts/craft-web.ts <dossier> --publier-r2
import { resolve, relative } from "node:path";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const sortie = resolve(root, "apps/web/public/craft");
const cheminManifesteRacine = resolve(root, "apps/web/craft.manifest.json");
const R2_PUBLIC_BASE = "https://open-source-website-assets.aphrody-labs.workers.dev/craft";

interface EntreeFichier {
  sha256: string;
  taille: number;
  gzip?: string;
}

interface ManifesteCraftRacine {
  schema: number;
  version: string;
  r2BaseUrl?: string;
  editeurs: Record<string, { source: unknown; fichiers: Record<string, EntreeFichier> }>;
}

const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function contentTypeFor(rel: string): string {
  if (rel.endsWith(".json")) return "application/json; charset=utf-8";
  if (rel.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (rel.endsWith(".html")) return "text/html; charset=utf-8";
  if (rel.endsWith(".css")) return "text/css; charset=utf-8";
  if (rel.endsWith(".png")) return "image/png";
  if (rel.endsWith(".gz")) return "application/gzip";
  return "text/plain; charset=utf-8";
}

function resolveWrangler(): string[] {
  const bin = Bun.which("wrangler");
  return bin ? [bin] : ["bun", "x", "wrangler"];
}

export async function hydraterDepuisR2(): Promise<ManifesteCraftRacine> {
  const manifeste = (await Bun.file(cheminManifesteRacine).json()) as ManifesteCraftRacine;
  const base = (manifeste.r2BaseUrl ?? `${R2_PUBLIC_BASE}/${manifeste.version}`).replace(/\/$/, "");
  const telechargements: Array<{ url: string; dest: string; expectedSha: string; gz: boolean }> = [];

  for (const [studio, data] of Object.entries(manifeste.editeurs)) {
    for (const [nom, info] of Object.entries(data.fichiers)) {
      const fichierCible = info.gzip ?? nom;
      const dest = resolve(sortie, studio, fichierCible);
      const fichier = Bun.file(dest);
      let valide = false;
      if (await fichier.exists()) {
        const octets = await fichier.bytes();
        const brut = info.gzip ? Bun.gunzipSync(octets) : octets;
        valide = brut.length === info.taille && sha256Hex(brut) === info.sha256;
      }
      if (!valide) {
        telechargements.push({
          url: `${base}/${studio}/${fichierCible}`,
          dest,
          expectedSha: info.sha256,
          gz: Boolean(info.gzip),
        });
      }
    }
  }

  await Promise.all(
    telechargements.map(async (item) => {
      const rep = await fetch(item.url);
      if (!rep.ok) throw new Error(`Téléchargement Craft R2 échoué (${rep.status}) : ${item.url}`);
      const octets = new Uint8Array(await rep.arrayBuffer());
      const brut = item.gz ? Bun.gunzipSync(octets) : octets;
      const reel = sha256Hex(brut);
      if (reel !== item.expectedSha) {
        throw new Error(`Empreinte SHA-256 invalide pour ${item.url} : ${reel} != ${item.expectedSha}`);
      }
      await Bun.write(item.dest, octets);
    }),
  );

  const { r2BaseUrl: _r2, ...publicManifest } = manifeste;
  await Bun.write(resolve(sortie, "manifest.json"), `${JSON.stringify(publicManifest, null, 2)}\n`);
  console.log(
    telechargements.length > 0
      ? `Craft WASM hydraté depuis R2 (${telechargements.length} fichiers téléchargés, SHA-256 vérifiés).`
      : "Craft WASM déjà à jour localement (SHA-256 vérifiés).",
  );
  return manifeste;
}

async function importerDossierLocal(sourceArg: string, publierR2: boolean): Promise<void> {
  const source = resolve(sourceArg);
  const sources = (await Bun.file(resolve(source, "sources.json")).json()) as Record<string, unknown>;
  const editeurs: Record<string, { source: unknown; fichiers: Record<string, EntreeFichier> }> = {};
  const revision = new Bun.CryptoHasher("sha256");

  for (const studio of ["grid", "word", "pdf"]) {
    const fichiers: Record<string, EntreeFichier> = {};
    const dossier = resolve(source, studio);
    for await (const chemin of new Bun.Glob("**/*").scan({ cwd: dossier, onlyFiles: true, followSymlinks: false })) {
      const nom = chemin.replaceAll("\\", "/");
      if (nom.split("/").some((p) => !p || p === ".." || p.startsWith(".")))
        throw new Error("chemin de ressource invalide");
      let bytes = await Bun.file(resolve(dossier, chemin)).bytes();
      if (nom === "index.html") {
        const html = new TextDecoder().decode(bytes),
          module = html.match(/<script type="module">([\s\S]*?)<\/script>/);
        if (!module) throw new Error(`${studio} : point d’entrée WASM non reconnu`);
        const script = new TextEncoder().encode(module[1]!);
        await Bun.write(resolve(sortie, studio, "auto-start.js"), script);
        fichiers["auto-start.js"] = { sha256: sha256Hex(script), taille: script.length };
        bytes = new TextEncoder().encode(
          html.replace(module[0], '<script type="module" src="./auto-start.js"></script>'),
        );
      }
      const sha256 = sha256Hex(bytes);
      if (nom.endsWith(".wasm")) {
        if (bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109) throw new Error("WASM invalide");
        const compresse = Bun.gzipSync(bytes, { level: 9 });
        await Bun.write(resolve(sortie, studio, `${nom}.gz`), compresse);
        fichiers[nom] = { sha256, taille: bytes.length, gzip: `${nom}.gz` };
      } else {
        await Bun.write(resolve(sortie, studio, nom), bytes);
        fichiers[nom] = { sha256, taille: bytes.length };
      }
    }
    if (
      !fichiers["index.html"] ||
      !Object.keys(fichiers).some((n) => n.endsWith(".wasm")) ||
      !Object.keys(fichiers).some((n) => n.startsWith("licenses/"))
    ) {
      throw new Error(`${studio} : distribution incomplète (WASM/notices requis)`);
    }
    revision.update(studio).update(JSON.stringify(fichiers));
    editeurs[studio] = { source: sources[studio], fichiers };
  }

  if (relative(resolve(root, "apps/web/public"), sortie).startsWith(".."))
    throw new Error("sortie hors des ressources publiques");
  const version = revision.digest("hex").slice(0, 16);
  const publicManifest = { schema: 1, version, editeurs };
  const rootManifest: ManifesteCraftRacine = {
    schema: 1,
    version,
    r2BaseUrl: `${R2_PUBLIC_BASE}/${version}`,
    editeurs,
  };
  await Bun.write(resolve(sortie, "manifest.json"), `${JSON.stringify(publicManifest, null, 2)}\n`);
  await Bun.write(cheminManifesteRacine, `${JSON.stringify(rootManifest, null, 2)}\n`);

  if (publierR2) {
    const wrangler = resolveWrangler();
    for await (const rel of new Bun.Glob("**/*").scan({ cwd: sortie, onlyFiles: true })) {
      const cleanRel = rel.replaceAll("\\", "/");
      const r = Bun.spawnSync(
        [
          ...wrangler,
          "r2",
          "object",
          "put",
          `aphrody-assets/craft/${version}/${cleanRel}`,
          "--file",
          resolve(sortie, cleanRel),
          "--content-type",
          contentTypeFor(cleanRel),
          "--remote",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (r.exitCode !== 0) {
        throw new Error(`Publication R2 échouée pour ${cleanRel} : ${new TextDecoder().decode(r.stderr)}`);
      }
    }
    console.log(`Craft WASM publié sur R2 aphrody-assets/craft/${version}/`);
  }

  console.log("Craft WASM importé : grid, word, pdf ; manifestes mis à jour sans scripts inline.");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const publierR2 = args.includes("--publier-r2");
  const dossierLocal = args.find((a) => !a.startsWith("-"));
  if (!dossierLocal) {
    await hydraterDepuisR2();
  } else {
    await importerDossierLocal(dossierLocal, publierR2);
  }
}

// Variantes responsives des images de la vitrine : AVIF et WebP en deux largeurs, nommées par empreinte de contenu
// (cache immuable par /img/v/...), et manifeste src/site/images.gen.ts lu par la vitrine et par index.html.
// Usage (serveur de build, avifenc requis) : bun apps/web/scripts/images.ts
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const racine = join(import.meta.dir, "..");
const source = join(racine, "public/img");
const sortie = join(source, "v");
/** Images affichées sur l'accueil ; les originaux restent servis par /img pour « Agrandir ». */
const IMAGES = [
  "btp-plan",
  "btp-analytique",
  "btp-devis-editeur",
  "btp-achats",
  "btp-recherche",
  "btp-tableau",
  "btp-mobile",
];

if (!Bun.which("avifenc")) throw new Error("avifenc introuvable (paquet libavif-bin)");
await rm(sortie, { recursive: true, force: true });
await $`mkdir -p ${sortie}`;
const temp = await mkdtemp(join(Bun.env.TMPDIR ?? tmpdir(), "auto-images-"));
const empreinte = (o: Uint8Array) => new Bun.CryptoHasher("sha256").update(o).digest("hex").slice(0, 10);
const manifeste: Record<
  string,
  { largeur: number; hauteur: number; avif: [string, number][]; webp: [string, number][] }
> = {};
try {
  for (const nom of IMAGES) {
    const original = await Bun.file(join(source, `${nom}.webp`)).bytes();
    const { width, height } = await new Bun.Image(original).metadata();
    const entree = { largeur: width, hauteur: height, avif: [] as [string, number][], webp: [] as [string, number][] };
    for (const largeur of [Math.round(width / 2), width]) {
      const webp = await new Bun.Image(original).resize(largeur).webp({ quality: 72 }).bytes();
      const png = join(temp, `${nom}-${largeur}.png`);
      await Bun.write(png, await new Bun.Image(original).resize(largeur).png().bytes());
      const fichierAvif = join(temp, `${nom}-${largeur}.avif`);
      await $`avifenc --speed 4 --qcolor 58 --qalpha 90 --jobs 4 ${png} ${fichierAvif}`.quiet();
      const avif = await Bun.file(fichierAvif).bytes();
      for (const [format, octets] of [
        ["avif", avif],
        ["webp", webp],
      ] as const) {
        const fichier = `${nom}-${largeur}-${empreinte(octets)}.${format}`;
        await Bun.write(join(sortie, fichier), octets);
        entree[format].push([`/img/v/${fichier}`, largeur]);
        console.log(`${fichier} ${octets.length}`);
      }
    }
    manifeste[nom] = entree;
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
// Image de partage (og:image) : JPEG 1200×628 (1,91:1) recadré au centre de la capture du héros.
if (!Bun.which("vips")) throw new Error("vips introuvable (paquet libvips-tools)");
const recadre = join(Bun.env.TMPDIR ?? tmpdir(), `auto-og-${process.pid}.png`);
await $`vips crop ${join(source, "btp-analytique.webp")} ${recadre} 0 31 1600 838`.quiet();
await $`vips resize ${recadre} ${`${join(source, "og-auto.jpg")}[Q=82,strip]`} 0.75`.quiet();
await rm(recadre, { force: true });
console.log(`og-auto.jpg ${Bun.file(join(source, "og-auto.jpg")).size}`);
await Bun.write(
  join(racine, "src/site/images.gen.ts"),
  `// Généré par apps/web/scripts/images.ts : ne pas modifier à la main.
export const IMAGES = ${JSON.stringify(manifeste, null, 2)} as const;
`,
);
console.log(`${(await readdir(sortie)).length} fichiers → ${sortie}`);

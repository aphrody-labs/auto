// Télécharge, vérifie (SHA-256) et extrait FFmpeg/FFprobe vers .cache/video-outils en pur Bun 1.4.5.
import { resolve } from "node:path";

const racine = Bun.fileURLToPath(new URL("..", import.meta.url));
const destination = resolve(Bun.argv[2] ?? resolve(racine, ".cache/video-outils"));
const urlArchive = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const urlSha256 = `${urlArchive}.sha256`;
const fichierArchive = resolve(destination, "ffmpeg.zip");

const [repSha, repArchive] = await Promise.all([fetch(urlSha256), fetch(urlArchive)]);
if (!repSha.ok) throw new Error(`Échec téléchargement empreinte FFmpeg : HTTP ${repSha.status}`);
if (!repArchive.ok) throw new Error(`Échec téléchargement FFmpeg : HTTP ${repArchive.status}`);

const attendue = (await repSha.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const octets = new Uint8Array(await repArchive.arrayBuffer());
const reelle = new Bun.CryptoHasher("sha256").update(octets).digest("hex").toLowerCase();
if (!attendue || reelle !== attendue) {
  throw new Error(`Empreinte SHA-256 FFmpeg incorrecte : ${reelle} != ${attendue}`);
}

await Bun.write(fichierArchive, octets);
const entree = await new Bun.Archive(octets).extract(destination);
console.log(`FFmpeg téléchargé, vérifié et extrait (${entree} entrées) : ${reelle}`);
for (const f of new Bun.Glob("**/bin/ffmpeg{,.exe}").scanSync({ cwd: destination, onlyFiles: true })) {
  console.log(resolve(destination, f));
}

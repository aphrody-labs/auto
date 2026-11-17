// Teste le téléchargement et la signature par le plugin Rust, sans installer de logiciel.
import { existsSync } from "node:fs";
import { join } from "node:path";
const racine = Bun.fileURLToPath(new URL("../", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/\/$/, "");
const empreinte = new Bun.CryptoHasher("sha256")
  .update(await Bun.file("docker/desktop.Dockerfile").bytes())
  .digest("hex")
  .slice(0, 12);
const image = `auto-desktop:${empreinte}`;
async function commande(args: string[]) {
  const p = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await p.exited) throw Error(`Qualification interrompue : ${args[0]}`);
}
await commande([
  "docker",
  "run",
  "--rm",
  "-v",
  `${racine}:/w`,
  "-w",
  "/w/apps/desktop/src-tauri",
  "-v",
  "auto-cargo-registry:/usr/local/cargo/registry",
  "-v",
  "auto-cargo-git:/usr/local/cargo/git",
  "-v",
  "auto-desktop-target:/target",
  "-e",
  "CARGO_TARGET_DIR=/target",
  image,
  "sh",
  "-c",
  "cargo build --release --locked --target x86_64-pc-windows-gnu --example qualifier_updater && mkdir -p /w/dist/qualification-updater && cp /target/x86_64-pc-windows-gnu/release/examples/qualifier_updater.exe /w/dist/qualification-updater/ && cp /target/x86_64-pc-windows-gnu/release/WebView2Loader.dll /w/dist/qualification-updater/",
]);
/** mt.exe du Windows SDK le plus récent : AUTO_MT, sinon le Kit installé sous ProgramFiles(x86), sinon le PATH. */
function trouverMt(): string {
  if (Bun.env.AUTO_MT) return Bun.env.AUTO_MT;
  const kits = Bun.env["ProgramFiles(x86)"];
  const bin = kits && join(kits, "Windows Kits", "10", "bin");
  if (bin && existsSync(bin)) {
    const versions = [...new Bun.Glob("*/x64/mt.exe").scanSync({ cwd: bin, onlyFiles: true })];
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const derniere = versions.at(-1);
    if (derniere) return join(bin, derniere);
  }
  const surLePath = Bun.which("mt");
  if (!surLePath) throw new Error("mt.exe introuvable : installer le Windows SDK ou définir AUTO_MT.");
  return surLePath;
}
const mt = trouverMt();
const exe = join(racine, "dist/qualification-updater/qualifier_updater.exe");
await commande([
  mt,
  "-manifest",
  join(racine, "apps/desktop/src-tauri/examples/qualifier_updater.manifest"),
  `-outputresource:${exe};#1`,
]);
await commande([exe, Bun.argv[2] ?? "0.1.0"]);

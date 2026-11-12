// Teste le téléchargement et la signature par le plugin Rust, sans installer de logiciel.
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
const mt = Bun.env.AUTO_MT ?? "C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/mt.exe";
const exe = join(racine, "dist/qualification-updater/qualifier_updater.exe");
await commande([
  mt,
  "-manifest",
  join(racine, "apps/desktop/src-tauri/examples/qualifier_updater.manifest"),
  `-outputresource:${exe};#1`,
]);
await commande([exe, Bun.argv[2] ?? "0.1.0"]);

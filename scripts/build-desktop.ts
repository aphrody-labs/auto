// Compilation Linux + Windows dans l'environnement Tauri du dépôt, également depuis PowerShell.
import { $ } from "bun";

const racine = Bun.fileURLToPath(new URL("../", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/\/$/, "");
const dockerfile = `${racine}/docker/desktop.Dockerfile`;
const empreinte = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(dockerfile).bytes())
  .digest("hex")
  .slice(0, 12);
const image = `auto-desktop:${empreinte}`;
const sortie = Bun.argv.find((a) => a.startsWith("--output="))?.slice(9) ?? "dist/desktop";
if (!/^dist\/[a-zA-Z0-9/_-]+$/.test(sortie) || sortie.includes("..")) throw Error("Sortie desktop invalide");
if ((await $`docker image inspect ${image}`.quiet().nothrow()).exitCode !== 0) {
  await $`docker build -q -t ${image} -f ${dockerfile} ${`${racine}/docker`}`;
}
await $`docker run --rm -v ${`${racine}:/w`} -w /w/apps/desktop/src-tauri -v auto-cargo-registry:/usr/local/cargo/registry -v auto-cargo-git:/usr/local/cargo/git -v auto-desktop-target:/target -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never ${image} sh -c ${`
    set -eu
    cargo test --locked --lib
    cargo build --release --locked
    cargo build --release --locked --target x86_64-pc-windows-gnu
    mkdir -p /w/${sortie}/linux-x64 /w/${sortie}/windows-x64
    cp /target/release/auto-desktop /w/${sortie}/linux-x64/
    cp /target/x86_64-pc-windows-gnu/release/auto-desktop.exe /w/${sortie}/windows-x64/
    cp /target/x86_64-pc-windows-gnu/release/WebView2Loader.dll /w/${sortie}/windows-x64/
  `}`;
console.log(`Coques et tests Tauri : ${sortie}/linux-x64 et ${sortie}/windows-x64`);

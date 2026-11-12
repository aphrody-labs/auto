// Empaquette les binaires MinGW qualifiés sans recompilation sous MSVC.
import { join } from "node:path";
const racine = Bun.fileURLToPath(new URL("../", import.meta.url));
const source = Bun.argv[2] ?? "dist/desktop-updater/windows-x64";
if (!/^dist\/[a-zA-Z0-9/_-]+$/.test(source) || source.includes("..")) throw Error("Source invalide");
const cible = join(racine, ".cache/tauri-distribution-target");
for (const nom of ["auto-desktop.exe", "WebView2Loader.dll"])
  await Bun.write(join(cible, "x86_64-pc-windows-gnu/release", nom), Bun.file(join(racine, source, nom)));
const cle = join(Bun.env.USERPROFILE!, ".auto/updater-auto.key");
if (!(await Bun.file(cle).exists())) throw Error("Clé de signature absente du répertoire privé");
const configuration = JSON.stringify({
  bundle: { resources: { [join(cible, "x86_64-pc-windows-gnu/release/WebView2Loader.dll")]: "WebView2Loader.dll" } },
});
const p = Bun.spawn(
  [
    process.execPath,
    "x",
    "--bun",
    "@tauri-apps/cli@2.12.4",
    "bundle",
    "--target",
    "x86_64-pc-windows-gnu",
    "--bundles",
    "nsis",
    "--ci",
    "--config",
    configuration,
  ],
  {
    cwd: join(racine, "apps/desktop/src-tauri"),
    env: {
      ...Bun.env,
      CARGO_TARGET_DIR: cible,
      TAURI_SIGNING_PRIVATE_KEY: cle,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (await p.exited) throw Error("Création de l’installateur échouée");
console.log(`Installateur et signature : ${cible}/x86_64-pc-windows-gnu/release/bundle/nsis`);

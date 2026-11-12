// Compile auto-ffi en conteneur et copie les bibliothèques dans dist/native/<plateforme>/ :
// Linux (production) et Windows x64 par compilation croisée MinGW (poste de dev sans MSVC).
import { $ } from "bun";
import { racineDocker } from "./docker-racine";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const cibles = [
  { triple: "x86_64-unknown-linux-gnu", fichier: "libauto_ffi.so", dossier: "linux-x64" },
  { triple: "x86_64-pc-windows-gnu", fichier: "auto_ffi.dll", dossier: "windows-x64" },
];
const voulues = Bun.argv.slice(2);

for (const c of cibles.filter((c) => !voulues.length || voulues.includes(c.dossier))) {
  await $`${process.execPath} ${`${root}scripts/cargo.ts`} build -q --release --locked -p auto-ffi --target ${c.triple}`;
  const dest = `/w/dist/native/${c.dossier}`;
  // Le répertoire cible est un volume du conteneur : copie par un conteneur jetable.
  await $`docker run --rm -e MSYS_NO_PATHCONV=1 -v auto-cargo-target:/target -v ${`${await racineDocker(root)}`}:/w alpine sh -c ${`mkdir -p ${dest} && cp /target/${c.triple}/release/${c.fichier} ${dest}/`}`.env(
    {
      ...Bun.env,
      MSYS_NO_PATHCONV: "1",
    },
  );
  console.log(`dist/native/${c.dossier}/${c.fichier}`);
}

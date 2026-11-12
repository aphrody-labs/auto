// Prépare une livraison immuable sur le VPS : sources publiques et bibliothèque qualifiée, jamais prod.env.
// La bascule lit ~/auto/prod.env (application, DATABASE_URL poolée et DATABASE_URL_DIRECT Neon) et
// ~/auto/neon.env (NEON_API_KEY, NEON_ORG_ID, NEON_PROJECT_ID : branches de migration candidates).
import { $ } from "bun";

const action = Bun.argv[2] ?? "preparer";
const ssh = Bun.which("ssh") ?? "ssh";
const reutiliser = Bun.argv.find((a) => a.startsWith("--base="))?.slice(7);
const vitrineBase = Bun.argv.find((a) => a.startsWith("--vitrine-base="))?.slice(15);
if (vitrineBase && !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(vitrineBase)) throw new Error("Base de vitrine invalide");
const vitrineGelee = new Set([
  "apps/web/public/index.html",
  "apps/web/src/site/accueil.tsx",
  "apps/web/src/styles/accueil.css",
]);
if (reutiliser && !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(reutiliser)) throw new Error("Base de livraison invalide");
if (!["preparer", "valider", "deployer"].includes(action)) throw new Error("Action : preparer, valider ou deployer");
const horodatage = new Date()
  .toISOString()
  .replaceAll(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const suivis =
  await $`git ls-files -z --cached --others --exclude-standard -- apps packages package.json bun.lock bunfig.toml tsconfig.json docker/app.Dockerfile .dockerignore LICENSE NOTICE scripts/release-vps.ts scripts/neon.ts scripts/administration-provisionner.ts`.text();
const chemins = new Set(suivis.split("\0").filter(Boolean));
const manifeste = "apps/web/public/craft/manifest.json";
if (!(await Bun.file(manifeste).exists()))
  throw new Error("Les trois distributions Craft doivent être installées avant la livraison");
const craft = await Bun.file(manifeste).json();
for (const editeur of ["word", "grid", "pdf"]) {
  if (!Object.keys(craft.editeurs?.[editeur]?.fichiers ?? {}).some((f) => f.endsWith(".wasm")))
    throw new Error(`Distribution Craft incomplète : ${editeur}`);
}
for await (const fichier of new Bun.Glob("**/*").scan({ cwd: "apps/web/public/craft", onlyFiles: true }))
  chemins.add(`apps/web/public/craft/${fichier.replaceAll("\\", "/")}`);

await $`${process.execPath} scripts/build-native.ts linux-x64`;
const contenu: Record<string, Uint8Array<ArrayBuffer>> = {};
const hash = new Bun.CryptoHasher("sha256");
const empreintes: Record<string, string> = {};
for (const chemin of [...chemins].sort()) {
  if (chemin.includes("..") || chemin.startsWith("/") || /(^|\/)\.env(?:\.|$)/.test(chemin))
    throw new Error(`Chemin interdit dans la livraison : ${chemin}`);
  const fichier = Bun.file(chemin);
  if (!(await fichier.exists())) continue;
  let octets = await fichier.bytes();
  if (vitrineBase && vitrineGelee.has(chemin)) {
    const lecture = Bun.spawnSync(["tar", "-xOf", `.cache/releases/${vitrineBase}/context.tar.gz`, chemin]);
    if (lecture.exitCode !== 0) throw new Error(`Vitrine gelée introuvable : ${chemin}`);
    octets = new Uint8Array(lecture.stdout);
  }
  contenu[chemin] = octets;
  const sha = new Bun.CryptoHasher("sha256").update(octets).digest("hex");
  empreintes[chemin] = sha;
  hash.update(`${chemin}\0${sha}\0`);
}
const natif = await Bun.file("dist/native/linux-x64/libauto_ffi.so").bytes();
const craftLivre = JSON.parse(new TextDecoder().decode(contenu[manifeste]));
if (craftLivre.version !== craft.version) throw new Error("Les ressources Craft ont changé pendant la préparation");
for (const [editeur, definition] of Object.entries(craftLivre.editeurs) as [
  string,
  { fichiers: Record<string, { sha256: string; taille: number; gzip?: string }> },
][]) {
  for (const [nom, fichier] of Object.entries(definition.fichiers)) {
    const stocke = `apps/web/public/craft/${editeur}/${fichier.gzip ?? nom}`;
    const brut = contenu[stocke];
    if (!brut) throw new Error(`Ressource Craft absente : ${stocke}`);
    const octets = fichier.gzip ? Bun.gunzipSync(brut) : brut;
    if (
      octets.length !== fichier.taille ||
      new Bun.CryptoHasher("sha256").update(octets).digest("hex") !== fichier.sha256
    )
      throw new Error(`Intégrité Craft incorrecte : ${editeur}/${nom}`);
  }
}
contenu["native/libauto_ffi.so"] = natif;
const shaNatif = new Bun.CryptoHasher("sha256").update(natif).digest("hex");
empreintes["native/libauto_ffi.so"] = shaNatif;
hash.update(shaNatif);
const source = hash.digest("hex");
const commit = (await $`git rev-parse HEAD`.text()).trim();
const modifie = (await $`git status --porcelain -- apps packages scripts docker`.text()).trim().length > 0;
const version = `${horodatage}-${source.slice(0, 8)}`;
const dossier = `.cache/releases/${version}`;
contenu["SOURCE_SHA256SUMS.json"] = new TextEncoder().encode(JSON.stringify(empreintes, null, 2));
if (reutiliser) {
  const precedent = JSON.parse(
    await $`${ssh} -o BatchMode=yes vps ${`cat ~/auto/releases/${reutiliser}/release.json`}`.text(),
  );
  if (precedent.shaNatif !== shaNatif || precedent.craft !== craft.version)
    throw new Error("La FFI ou les éditeurs ont changé : une livraison complète est nécessaire");
  for (const chemin of Object.keys(contenu))
    if (chemin === "native/libauto_ffi.so" || (chemin.startsWith("apps/web/public/craft/") && chemin !== manifeste))
      delete contenu[chemin];
}
await $`mkdir -p ${dossier}`;
await Bun.Archive.write(`${dossier}/context.tar.gz`, contenu, { compress: "gzip", mtime: 0 });
const archive = `${dossier}/context.tar.gz`;
const shaArchive = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).bytes()).digest("hex");
await Bun.write(
  `${dossier}/release.json`,
  `${JSON.stringify({ version, source, commit: modifie ? `${commit}-modifie` : commit, shaNatif, shaArchive, craft: craft.version }, null, 2)}\n`,
);

const distant = async (cmd: string) => {
  const p = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "vps", cmd], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) throw new Error("L'étape distante a échoué ; livraison conservée pour diagnostic");
};
console.log(`Préparation ${version} (${Math.round((await Bun.file(archive).size) / 1024 / 1024)} Mio)`);
await distant(`umask 077; mkdir -p ~/auto/releases/${version}; chmod 700 ~/auto/releases/${version}`);
await $`scp -S ${ssh} -q ${archive} ${`vps:auto/releases/${version}/context.tar.gz`}`;
await $`scp -S ${ssh} -q ${`${dossier}/release.json`} ${`vps:auto/releases/${version}/release.json`}`;
await distant(
  `cd ~/auto/releases/${version} && printf '%s  context.tar.gz\n' '${shaArchive}' | sha256sum -c - && ${reutiliser ? `cp -a ../${reutiliser}/native . && mkdir -p apps/web/public && cp -a ../${reutiliser}/apps/web/public/craft apps/web/public/ && ` : ""}tar xzf context.tar.gz --no-same-owner && ~/.local/bin/bun -e 'for(const [p,h] of Object.entries(await Bun.file("SOURCE_SHA256SUMS.json").json())){if(new Bun.CryptoHasher("sha256").update(await Bun.file(p).bytes()).digest("hex")!==h)throw Error("Empreinte incorrecte : "+p)}console.log("Integrite de la livraison verifiee")' && docker build --target precompiled -f docker/app.Dockerfile -t auto-app:${version} . && docker build --target web -f docker/app.Dockerfile -t auto-web:${version} .`,
);
await Bun.write(".cache/last-release.json", `${JSON.stringify({ version, source, action }, null, 2)}\n`);
if (action !== "preparer")
  await distant(
    `cd ~/auto/releases/${version} && ~/.local/bin/bun --env-file=$HOME/auto/prod.env --env-file=$HOME/auto/neon.env scripts/release-vps.ts ${version} ${action}`,
  );
console.log(`Livraison ${version} : ${action} terminé`);

// Exécutable avec runtime embarqué ; la bibliothèque native et les ressources restent dans le paquet.
import type { BunPlugin } from "bun";
// Le paquet distribue ses sources TS ; le charger à l'exécution garde ses détails internes hors du projet.
const moduleTailwind = "@aphrody/bun-plugin-tailwind";
const { tailwind } = (await import(moduleTailwind)) as { tailwind: () => BunPlugin };

const cible = Bun.argv[2] ?? (process.platform === "win32" ? "windows-x64" : "linux-x64");
if (!["windows-x64", "linux-x64"].includes(cible)) throw new Error("Cible : windows-x64 ou linux-x64");
const dossier = `dist/standalone/${cible}`;
const executable = `${dossier}/auto${cible === "windows-x64" ? ".exe" : ""}`;
const native = cible === "windows-x64" ? "auto_ffi.dll" : "libauto_ffi.so";
const sourceNative = `dist/native/${cible}/${native}`;
if (!(await Bun.file(sourceNative).exists())) throw new Error(`Construire d’abord ${sourceNative}`);
const plateformeHote = process.platform === "win32" ? "windows-x64" : process.platform === "linux" ? "linux-x64" : null;
if (cible !== plateformeHote || process.arch !== "x64")
  throw new Error("Construire ce paquet sur sa plateforme cible pour qualifier le runtime embarqué et ses notices");
const noticeRuntime = Bun.file(`licenses/bun/${Bun.revision.slice(0, 12)}/LICENSE.md`);
if (!(await noticeRuntime.exists())) throw new Error(`Notice du runtime ${Bun.revision} non qualifiée`);

const resultat = await Bun.build({
  entrypoints: ["apps/standalone/src/index.ts"],
  target: "bun",
  env: "disable",
  minify: true,
  plugins: [tailwind()],
  compile: { target: cible === "windows-x64" ? "bun-windows-x64" : "bun-linux-x64", outfile: executable },
});
if (!resultat.success) throw new AggregateError(resultat.logs, "Compilation autonome impossible");
await Bun.write(`${dossier}/${native}`, Bun.file(sourceNative));
await Bun.write(`${dossier}/LISEZ-MOI.txt`, Bun.file("apps/standalone/DISTRIBUTION.txt"));
for (const notice of ["LICENSE", "NOTICE"]) await Bun.write(`${dossier}/${notice}`, Bun.file(notice));
await Bun.write(`${dossier}/BUN-LICENSE.md`, noticeRuntime);
await Bun.write(
  `${dossier}/RUNTIME.json`,
  JSON.stringify(
    {
      version: Bun.version,
      revision: Bun.revision,
      source: `https://github.com/aphrody-labs/bun/tree/${Bun.revision}`,
    },
    null,
    2,
  ) + "\n",
);
for await (const fichier of new Bun.Glob("*.sql").scan("packages/store/migrations")) {
  await Bun.write(`${dossier}/migrations/${fichier}`, Bun.file(`packages/store/migrations/${fichier}`));
}
for await (const fichier of new Bun.Glob("**/*").scan({ cwd: "apps/web/public", onlyFiles: true })) {
  await Bun.write(`${dossier}/public/${fichier}`, Bun.file(`apps/web/public/${fichier}`));
}
const fichiers: Record<string, string> = {};
for await (const fichier of new Bun.Glob("**/*").scan({ cwd: dossier, onlyFiles: true })) {
  if (fichier === "SHA256SUMS.json") continue;
  fichiers[fichier] = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(`${dossier}/${fichier}`).bytes())
    .digest("hex");
}
await Bun.write(`${dossier}/SHA256SUMS.json`, `${JSON.stringify(fichiers, null, 2)}\n`);
console.log(`Paquet autonome : ${dossier}`);
if (Bun.argv.includes("--zip")) {
  const contenu: Record<string, Uint8Array<ArrayBuffer>> = {};
  for await (const fichier of new Bun.Glob("**/*").scan({ cwd: dossier, onlyFiles: true })) {
    contenu[fichier.replaceAll("\\", "/")] = await Bun.file(`${dossier}/${fichier}`).bytes();
  }
  const archive = `${dossier}.zip`;
  await Bun.Archive.write(archive, contenu, { format: "zip", mtime: 0 });
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).bytes()).digest("hex");
  await Bun.write(`${archive}.sha256`, `${hash}  ${cible}.zip\n`);
  console.log(`Archive : ${archive}`);
}

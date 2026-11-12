// Publication atomique du catalogue ; à lancer sur le VPS après le transfert dans .publication-<UUID>.
import { rename, chmod } from "node:fs/promises";
import type { Catalogue } from "../apps/web/src/distributions";
const id = Bun.argv[2];
if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw Error("Identifiant de publication invalide");
const livraison = Bun.argv[3];
if (!livraison || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(livraison)) throw Error("Livraison validée requise");
const { catalogue } = (await import(
  Bun.pathToFileURL(`${Bun.env.HOME}/auto/releases/${livraison}/apps/web/src/distributions.ts`).href
)) as { catalogue: (dossier: string) => Promise<Catalogue | null> };
const base = `${Bun.env.HOME}/auto/distributions`;
const depot = `${base}/.publication-${id}`;
const c = await catalogue(depot);
if (!c?.fichiers.length) throw Error("Catalogue absent ou invalide");
const action = Bun.argv[4] ?? "publier";
if (!["plan", "publier"].includes(action)) throw Error("Action invalide");
const manquants: string[] = [];
async function empreinte(chemin: string) {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(chemin).stream()) h.update(chunk);
  return h.digest("hex");
}
for (const a of c.fichiers) {
  if (!a.fichier.includes(c.version)) throw Error("Un fichier doit porter sa version immuable");
  const destination = `${base}/${a.fichier}`;
  if (await Bun.file(destination).exists()) {
    if (Bun.file(destination).size !== a.octets || (await empreinte(destination)) !== a.sha256)
      throw Error(`Refus de remplacer une version publiée : ${a.fichier}`);
  } else {
    manquants.push(a.fichier);
    if (action === "publier") {
      const f = Bun.file(`${depot}/${a.fichier}`);
      if (!(await f.exists()) || f.size !== a.octets || (await empreinte(`${depot}/${a.fichier}`)) !== a.sha256)
        throw Error(`Intégrité incorrecte : ${a.fichier}`);
    }
  }
}
if (action === "plan") {
  console.log(JSON.stringify({ manquants }));
  process.exit(0);
}
for (const a of c.fichiers) {
  const destination = `${base}/${a.fichier}`;
  if (!(await Bun.file(destination).exists())) await rename(`${depot}/${a.fichier}`, destination);
  await chmod(destination, 0o644);
}
const manifeste = `${base}/manifest-${id}.tmp`;
await Bun.write(manifeste, JSON.stringify(c, null, 2) + "\n");
await chmod(manifeste, 0o644);
await rename(manifeste, `${base}/manifest.json`);
console.log(`Catalogue ${c.version} publié : ${c.fichiers.length} fichiers vérifiés`);

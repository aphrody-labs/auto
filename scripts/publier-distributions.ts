// Le répertoire local contient manifest.json et uniquement les fichiers publics référencés.
import { catalogue } from "../apps/web/src/distributions";
const dossier = Bun.argv[2];
if (!dossier) throw Error("Usage : bun scripts/publier-distributions.ts <répertoire>");
const livraison = (await Bun.file(".cache/last-release.json").json()).version as string;
if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(livraison)) throw Error("Livraison validée invalide");
const c = await catalogue(dossier);
if (!c?.fichiers.length) throw Error("Catalogue absent ou invalide");
for (const a of c.fichiers) {
  const f = Bun.file(`${dossier}/${a.fichier}`);
  const h = new Bun.CryptoHasher("sha256");
  if (!(await f.exists()) || f.size !== a.octets) throw Error(`Fichier absent ou incomplet : ${a.fichier}`);
  for await (const chunk of f.stream()) h.update(chunk);
  if (h.digest("hex") !== a.sha256) throw Error(`Empreinte incorrecte : ${a.fichier}`);
}
const id = crypto.randomUUID();
const depot = `auto/distributions/.publication-${id}`;
async function commande(args: string[]) {
  const p = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await p.exited) throw Error("Publication interrompue ; ancien catalogue conservé");
}
await commande(["ssh", "vps", `umask 022; mkdir -p ~/${depot} ~/auto/outils; chmod 755 ~/auto/distributions`]);
await commande(["scp", "-S", Bun.which("ssh") ?? "ssh", `${dossier}/manifest.json`, `vps:${depot}/manifest.json`]);
// Ces deux sources ne contiennent ni clé privée ni configuration de compte.
await commande([
  "scp",
  "-S",
  Bun.which("ssh") ?? "ssh",
  "scripts/distributions-vps.ts",
  "vps:auto/outils/distributions-vps.ts",
]);
const plan = Bun.spawn(["ssh", "vps", `~/.local/bin/bun ~/auto/outils/distributions-vps.ts ${id} ${livraison} plan`], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
const sortie = await new Response(plan.stdout).text();
if (await plan.exited) throw Error("Plan de publication refusé ; catalogue actuel conservé");
const { manquants } = JSON.parse(sortie) as { manquants: string[] };
if (
  !Array.isArray(manquants) ||
  manquants.some((n) => !c.fichiers.some((a) => a.fichier === n)) ||
  new Set(manquants).size !== manquants.length
)
  throw Error("Plan de transfert incohérent");
console.log(
  `Transfert : ${manquants.length} fichiers nouveaux, ${c.fichiers.length - manquants.length} fichiers déjà vérifiés`,
);
for (const nom of manquants)
  await commande(["scp", "-S", Bun.which("ssh") ?? "ssh", `${dossier}/${nom}`, `vps:${depot}/${nom}`]);
// Le validateur provient de la livraison immuable ; aucune source de cette livraison n'est modifiée.
await commande(["ssh", "vps", `~/.local/bin/bun ~/auto/outils/distributions-vps.ts ${id} ${livraison}`]);

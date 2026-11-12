// Publie uniquement la vidéo de lancement qualifiée ; vérifie les deux extrémités avant bascule atomique.
export {};
const source = Bun.argv[2] ?? "dist/lancement-btp/auto-btp-lancement-fr.mp4";
const recu = await Bun.file("dist/lancement-btp/verification.json").json();
if (recu.decode !== "passed" || !/^[a-f0-9]{64}$/.test(recu.sha256)) throw Error("Reçu de qualification absent");
const h = new Bun.CryptoHasher("sha256");
const fichier = Bun.file(source);
for await (const c of fichier.stream()) h.update(c);
if (h.digest("hex") !== recu.sha256 || fichier.size !== recu.nativeMetadata.fileBytes)
  throw Error("La vidéo ne correspond pas au reçu");
const temporaire = `.lancement-${recu.sha256}.mp4`;
async function commande(args: string[]) {
  const p = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await p.exited) throw Error("Publication média interrompue ; vidéo précédente conservée");
}
await commande(["ssh", "vps", "mkdir -p ~/auto/media; chmod 755 ~/auto/media"]);
await commande(["scp", "-S", Bun.which("ssh") ?? "ssh", source, `vps:auto/media/${temporaire}`]);
const code = `import{rename,chmod}from"node:fs/promises";const base=process.env.HOME+"/auto/media/";const f=Bun.file(base+"${temporaire}");const h=new Bun.CryptoHasher("sha256");for await(const c of f.stream())h.update(c);if(h.digest("hex")!=="${recu.sha256}"||f.size!==${fichier.size})throw Error("Intégrité média incorrecte");await chmod(base+"${temporaire}",420);await rename(base+"${temporaire}",base+"lancement-btp.mp4");console.log("Vidéo qualifiée publiée atomiquement : ${fichier.size} octets");`;
// Aucun texte libre ni secret dans le programme distant ; noms dérivés d'une empreinte strictement contrôlée.
await commande(["ssh", "vps", `~/.local/bin/bun -e '${code}'`]);

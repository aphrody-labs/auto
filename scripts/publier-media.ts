// Publie uniquement la vidéo de lancement qualifiée ; vérifie les deux extrémités avant bascule atomique.
import { copier, distant, RACINE } from "./hote";

const source = Bun.argv[2] ?? "dist/lancement-btp/auto-btp-lancement-fr.mp4";
const recu = await Bun.file("dist/lancement-btp/verification.json").json();
if (recu.decode !== "passed" || !/^[a-f0-9]{64}$/.test(recu.sha256)) throw Error("Reçu de qualification absent");
const h = new Bun.CryptoHasher("sha256");
const fichier = Bun.file(source);
for await (const c of fichier.stream()) h.update(c);
if (h.digest("hex") !== recu.sha256 || fichier.size !== recu.nativeMetadata.fileBytes)
  throw Error("La vidéo ne correspond pas au reçu");
const echec = "Publication média interrompue ; vidéo précédente conservée";
const dossier = `${RACINE}/media`;
const temporaire = `${dossier}/.lancement-${recu.sha256}.mp4`;
await distant(`install -d -m 755 ${dossier}`, echec);
await copier(source, temporaire, echec);
// Noms, empreinte et taille viennent du reçu validé ci-dessus : aucun texte libre dans la commande distante.
await distant(
  `f=${temporaire}; if [ "$(sha256sum "$f" | cut -d' ' -f1)" = ${recu.sha256} ] && [ "$(stat -c %s "$f")" = ${fichier.size} ]; ` +
    `then chmod 644 "$f" && mv -f "$f" ${dossier}/lancement-btp.mp4; else rm -f "$f"; echo "Intégrité média incorrecte" >&2; exit 1; fi`,
  echec,
);
console.log(`Vidéo qualifiée publiée atomiquement : ${fichier.size} octets`);

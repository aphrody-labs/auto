// Le répertoire local contient manifest.json et uniquement les fichiers publics référencés.
import { catalogue } from "../apps/web/src/distributions";
import { copier, distant, RACINE } from "./hote";

const dossier = Bun.argv[2];
if (!dossier) throw Error("Usage : bun scripts/publier-distributions.ts <répertoire>");
const c = await catalogue(dossier);
if (!c?.fichiers.length) throw Error("Catalogue absent ou invalide");
for (const a of c.fichiers) {
  if (!/^[A-Za-z0-9._-]+$/.test(a.fichier)) throw Error(`Nom de fichier refusé : ${a.fichier}`);
  if (!a.fichier.includes(c.version)) throw Error("Un fichier doit porter sa version immuable");
  const f = Bun.file(`${dossier}/${a.fichier}`);
  const h = new Bun.CryptoHasher("sha256");
  if (!(await f.exists()) || f.size !== a.octets) throw Error(`Fichier absent ou incomplet : ${a.fichier}`);
  for await (const chunk of f.stream()) h.update(chunk);
  if (h.digest("hex") !== a.sha256) throw Error(`Empreinte incorrecte : ${a.fichier}`);
}
const id = crypto.randomUUID();
const base = `${RACINE}/distributions`;
const depot = `${base}/.publication-${id}`;
const echec = "Publication interrompue ; ancien catalogue conservé";
await distant(`umask 022; install -d -m 755 ${base} ${depot}`, echec);
// Plan : les versions déjà publiées sont immuables (refus si leur contenu diffère) et ne sont pas retransférées.
const noms = c.fichiers.map((a) => a.fichier).join(" ");
const existants = new Map(
  (
    await distant(
      `cd ${base} && for f in ${noms}; do [ -f "$f" ] && echo "$f $(stat -c %s "$f") $(sha256sum "$f" | cut -d' ' -f1)"; done; true`,
      "Plan de publication refusé ; catalogue actuel conservé",
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => [l.split(" ")[0]!, l] as const),
);
const manquants: string[] = [];
for (const a of c.fichiers) {
  const publie = existants.get(a.fichier);
  if (!publie) manquants.push(a.fichier);
  else if (publie !== `${a.fichier} ${a.octets} ${a.sha256}`)
    throw Error(`Refus de remplacer une version publiée : ${a.fichier}`);
}
console.log(
  `Transfert : ${manquants.length} fichiers nouveaux, ${c.fichiers.length - manquants.length} fichiers déjà vérifiés`,
);
for (const nom of manquants) await copier(`${dossier}/${nom}`, `${depot}/${nom}`, echec);
await copier(`${dossier}/manifest.json`, `${depot}/manifest.json`, echec);
// Bascule : fichiers vérifiés puis déplacés, manifeste remplacé en dernier par renommage atomique.
const verifier = c.fichiers
  .filter((a) => manquants.includes(a.fichier))
  .map(
    (a) =>
      `[ "$(stat -c %s ${depot}/${a.fichier})" = ${a.octets} ] && [ "$(sha256sum ${depot}/${a.fichier} | cut -d' ' -f1)" = ${a.sha256} ] || { echo "Intégrité incorrecte : ${a.fichier}" >&2; exit 1; }`,
  );
await distant(
  [
    "set -e",
    ...verifier,
    `for f in ${manquants.join(" ")}; do mv -n ${depot}/$f ${base}/$f; done`,
    `cd ${base} && chmod 644 ${noms}`,
    `mv -f ${depot}/manifest.json ${base}/manifest.json && chmod 644 ${base}/manifest.json`,
    `rm -rf ${depot}`,
  ].join("; "),
  echec,
);
console.log(`Catalogue ${c.version} publié : ${c.fichiers.length} fichiers vérifiés`);

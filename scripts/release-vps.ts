// À exécuter uniquement sur le VPS, avec --env-file ~/auto/prod.env --env-file ~/auto/neon.env, après
// construction des deux images. La base de production est sur Neon : les essais de migration tournent sur une
// branche copie-sur-écriture de la production, supprimée ensuite ; aucun worker candidat n'est démarré.
import { $ } from "bun";
import { configDepuisEnv, creerBranche, envBranche, projet, reinitialiserMotDePasse, supprimerBranche } from "./neon";

const [version, action = "valider"] = Bun.argv.slice(2);
if (!version || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(version)) throw new Error("Identifiant de livraison invalide");
// relancer : recrée les conteneurs de la livraison en place avec le prod.env courant (changement de base,
// rotation de secrets), sans candidat ni migration ; l'API applique les migrations au démarrage.
if (!["valider", "deployer", "relancer"].includes(action)) throw new Error("Action : valider, deployer ou relancer");
const home = Bun.env.HOME!;
const base = `${home}/auto`;
const dossier = `${base}/releases/${version}`;
const brancheCandidate = `candidat-${version.toLowerCase()}`;
const neon = configDepuisEnv();
const livraison = (await Bun.file(`${dossier}/release.json`).json()) as { commit?: string };
if (action !== "relancer") await projet(neon);
const apiCandidat = `auto-api-${version.toLowerCase()}`;
const webCandidat = `auto-web-${version.toLowerCase()}`;
const image = `auto-app:${version}`;
const imageWeb = `auto-web:${version}`;
const envCandidat = `${dossier}/.env.candidate`;

async function commande(args: string[], entree?: Uint8Array) {
  const p = Bun.spawn(args, { stdin: entree ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [sortie, erreur, code] = await Promise.all([p.stdout.bytes(), p.stderr.text(), p.exited]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} : ${erreur.slice(0, 3000)}`);
  return sortie;
}
const texte = async (args: string[]) => new TextDecoder().decode(await commande(args)).trim();

const commun = [
  "--init",
  "--restart",
  "unless-stopped",
  "--user",
  "10001:10001",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--stop-timeout",
  "60",
  "--log-opt",
  "max-size=10m",
  "--log-opt",
  "max-file=3",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
  "--tmpfs",
  "/home/auto:rw,nosuid,nodev,size=256m,uid=10001,gid=10001",
];

async function lancer(nom: string, role: "api" | "worker" | "web", img: string, env: string, api = "auto-api") {
  const identite = ["-e", `AUTO_VERSION=${version}`];
  if (livraison.commit) identite.push("-e", `AUTO_COMMIT=${livraison.commit}`);
  const options =
    role === "worker"
      ? [
          "--no-healthcheck",
          "--group-add",
          "1000",
          "-e",
          `AUTO_API_URL=http://${api}:3000`,
          "-v",
          `${base}/arrivages:/mnt/arrivages`,
        ]
      : role === "api"
        ? ["-v", `${base}/arrivages:/mnt/arrivages:ro`]
        : [
            "-e",
            "PORT=3001",
            "-e",
            `AUTO_API_URL=http://${api}:3000`,
            "-e",
            "AUTO_MEDIA_DIR=/mnt/media",
            "-e",
            "AUTO_DISTRIBUTIONS_DIR=/mnt/distributions",
            "-v",
            `${base}/media:/mnt/media:ro`,
            "-v",
            `${base}/distributions:/mnt/distributions:ro`,
          ];
  await commande([
    "docker",
    "run",
    "-d",
    "--name",
    nom,
    "--network",
    "auto-prod",
    ...commun,
    "--env-file",
    env,
    ...identite,
    ...options,
    img,
    "bun",
    `apps/${role === "web" ? "web" : role}/src/index.ts`,
  ]);
}

async function attendre(nom: string) {
  for (let essai = 0; essai < 60; essai++) {
    const etat = await texte([
      "docker",
      "inspect",
      nom,
      "--format",
      "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
    ]);
    if (etat === "running healthy") return;
    if (!etat.startsWith("running")) throw new Error(`${nom} ne reste pas démarré`);
    await Bun.sleep(1000);
  }
  throw new Error(`${nom} : délai de santé dépassé`);
}

async function retirer(nom: string) {
  const existe = Bun.spawnSync(["docker", "inspect", nom], { stdout: "ignore", stderr: "ignore" });
  if (existe.exitCode !== 0) return;
  await commande(["docker", "stop", "--time", "60", nom]);
  await commande(["docker", "rm", nom]);
}

/** Remplace (ou ajoute) des clés dans un contenu d'environnement. */
function remplacerEnv(contenu: string, valeurs: Record<string, string>) {
  for (const [cle, valeur] of Object.entries(valeurs)) {
    const expression = new RegExp(`^(?:export\\s+)?${cle}=.*$`, "m");
    contenu = expression.test(contenu)
      ? contenu.replace(expression, () => `${cle}=${valeur}`)
      : `${contenu.replace(/\n?$/, "\n")}${cle}=${valeur}\n`;
  }
  return contenu;
}

/** Recrée API, worker et web sur des images données, puis vérifie la santé locale et publique. */
async function demarrer(images: { api: string; worker: string; web: string }) {
  await retirer("auto-worker");
  await retirer("auto-api");
  await lancer("auto-api", "api", images.api, `${base}/prod.env`);
  await attendre("auto-api");
  await lancer("auto-worker", "worker", images.worker, `${base}/prod.env`);
  await retirer("auto-web");
  await lancer("auto-web", "web", images.web, `${base}/prod.env`);
  await attendre("auto-web");
  await Bun.sleep(3000);
  if (
    (await texte(["docker", "inspect", "auto-worker", "--format", "{{.State.Status}} {{.RestartCount}}"])) !==
    "running 0"
  )
    throw new Error("Le worker ne reste pas stable");
  const r = await fetch("https://auto.aphrody.com/health", { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Sonde publique : ${r.status}`);
}

if (action === "relancer") {
  console.log(`Relance de ${version} avec le prod.env courant`);
  await demarrer({ api: image, worker: image, web: imageWeb });
  console.log(`Livraison ${version} relancée`);
  process.exit(0);
}

const projetNeon = await projet(neon);
console.log(`Livraison ${version} : sauvegarde chiffrée et branche Neon de migration`);
await commande(["bash", `${base}/sauvegarde.sh`]);
await creerBranche(neon, projetNeon, brancheCandidate, { ttlHeures: 6 });
try {
  const contenu = remplacerEnv(
    await Bun.file(`${base}/prod.env`).text(),
    await envBranche(neon, projetNeon, brancheCandidate),
  );
  await Bun.write(envCandidat, contenu);
  await $`chmod 600 ${envCandidat}`;
  await lancer(apiCandidat, "api", image, envCandidat);
  await attendre(apiCandidat);
  await lancer(webCandidat, "web", imageWeb, envCandidat, apiCandidat);
  await attendre(webCandidat);
  await commande([
    "docker",
    "exec",
    apiCandidat,
    "bun",
    "-e",
    "import {creerDocx,remplacerDocx,texteDocx} from './packages/native/src/index.ts';const b=remplacerDocx(creerDocx({paragraphes:[{texte:'Élodie'}]}),[{chercher:'Élodie',remplacer:'François'}]);if(!texteDocx(b).includes('François'))throw Error('FFI invalide');console.log('FFI qualifiée')",
  ]);
  await commande([
    "docker",
    "exec",
    webCandidat,
    "bun",
    "-e",
    "const r=await fetch('http://127.0.0.1:3001/craft/manifest.json');if(!r.ok)throw Error('Craft absent');const m=await r.json();for(const s of ['word','grid','pdf']){if(!m.editeurs?.[s])throw Error('Craft incomplet '+s)}console.log('Craft présent')",
  ]);
  console.log("Copie de production : migrations, API, web et FFI qualifiés");
} catch (erreur) {
  const journal = Bun.spawnSync(["docker", "logs", "--tail", "40", apiCandidat], { stdout: "pipe", stderr: "pipe" });
  let diagnostic = `${journal.stdout.toString()}\n${journal.stderr.toString()}`;
  diagnostic = diagnostic.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s"']+:)[^@\s"']+@/gi, "$1[secret masqué]@");
  for (const [cle, valeur] of Object.entries(Bun.env))
    if (/SECRET|PASSWORD|MOT_DE_PASSE|CLE|TOKEN|KEY/.test(cle) && valeur && valeur.length > 8)
      diagnostic = diagnostic.replaceAll(valeur, "[secret masqué]");
  await Bun.write(`${dossier}/candidat-erreur.log`, diagnostic);
  await $`chmod 600 ${`${dossier}/candidat-erreur.log`}`;
  console.error(diagnostic.slice(-3500));
  throw erreur;
} finally {
  await retirer(webCandidat);
  await retirer(apiCandidat);
  await supprimerBranche(neon, projetNeon, brancheCandidate).catch((e) => console.error(String(e)));
  await $`rm -f ${envCandidat}`;
}
if (action === "valider") process.exit(0);

const noms = ["auto-api", "auto-worker", "auto-web"] as const;
const precedentes = Object.fromEntries(
  await Promise.all(
    noms.map(async (nom) => [nom, await texte(["docker", "inspect", nom, "--format", "{{.Image}}"])] as const),
  ),
);
await Bun.write(`${dossier}/retour.json`, JSON.stringify({ version, images: precedentes }, null, 2));
await $`chmod 600 ${`${dossier}/retour.json`}`;
for (const [nom, id] of Object.entries(precedentes)) await commande(["docker", "tag", id, `${nom}:avant-${version}`]);
try {
  console.log("Bascule : arrêt du worker et migration de production");
  await retirer("auto-worker");
  if (Bun.env.AUTO_ROTATION_DB === "1") {
    await retirer("auto-api");
    await reinitialiserMotDePasse(neon, projetNeon);
    const fichier = `${base}/prod.env`;
    const contenu = await Bun.file(fichier).text();
    await Bun.write(`${fichier}.avant-${version}`, contenu);
    await $`chmod 600 ${`${fichier}.avant-${version}`}`;
    await Bun.write(`${fichier}.nouveau`, remplacerEnv(contenu, await envBranche(neon, projetNeon)));
    await $`chmod 600 ${`${fichier}.nouveau`}`;
    await $`mv ${`${fichier}.nouveau`} ${fichier}`;
    console.log("Mot de passe Neon renouvelé dans le fichier protégé");
  }
  await commande([
    "docker",
    "run",
    "--rm",
    "--network",
    "auto-prod",
    "--env-file",
    `${base}/prod.env`,
    image,
    "bun",
    "packages/store/src/migrate.ts",
  ]);
  await demarrer({ api: image, worker: image, web: imageWeb });
  await Bun.write(
    `${base}/current-release.json`,
    JSON.stringify({ version, image, imageWeb, date: new Date().toISOString() }, null, 2),
  );
  console.log(`Livraison ${version} en ligne ; images précédentes conservées`);
} catch (erreur) {
  console.error("Bascule en échec : reprise des images précédentes, sauvegarde conservée");
  await retirer("auto-worker");
  await retirer("auto-web");
  await retirer("auto-api");
  await lancer("auto-api", "api", precedentes["auto-api"]!, `${base}/prod.env`);
  await attendre("auto-api");
  await lancer("auto-worker", "worker", precedentes["auto-worker"]!, `${base}/prod.env`);
  await lancer("auto-web", "web", precedentes["auto-web"]!, `${base}/prod.env`);
  await attendre("auto-web");
  throw erreur;
}

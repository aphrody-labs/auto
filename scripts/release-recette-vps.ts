// Qualification native sur une instance isolée, sans modifier la production.
import { sauvegarder, executer } from "./sauvegarde";

const version = Bun.argv[2];
if (!version || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(version)) throw Error("Livraison invalide");
const base = `${Bun.env.HOME}/auto/recette`;
const env = `${base}/app.env`;
await sauvegarder({ conteneur: "auto-pg-recette", dossier: `${base}/sauvegardes` });
const ancien = await Bun.file(env).text();
await Bun.write(`${env}.avant-appareils`, ancien, { mode: 0o600 });
await Bun.write(
  env,
  `${ancien.replace(/^AUTO_CONNEXION_APPAREIL=.*\r?\n?/gm, "").trim()}\nAUTO_CONNEXION_APPAREIL=1\n`,
  { mode: 0o600 },
);
const commande = async (args: string[]) => executer(args);
for (const role of ["api", "web"]) {
  const nom = `auto-${role}-recette`;
  await commande(["docker", "stop", "--time", "60", nom]);
  await commande(["docker", "rm", nom]);
  await commande([
    "docker",
    "run",
    "-d",
    "--name",
    nom,
    "--network",
    "auto-recette",
    "--restart",
    "unless-stopped",
    "--init",
    "--user",
    "10001:10001",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs",
    "/home/auto:rw,nosuid,nodev,size=256m,uid=10001,gid=10001",
    "--env-file",
    env,
    ...(role === "api"
      ? ["-v", `${base}/arrivages:/mnt/arrivages:ro`]
      : ["-e", "PORT=3001", "-e", "AUTO_API_URL=http://auto-api-recette:3000"]),
    `auto-${role === "api" ? "app" : "web"}:${version}`,
    "bun",
    `apps/${role}/src/index.ts`,
  ]);
  let sain = false;
  for (let i = 0; i < 60; i++) {
    const etat = new TextDecoder()
      .decode(await commande(["docker", "inspect", nom, "--format", "{{.State.Health.Status}}"]))
      .trim();
    if (etat === "healthy") {
      sain = true;
      break;
    }
    await Bun.sleep(1000);
  }
  if (!sain) throw Error(`${nom} ne devient pas sain`);
}
console.log("Recette isolée saine ; connexion appareil activée");

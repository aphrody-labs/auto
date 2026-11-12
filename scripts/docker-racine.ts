// Chemin d'un dossier du poste vu par le démon Docker : sous Windows avec un dockerd Linux hors Docker Desktop
// (WSL), `C:/x` est monté `/mnt/c/x` ; ailleurs, le chemin est inchangé.
import { $ } from "bun";

export async function racineDocker(chemin: string): Promise<string> {
  const normalise = chemin.replace(/\\/g, "/").replace(/\/$/, "");
  if (process.platform !== "win32" || !/^[A-Za-z]:\//.test(normalise)) return normalise;
  const os = (await $`docker info --format {{.OperatingSystem}}`.quiet().nothrow()).stdout.toString();
  if (os.includes("Docker Desktop")) return normalise;
  return `/mnt/${normalise[0]!.toLowerCase()}${normalise.slice(2)}`;
}

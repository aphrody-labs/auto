// Hôte de production (usa, alias ssh `prd`) et racine de ses données, partagés par les scripts d'exploitation.
// L'hôte et la racine se changent par AUTO_HOTE et AUTO_RACINE (essais sur un autre serveur).
export const HOTE = Bun.env.AUTO_HOTE ?? "prd";
export const RACINE = Bun.env.AUTO_RACINE ?? "/srv/auto"; // paths:ok disposition fixe des données sur l'hôte usa

const ssh = Bun.which("ssh") ?? "ssh";

/** Exécute une commande sur l'hôte et renvoie sa sortie ; échoue avec `echec` si le code de sortie n'est pas nul. */
export async function distant(commande: string, echec: string): Promise<string> {
  const p = Bun.spawn([ssh, "-o", "BatchMode=yes", HOTE, commande], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [sortie, code] = await Promise.all([p.stdout.text(), p.exited]);
  if (code !== 0) throw Error(echec);
  return sortie;
}

/** Copie un fichier local vers l'hôte (`scp` lancé avec le même ssh) ; échoue avec `echec` si la copie échoue. */
export async function copier(local: string, destination: string, echec: string): Promise<void> {
  const p = Bun.spawn(["scp", "-q", "-S", ssh, "-o", "BatchMode=yes", local, `${HOTE}:${destination}`], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) throw Error(echec);
}

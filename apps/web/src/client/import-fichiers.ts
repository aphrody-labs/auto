export const LIMITE_FICHIERS = 5000;
export const LIMITE_FICHIER = 20 * 1024 * 1024;
export const LIMITE_LOT = 1024 * 1024 * 1024;
export interface FichierLocal {
  fichier: File;
  chemin: string;
}

/** Ne lit pas les contenus : les octets sont envoyés seulement au passage du fichier dans la file. */
export function selectionFichiers(fichiers: Iterable<File>): FichierLocal[] {
  return [...fichiers].map((fichier) => ({ fichier, chemin: fichier.webkitRelativePath || fichier.name }));
}
export function validerSelection(existants: FichierLocal[], ajouts: FichierLocal[]) {
  const uniques = new Map<string, FichierLocal>();
  for (const f of [...existants, ...ajouts]) {
    const chemin = f.chemin.replaceAll("\\", "/");
    if (!chemin || chemin.startsWith("/") || chemin.split("/").some((s) => !s || s === "." || s === ".."))
      throw Error("Un chemin de fichier est invalide.");
    uniques.set(`${chemin}\0${f.fichier.size}\0${f.fichier.lastModified}`, { ...f, chemin });
  }
  const resultat = [...uniques.values()];
  if (resultat.length > LIMITE_FICHIERS) throw Error("5 000 fichiers maximum par lot.");
  if (resultat.reduce((s, f) => s + f.fichier.size, 0) > LIMITE_LOT) throw Error("1 Go maximum par lot.");
  return resultat;
}

/** Les lecteurs Chromium renvoient les dossiers par pages : vider chaque lecteur, pas seulement les 100 premiers. */
export async function fichiersDeposes(transfert: DataTransfer): Promise<FichierLocal[]> {
  const entrees = [...transfert.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  const simples = selectionFichiers(transfert.files);
  if (!entrees.length) return simples;
  const resultat: FichierLocal[] = [];
  const file = [...entrees];
  let visites = 0;
  while (file.length) {
    const entree = file.shift()!;
    if (++visites > 20_000)
      throw Error("Ce dossier contient trop d’entrées. Sélectionnez ses sous-dossiers séparément.");
    if (entree.isFile) {
      const fichier = await new Promise<File>((ok, ko) => (entree as FileSystemFileEntry).file(ok, ko));
      resultat.push({ fichier, chemin: entree.fullPath.replace(/^\//, "") });
      if (resultat.length > LIMITE_FICHIERS) throw Error("5 000 fichiers maximum par lot.");
    } else if (entree.isDirectory) {
      const lecteur = (entree as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const enfants = await new Promise<FileSystemEntry[]>((ok, ko) => lecteur.readEntries(ok, ko));
        if (!enfants.length) break;
        file.push(...enfants);
        if (file.length + visites > 20_000) throw Error("Ce dossier contient trop d’entrées.");
      }
    }
  }
  return resultat;
}

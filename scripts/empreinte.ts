/** Empreinte du contenu réel : inclut les modifications non indexées et les suppressions. */
export async function empreinteFichiers(fichiers: Iterable<string>): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for (const chemin of [...new Set(fichiers)].sort()) {
    hash.update(`${chemin}\0`);
    const fichier = Bun.file(chemin);
    if (await fichier.exists()) hash.update(await fichier.bytes());
    else hash.update("<absent>");
    hash.update("\0");
  }
  return hash.digest("hex");
}

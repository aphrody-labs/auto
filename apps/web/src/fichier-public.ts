/** Flux borné, HEAD et plages HTTP pour les gros téléchargements et la lecture vidéo. */
export async function fichierPublic(
  req: Request,
  chemin: string,
  options: {
    type: string;
    empreinte?: string;
    nom?: string;
    immutable?: boolean;
  },
): Promise<Response> {
  if (!["GET", "HEAD"].includes(req.method))
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const fichier = Bun.file(chemin);
  if (!(await fichier.exists()))
    return new Response("Fichier indisponible", { status: 404, headers: { "cache-control": "no-store" } });
  const taille = fichier.size;
  const etag = options.empreinte ? `"${options.empreinte}"` : `"${taille}-${fichier.lastModified}"`;
  const headers = new Headers({
    "content-type": options.type,
    "accept-ranges": "bytes",
    etag,
    "last-modified": new Date(fichier.lastModified).toUTCString(),
    "x-content-type-options": "nosniff",
    "cache-control": options.immutable ? "public, max-age=31536000, immutable" : "public, max-age=60, must-revalidate",
  });
  if (options.nom) headers.set("content-disposition", `attachment; filename="${options.nom}"`);
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  let debut = 0,
    fin = taille - 1,
    status = 200;
  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  if (range && (!ifRange || ifRange === etag || ifRange === headers.get("last-modified"))) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]) || taille === 0) return insatisfaisable();
    if (!m[1]) {
      const suffixe = Number(m[2]);
      if (!Number.isSafeInteger(suffixe) || suffixe <= 0) return insatisfaisable();
      debut = Math.max(0, taille - suffixe);
    } else {
      debut = Number(m[1]);
      fin = m[2] ? Math.min(Number(m[2]), taille - 1) : fin;
      if (!Number.isSafeInteger(debut) || !Number.isSafeInteger(fin) || debut > fin || debut >= taille)
        return insatisfaisable();
    }
    status = 206;
    headers.set("content-range", `bytes ${debut}-${fin}/${taille}`);
  }
  headers.set("content-length", String(Math.max(0, fin - debut + 1)));
  return new Response(req.method === "HEAD" ? null : fichier.slice(debut, fin + 1), { status, headers });
  function insatisfaisable() {
    headers.set("content-range", `bytes */${taille}`);
    return new Response(null, { status: 416, headers });
  }
}

import type { Scene } from "./scenario";

/** Catalogue local autonome, sans données de compte ni requêtes externes. */
export async function genererCatalogue(out: string, scenes: Scene[]) {
  const recordings = [...new Bun.Glob("*.webm").scanSync({ cwd: `${out}/parcours-brut`, onlyFiles: true })]
    .map((name) => ({ name, modified: Bun.file(`${out}/parcours-brut/${name}`).lastModified }))
    .sort((a, b) => b.modified - a.modified);
  if (recordings[0])
    await Bun.write(`${out}/parcours-reel.webm`, Bun.file(`${out}/parcours-brut/${recordings[0].name}`));
  const provenance = (await Bun.file(`${out}/captures/provenance.json`).json()) as {
    file: string;
    heading?: string;
    path?: string;
    origin: string;
  }[];
  const escape = Bun.escapeHTML;
  const shots = provenance
    .map(
      (item) =>
        `<a class="shot" href="captures/${escape(item.file)}"><img loading="lazy" src="captures/${escape(item.file)}" alt="${escape(item.heading ?? item.file)}"><h3>${escape(item.heading ?? item.file.replace(/\.png$/, ""))}</h3><p>${escape(item.path ?? "Site public")}</p><small>${escape(item.origin)}</small></a>`,
    )
    .join("");
  const plans = scenes
    .map(
      (s, i) =>
        `<a class="shot" href="planches/${String(i + 1).padStart(2, "0")}-${escape(s.id)}.png"><img loading="lazy" src="planches/${String(i + 1).padStart(2, "0")}-${escape(s.id)}.png" alt="${escape(s.title)}"><h3>${String(i + 1).padStart(2, "0")} · ${escape(s.title.replaceAll("\n", " "))}</h3></a>`,
    )
    .join("");
  await Bun.write(
    `${out}/index.html`,
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>auto · lancement BTP</title><style>body{margin:0;background:#071d1a;color:#eef8f1;font:17px/1.6 system-ui,sans-serif}main{max-width:1260px;margin:auto;padding:56px 24px}h1{font-size:clamp(36px,6vw,76px);line-height:1.08;letter-spacing:-2px;max-width:1000px}h2{font-size:34px;margin-top:80px}p{color:#c1d9cb}video{width:100%;border-radius:16px;background:#000;margin:20px 0}a{color:#b4f6ca}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:26px}.shot{text-decoration:none;border-bottom:1px solid #45614f;padding-bottom:20px}.shot img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#103428;border-radius:10px}.shot h3{font-size:18px;line-height:1.4;margin:14px 0 4px}.shot p,.shot small{font-size:13px;line-height:1.4;margin:0;color:#b2cabb}nav{display:flex;gap:24px;flex-wrap:wrap}small{color:#9abaac}</style><main><strong>auto · présentation française pour le BTP</strong><h1>Du chantier au bureau,<br>tout se retrouve.</h1><p>Présentation du produit, cas d’usage et démarrage. Captures de l’application réelle sur PostgreSQL de démonstration.</p><video controls preload="metadata" poster="planches/01-ouverture.png"><source src="auto-btp-lancement-fr.mp4" type="video/mp4"></video><nav><a href="auto-btp-lancement-fr.mp4" download>Télécharger la vidéo</a><a href="parcours-reel.webm">Voir l’enregistrement réel du parcours</a><a href="captures/provenance.json">Provenance des captures</a><a href="rendu.json">Reçu du rendu</a><a href="verification.json">Vérification finale</a></nav><h2>Les ${scenes.length} plans du film</h2><div class="grid">${plans}</div><h2>Les écrans capturés</h2><p>Parcours métier et navigation principale. Ces captures ne constituent pas une qualification de toutes les intégrations externes ou de tous les cas d’erreur.</p><div class="grid">${shots}</div><p><small>Données fictives, application et base réelles. Les originaux et preuves restent locaux.</small></p></main></html>`,
  );
}

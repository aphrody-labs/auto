// Construction de production du front, en mémoire au démarrage du serveur : `Bun.build` des pages HTML avec
// découpage du code (`splitting`, impossible avec les imports HTML de `Bun.serve`), puis pour l'accueil :
// prérendu React au build (contenu et <h1> avant JavaScript ; seul le script des îlots part au navigateur) et CSS incorporée
// (pas de feuille bloquante à télécharger). En développement, serveur.ts garde les imports HTML et le HMR.
import type { BunPlugin } from "bun";
import { renderToString } from "react-dom/server";
import { greffonPolices } from "./polices";
import { Accueil } from "./site/accueil";

export const PAGES = {
  accueil: "index.html",
  tarifs: "tarifs.html",
  telechargements: "telechargements.html",
  mentions: "mentions-legales.html",
  confidentialite: "confidentialite.html",
  devis: "devis.html",
  facture: "facture.html",
  app: "app.html",
} as const;
export type NomPage = keyof typeof PAGES;

export interface Ressource {
  corps: Uint8Array<ArrayBuffer>;
  type: string;
}
export interface Site {
  pages: Record<NomPage, string>;
  /** Fichiers à empreinte (`/chunk-….js`, `/chunk-….css`…), servis en cache immuable. */
  ressources: Map<string, Ressource>;
}

const RACINE = /<div id="racine">[\s\S]*?<\/div>/;
const SCRIPT_MODULE = /<script type="module"[^>]*src="\/[^"]+\.js"[^>]*><\/script>/;

/**
 * Accueil : contenu React prérendu dans #racine, CSS en ligne (aucune feuille bloquante) et, à la place du bundle
 * React, le seul script des îlots (`script`, chemin à empreinte).
 */
export function finaliserAccueil(html: string, ressources: Map<string, Ressource>, script: string): string {
  if (!RACINE.test(html)) throw new Error("index.html : #racine introuvable");
  if (!SCRIPT_MODULE.test(html)) throw new Error("index.html : script de la vitrine introuvable");
  const contenu = renderToString(<Accueil />);
  let sortie = html.replace(RACINE, () => `<div id="racine" data-prerendu>${contenu}</div>`);
  sortie = sortie.replace(SCRIPT_MODULE, () => `<script type="module" crossorigin src="${script}"></script>`);
  return incorporerCss(sortie, ressources);
}

/** Feuilles du site remplacées par leur contenu en `<style>` : rien ne bloque le premier rendu. */
export function incorporerCss(html: string, ressources: Map<string, Ressource>): string {
  return html.replace(/<link rel="stylesheet"[^>]*href="(\/[^"]+\.css)"[^>]*>/g, (lien, href: string) => {
    const css = ressources.get(href);
    if (!css) return lien;
    const texte = new TextDecoder().decode(css.corps);
    return texte.includes("</style") ? lien : `<style>${texte}</style>`;
  });
}

export async function construireSite(): Promise<Site> {
  const dossier = Bun.fileURLToPath(new URL("../public/", import.meta.url));
  // Même greffon que bunfig `[serve.static]` ; chargé dynamiquement pour que `bun check` ne vérifie pas ses sources.
  const paquet = "@aphrody/bun-plugin-tailwind";
  const tailwind = ((await import(paquet)) as { default: BunPlugin }).default;
  const options: Omit<Bun.BuildConfig, "entrypoints"> = {
    splitting: true,
    minify: true,
    target: "browser",
    publicPath: "/",
    plugins: [tailwind, greffonPolices],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  };
  // Une construction par page : l'accueil ne reçoit pas le morceau partagé avec l'application (React plus le code
  // commun de toutes les pages), seulement ce qu'il importe. Les noms à empreinte de contenu ne se chevauchent pas.
  const [ilots, ...resultats] = await Promise.all([
    Bun.build({
      ...options,
      entrypoints: [Bun.fileURLToPath(new URL("./site/accueil-ilots.ts", import.meta.url))],
      naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]" },
    }),
    ...Object.values(PAGES).map((f) => Bun.build({ ...options, entrypoints: [`${dossier}${f}`] })),
  ]);
  const ressources = new Map<string, Ressource>();
  const html = new Map<string, string>();
  let scriptIlots = "";
  for (const resultat of [ilots!, ...resultats]) {
    if (!resultat.success) throw new AggregateError(resultat.logs, "Construction du front en échec");
    for (const sortie of resultat.outputs) {
      const nom = sortie.path.replace(/^.*[\\/]/, "");
      if (nom.endsWith(".html")) html.set(nom, await sortie.text());
      else ressources.set(`/${nom}`, { corps: new Uint8Array(await sortie.arrayBuffer()), type: sortie.type });
      if (resultat === ilots && sortie.kind === "entry-point") scriptIlots = `/${nom}`;
    }
  }
  if (!scriptIlots) throw new Error("Script des îlots absent de la construction");
  const pages = {} as Record<NomPage, string>;
  for (const [nom, fichier] of Object.entries(PAGES) as [NomPage, string][]) {
    const page = html.get(fichier);
    if (!page) throw new Error(`Page absente de la construction : ${fichier}`);
    // Accueil prérendu ; application (connexion comprise) avec sa CSS en ligne : aucune feuille bloquante.
    pages[nom] =
      nom === "accueil"
        ? finaliserAccueil(page, ressources, scriptIlots)
        : nom === "app"
          ? incorporerCss(page, ressources)
          : page;
  }
  return { pages, ressources };
}

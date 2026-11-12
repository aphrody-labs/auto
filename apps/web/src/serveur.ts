// Serveur du front : pages HTML importées (bundling natif de Bun, HMR en dev) et proxy same-origin de
// `/v1`, `/api/auth`, `/.well-known` et `/mcp` vers l'API. Le front reste sans état, sans base ni bibliothèque native : il se déploie à part.
import app from "../public/app.html";
import accueil from "../public/index.html";
import mentions from "../public/mentions-legales.html";
import confidentialite from "../public/confidentialite.html";
import tarifs from "../public/tarifs.html";
import telechargements from "../public/telechargements.html";
import devis from "../public/devis.html";
import facture from "../public/facture.html";
import { proxifier } from "@auto/client/proxy";
import { palettes } from "@auto/ui";
import { icone } from "@auto/ui/icone";
import { TRACES } from "@auto/ui/traces";
import { ressourcesCraft } from "./craft";
import { fichierPublic } from "./fichier-public";
import { routePolice } from "./polices";
import { construireSite, type NomPage } from "./construction";
import { POINT_RAPPORT, reponsePage, routeRapportCsp, routesReferencement } from "./securite";
import { routesDistributions } from "./distributions";

export { proxifier };

export interface OptionsWeb {
  /** URL de base de l'API (`AUTO_API_URL`). */
  api: string | URL;
  /** Développement (HMR) : pages servies telles quelles, sans copie en mémoire ni CSP. */
  development?: boolean;
}

/** Application installable (PWA) : ouverte sur /app, en plein écran, sur mobile comme sur ordinateur. */
export const MANIFESTE = {
  name: "auto, gestion d'entreprise",
  short_name: "auto",
  description: "Devis, factures Factur-X, paiements, relances, factures reçues et équipe.",
  lang: "fr",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  theme_color: palettes.clair.primaire,
  background_color: palettes.clair.surface,
  icons: [192, 512].map((t) => ({ src: `/icones/${t}.png`, sizes: `${t}x${t}`, type: "image/png" })),
};

/** Icônes dessinées à la première demande puis gardées en mémoire (192 et 512 pour le manifeste, 180 pour iOS). */
const icones = new Map<number, Uint8Array<ArrayBuffer>>();
function reponseIcone(t: number) {
  if (!icones.has(t)) icones.set(t, new Uint8Array(icone(t)));
  return new Response(icones.get(t)!, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}

function routeIcone(req: Request & { params: { taille: string } }) {
  const t = Number(req.params.taille.replace(/\.png$/, ""));
  if (![180, 192, 512].includes(t)) return new Response("Icône introuvable", { status: 404 });
  return reponseIcone(t);
}

/** Planche d'icônes Material Symbols (une `<symbol>` par icône) : `<svg><use href="/icones/symboles.svg#Nom"/></svg>`. */
const PLANCHE = `<svg xmlns="http://www.w3.org/2000/svg">${Object.entries(TRACES)
  .map(([nom, d]) => `<symbol id="${nom}" viewBox="0 -960 960 960"><path d="${d}"/></symbol>`)
  .join("")}</svg>`;

/** Captures de l'application de la vitrine (`bun run vitrine`) : fichiers .webp du dossier public/img, jamais d'autre chemin. */
function routeImage(req: Request & { params: { fichier: string } }) {
  const m = /^[a-z0-9-]+\.(webp|jpg)$/.exec(req.params.fichier);
  if (!m || (m[1] === "jpg" && req.params.fichier !== "og-auto.jpg"))
    return new Response("Image introuvable", { status: 404 });
  const publicDir = Bun.env.AUTO_PUBLIC_DIR
    ? Bun.pathToFileURL(`${Bun.env.AUTO_PUBLIC_DIR.replace(/[\\/]+$/, "")}/`)
    : new URL("../public/", import.meta.url);
  const f = Bun.file(new URL(`img/${req.params.fichier}`, publicDir));
  const type = m[1] === "jpg" ? "image/jpeg" : "image/webp";
  return f
    .exists()
    .then((ok) =>
      ok
        ? new Response(f, { headers: { "content-type": type, "cache-control": "public, max-age=604800" } })
        : new Response("Image introuvable", { status: 404 }),
    );
}

/** Variantes responsives à empreinte (scripts/images.ts) : `/img/v/<nom>-<largeur>-<empreinte>.avif|webp`, immuables. */
const empreintesImages = new Map<string, boolean>();
async function routeImageVariante(req: Request & { params: { fichier: string } }) {
  const m = /^[a-z0-9-]+-\d+-([a-f0-9]{10})\.(avif|webp)$/.exec(req.params.fichier);
  if (!m) return new Response("Image introuvable", { status: 404 });
  const publicDir = Bun.env.AUTO_PUBLIC_DIR
    ? Bun.pathToFileURL(`${Bun.env.AUTO_PUBLIC_DIR.replace(/[\\/]+$/, "")}/`)
    : new URL("../public/", import.meta.url);
  const f = Bun.file(new URL(`img/v/${req.params.fichier}`, publicDir));
  if (!(await f.exists())) return new Response("Image introuvable", { status: 404 });
  let valide = empreintesImages.get(req.params.fichier);
  if (valide === undefined) {
    valide = new Bun.CryptoHasher("sha256")
      .update(await f.bytes())
      .digest("hex")
      .startsWith(m[1]!);
    empreintesImages.set(req.params.fichier, valide);
  }
  if (!valide) return new Response("Image introuvable", { status: 404 });
  return new Response(f, {
    headers: {
      "content-type": `image/${m[2]}`,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

async function routeMarque(req: Request & { params: { fichier: string } }) {
  if (!["google.svg", "microsoft.svg"].includes(req.params.fichier))
    return new Response("Marque introuvable", { status: 404 });
  const publicDir = Bun.env.AUTO_PUBLIC_DIR
    ? Bun.pathToFileURL(`${Bun.env.AUTO_PUBLIC_DIR.replace(/[\\/]+$/, "")}/`)
    : new URL("../public/", import.meta.url);
  const fichier = Bun.file(new URL(`brands/${req.params.fichier}`, publicDir));
  return (await fichier.exists())
    ? new Response(fichier, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } })
    : new Response("Marque introuvable", { status: 404 });
}

function videoPublique(req: Request) {
  if (!["GET", "HEAD"].includes(req.method))
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  if (Bun.env.AUTO_MEDIA_URL) {
    try {
      const url = new URL(Bun.env.AUTO_MEDIA_URL);
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash)
        return new Response(null, {
          status: 302,
          headers: { location: url.href, "cache-control": "public, max-age=60" },
        });
    } catch {
      // Configuration invalide : ne pas rediriger vers une adresse arbitraire.
    }
    return new Response("Vidéo indisponible", { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Bun.env.AUTO_MEDIA_DIR
    ? fichierPublic(req, `${Bun.env.AUTO_MEDIA_DIR.replace(/[\\/]+$/, "")}/lancement-btp.mp4`, { type: "video/mp4" })
    : new Response("Vidéo indisponible", { status: 404, headers: { "cache-control": "no-store" } });
}

const HTML = { accueil, tarifs, telechargements, mentions, confidentialite, devis, facture, app } as const;

/**
 * Pages HTML et ressources du front. Développement : imports HTML de `Bun.serve` (HMR). Production : construction
 * en mémoire au démarrage (construction.tsx : découpage du code, accueil prérendu), pages servies avec leurs
 * en-têtes de sécurité, ressources à empreinte en cache immuable.
 */
function front(development: boolean) {
  if (development)
    return { page: (nom: NomPage) => HTML[nom], ressource: async () => undefined as Response | undefined };
  const site = construireSite();
  site.catch((e) => console.error("Construction du front en échec", e));
  const page = (nom: NomPage) => async (req: Request) => {
    try {
      return reponsePage(req, (await site).pages[nom]);
    } catch {
      return new Response("Page indisponible", { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
  const ressource = async (req: Request) => {
    const r = await site.then((s) => s.ressources.get(new URL(req.url).pathname)).catch(() => undefined);
    if (!r) return undefined;
    return new Response(r.corps, {
      headers: {
        "content-type": r.type,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  };
  return { page, ressource };
}

/** Routes `Bun.serve` du front. */
export function routesWeb(o: OptionsWeb, f = front(o.development ?? false)) {
  const proxy = proxifier(o.api);
  return {
    ...ressourcesCraft(Bun.env.AUTO_PUBLIC_DIR),
    ...routesDistributions(),
    ...routesReferencement(),
    [POINT_RAPPORT]: routeRapportCsp(),
    "/": f.page("accueil"),
    "/tarifs": f.page("tarifs"),
    "/telechargements": f.page("telechargements"),
    "/download": () => Response.redirect("https://auto.aphrody.com/telechargements", 302),
    "/media/lancement-btp.mp4": videoPublique,
    "/mentions-legales": f.page("mentions"),
    "/confidentialite": f.page("confidentialite"),
    "/devis/:jeton": f.page("devis"),
    "/facture/:jeton": f.page("facture"),
    "/app": f.page("app"),
    "/app/*": f.page("app"),
    "/manifest.webmanifest": Response.json(MANIFESTE, {
      headers: { "content-type": "application/manifest+json" },
    }),
    "/img/:fichier": routeImage,
    "/img/v/:fichier": routeImageVariante,
    "/polices/:fichier": routePolice,
    "/brands/:fichier": routeMarque,
    "/icones/symboles.svg": new Response(PLANCHE, {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    }),
    "/icones/:taille": routeIcone,
    // Demandé d'office par les navigateurs : PNG 32 px (accepté sous ce nom par tous les navigateurs actuels).
    "/favicon.ico": () => reponseIcone(32),
    "/v1/*": proxy,
    "/health": proxy,
    // Better Auth (sessions, OAuth des clients MCP) et serveur MCP distant : servis par l'API.
    "/api/auth/*": proxy,
    "/.well-known/*": proxy,
    "/mcp": proxy,
    // Anciens liens d'invitation (`/invitation#<jeton>`) : le fragment suit la redirection.
    "/invitation": () => new Response(null, { status: 302, headers: { location: "/app/invitation" } }),
  };
}

export function demarrerWeb(o: OptionsWeb & { port?: number; hostname?: string; development?: boolean }) {
  const f = front(o.development ?? false);
  return Bun.serve({
    port: o.port ?? 0,
    hostname: o.hostname,
    development: o.development ?? false,
    routes: routesWeb(o, f),
    fetch: async (req) =>
      (await f.ressource(req)) ??
      new Response("Page introuvable", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
}

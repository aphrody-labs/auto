// Polices autohébergées (Fontsource) servies en fichiers séparés, nommés par empreinte de contenu, au lieu d'être
// incrustées en base64 dans la CSS bloquante (le bundler de Bun incruste tout `url()` de moins de 128 Kio).
// Le greffon du bundler (bunfig `[serve.static]`) réécrit chaque `url(.../@fontsource/<famille>/files/<f>.woff2)`
// en `/polices/<f>-<empreinte>.woff2`, laissé externe ; `routePolice` sert ces fichiers en cache immuable.
// Les @font-face de Fontsource gardent `font-display: swap` et leurs sous-ensembles `unicode-range`.
import type { BunPlugin } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PREFIXE_POLICES = "/polices/";
/** Familles servies : les seules dont un `url()` peut être réécrit et dont un fichier peut être lu. */
const FAMILLES = ["inter", "plus-jakarta-sans", "material-symbols-rounded"] as const;
const FICHIER_FONTSOURCE = /[\\/]@fontsource[\\/]([a-z0-9-]+)[\\/]files[\\/]([a-z0-9-]+\.woff2?)$/;
const NOM_PUBLIE = /^([a-z0-9-]+)-([a-f0-9]{10})\.(woff2?)$/;

const empreintes = new Map<string, string>();
/** Empreinte SHA-256 (10 caractères hexadécimaux) du contenu d'un fichier de police. */
function empreinte(chemin: string): string {
  let e = empreintes.get(chemin);
  if (!e) {
    const octets = readFileSync(chemin);
    e = new Bun.CryptoHasher("sha256").update(octets).digest("hex").slice(0, 10);
    empreintes.set(chemin, e);
  }
  return e;
}

/** URL publique d'un fichier Fontsource (chemin absolu), ou `undefined` s'il n'est pas d'une famille servie. */
export function urlPolice(chemin: string): string | undefined {
  const m = FICHIER_FONTSOURCE.exec(chemin);
  if (!m || !(FAMILLES as readonly string[]).includes(m[1]!)) return undefined;
  const [, , fichier] = m;
  const point = fichier!.lastIndexOf(".");
  return `${PREFIXE_POLICES}${fichier!.slice(0, point)}-${empreinte(chemin)}${fichier!.slice(point)}`;
}

/** Dossier `files/` d'une famille, résolu depuis apps/web (où les paquets sont déclarés). */
const dossiers = new Map<string, string>();
function dossierFamille(famille: string): string {
  let d = dossiers.get(famille);
  if (!d) {
    d = `${dirname(Bun.resolveSync(`@fontsource/${famille}/package.json`, import.meta.dir))}/files`;
    dossiers.set(famille, d);
  }
  return d;
}

/** Chemin du fichier servi sous `/polices/<nom>`, seulement si l'empreinte correspond au contenu actuel. */
export function cheminPolice(nom: string): string | undefined {
  const m = NOM_PUBLIE.exec(nom);
  if (!m) return undefined;
  const [, base, attendue, ext] = m;
  const famille = FAMILLES.find((f) => base!.startsWith(`${f}-`));
  if (!famille) return undefined;
  const chemin = `${dossierFamille(famille)}/${base}.${ext}`;
  if (!existsSync(chemin)) return undefined;
  return empreinte(chemin) === attendue ? chemin : undefined;
}

/** `GET /polices/:fichier` : WOFF2/WOFF à empreinte, cache d'un an immuable (l'URL change avec le contenu). */
export function routePolice(req: Request & { params: { fichier: string } }): Response {
  const chemin = cheminPolice(req.params.fichier);
  if (!chemin) return new Response("Police introuvable", { status: 404, headers: { "cache-control": "no-store" } });
  const ext = chemin.endsWith(".woff2") ? "woff2" : "woff";
  return new Response(Bun.file(chemin), {
    headers: {
      "content-type": `font/${ext}`,
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Chemin servi par le front (`/polices/...` préchargé, `/img/...` de `routeImage`), que `Bun.serve` peut avoir
 * préfixé par la racine du projet : à laisser externe, jamais à incruster. */
const CHEMIN_SERVI = /(?:^|[\\/])(polices[\\/][a-z0-9-]+-[a-f0-9]{10}\.woff2?|img[\\/][a-z0-9-]+\.webp)$/;

/**
 * Greffon du bundler : `url()` Fontsource → `/polices/...` externe ; les chemins servis `/polices/...`
 * (préchargement) et `/img/...` restent tels quels. Les `url()` des feuilles Fontsource non compilées par
 * Tailwind arrivent relatifs (`./files/...`) : le chemin absolu est reconstruit depuis `resolveDir`.
 */
export const greffonPolices: BunPlugin = {
  name: "auto-polices",
  setup(build) {
    build.onResolve({ filter: /\.(?:woff2?|webp)$/ }, (args) => {
      const servi = CHEMIN_SERVI.exec(args.path);
      if (servi && (args.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.path)) && !existsSync(args.path))
        return { path: `/${servi[1]!.replaceAll("\\", "/")}`, external: true };
      if (args.path.endsWith(".webp")) return undefined;
      const absolu = resolve(args.resolveDir || dirname(args.importer), args.path);
      const url = urlPolice(absolu);
      return url ? { path: url, external: true } : undefined;
    });
  },
};

export default greffonPolices;

import { fichierPublic } from "./fichier-public";

export interface Distribution {
  id: string;
  plateforme: "windows" | "linux" | "android" | "macos";
  architecture: string;
  type: "installateur" | "portable" | "autonome" | "apk";
  fichier: string;
  nom: string;
  octets: number;
  sha256: string;
  signature?: string;
  cibleUpdater?: string;
}
export interface Catalogue {
  schema: 1;
  version: string;
  date: string;
  notes: string;
  fichiers: Distribution[];
}
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NOM = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;

/** Origine d'objets publics configurée par l'opérateur, jamais issue d'une requête. */
export function baseDistributions(valeur = Bun.env.AUTO_DISTRIBUTIONS_OBJETS_URL): URL | null {
  if (!valeur) return null;
  try {
    const u = new URL(valeur);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u;
  } catch {
    return null;
  }
}

/** Le manifeste est publié atomiquement après les fichiers ; aucune entrée arbitraire du système de fichiers. */
export async function catalogue(
  dossier = Bun.env.AUTO_DISTRIBUTIONS_DIR,
  base = baseDistributions(),
): Promise<Catalogue | null> {
  try {
    let c: Catalogue;
    if (base) {
      const r = await fetch(new URL("manifest.json", base), { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!r.ok || !r.body) return null;
      const lecteur = r.body.getReader();
      const decodeur = new TextDecoder();
      let texte = "";
      let taille = 0;
      try {
        for (;;) {
          const { done, value } = await lecteur.read();
          if (done) break;
          taille += value.length;
          if (taille > 256 * 1024) return null;
          texte += decodeur.decode(value, { stream: true });
        }
      } finally {
        await lecteur.cancel();
      }
      c = JSON.parse(texte + decodeur.decode()) as Catalogue;
    } else {
      if (!dossier) return null;
      const f = Bun.file(`${dossier}/manifest.json`);
      if (!(await f.exists())) return null;
      c = (await f.json()) as Catalogue;
    }
    if (
      c.schema !== 1 ||
      !VERSION.test(c.version) ||
      !Number.isFinite(Date.parse(c.date)) ||
      typeof c.notes !== "string" ||
      !Array.isArray(c.fichiers)
    )
      return null;
    const noms = new Set<string>();
    for (const a of c.fichiers) {
      if (
        !NOM.test(a.fichier) ||
        noms.has(a.fichier) ||
        !/^[a-f0-9]{64}$/.test(a.sha256) ||
        !Number.isSafeInteger(a.octets) ||
        a.octets <= 0 ||
        typeof a.nom !== "string" ||
        !["windows", "linux", "android", "macos"].includes(a.plateforme) ||
        !["installateur", "portable", "autonome", "apk"].includes(a.type)
      )
        return null;
      if (a.cibleUpdater && (a.type !== "installateur" || typeof a.signature !== "string" || !a.signature.trim()))
        return null;
      noms.add(a.fichier);
    }
    return c;
  } catch {
    return null;
  }
}

export function comparerVersions(a: string, b: string): number | null {
  if (!VERSION.test(a) || !VERSION.test(b)) return null;
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isSafeInteger(x[i]) || !Number.isSafeInteger(y[i])) return null;
    if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1;
  }
  return 0;
}

export function routesDistributions() {
  return {
    "/api/distributions": async () => {
      const c = await catalogue();
      return Response.json(c ?? { schema: 1, fichiers: [], indisponible: true }, {
        headers: { "cache-control": "no-cache" },
      });
    },
    "/downloads/:fichier": async (req: Request & { params: { fichier: string } }) => {
      if (!["GET", "HEAD"].includes(req.method))
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      const c = await catalogue();
      const a = c?.fichiers.find((f) => f.fichier === req.params.fichier);
      if (!a) return new Response("Téléchargement indisponible", { status: 404 });
      const base = baseDistributions();
      if (base) {
        // La publication du manifeste est la dernière étape ; vérifier la taille avant de déléguer le flux.
        try {
          const cible = new URL(a.fichier, base);
          const r = await fetch(cible, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10_000) });
          if (!r.ok || Number(r.headers.get("content-length")) !== a.octets)
            return new Response("Téléchargement en maintenance", { status: 503 });
          return new Response(null, { status: 302, headers: { location: cible.href, "cache-control": "no-store" } });
        } catch {
          return new Response("Téléchargement en maintenance", { status: 503 });
        }
      }
      const chemin = `${Bun.env.AUTO_DISTRIBUTIONS_DIR}/${a.fichier}`;
      if (Bun.file(chemin).size !== a.octets) return new Response("Téléchargement en maintenance", { status: 503 });
      return fichierPublic(req, chemin, {
        type: "application/octet-stream",
        nom: a.fichier,
        empreinte: a.sha256,
        immutable: true,
      });
    },
    "/api/updates/:target/:arch/:version": async (
      req: Request & { params: { target: string; arch: string; version: string } },
    ) => {
      const c = await catalogue();
      if (!VERSION.test(req.params.version)) return new Response("Version invalide", { status: 400 });
      const a = c?.fichiers.find((f) => f.cibleUpdater === `${req.params.target}-${req.params.arch}`);
      if (!c || !a || comparerVersions(c.version, req.params.version) !== 1)
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      const base = new URL(Bun.env.AUTO_DISTRIBUTIONS_URL ?? "https://auto.aphrody.com");
      return Response.json(
        {
          version: c.version,
          pub_date: c.date,
          notes: c.notes,
          url: new URL(`/downloads/${a.fichier}`, base).href,
          signature: a.signature,
        },
        { headers: { "cache-control": "no-store" } },
      );
    },
  };
}

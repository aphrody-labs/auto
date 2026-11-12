import { resolve } from "node:path";
export interface ManifesteCraft {
  schema: number;
  version: string;
  editeurs: Record<
    string,
    { source: unknown; fichiers: Record<string, { sha256: string; taille: number; gzip?: string }> }
  >;
}
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
  css: "text/css; charset=utf-8",
  png: "image/png",
  json: "application/json",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
export function ressourcesCraft(publicDir?: string) {
  const root = publicDir
    ? resolve(publicDir, "craft")
    : Bun.fileURLToPath(new URL("../public/craft/", import.meta.url));
  let manifeste: Promise<ManifesteCraft | null> | undefined;
  const lire = () =>
    (manifeste ??= Bun.file(resolve(root, "manifest.json"))
      .json()
      .catch(() => null));
  return {
    "/craft/manifest.json": async () => {
      const m = await lire();
      return m
        ? Response.json(m, { headers: { "cache-control": "no-cache" } })
        : Response.json(
            { erreur: "Les éditeurs Craft ne sont pas installés dans cette distribution." },
            { status: 503 },
          );
    },
    "/craft/*": async (req: Request) => {
      const m = await lire();
      if (!m) return new Response("Éditeurs Craft non installés", { status: 503 });
      let parties: string[];
      try {
        parties = new URL(req.url).pathname.slice("/craft/".length).split("/").map(decodeURIComponent);
      } catch {
        return new Response(null, { status: 400 });
      }
      const [studio, version, ...reste] = parties;
      const nom = reste.join("/");
      if (
        !studio ||
        !["word", "grid", "pdf"].includes(studio) ||
        version !== m.version ||
        !nom ||
        reste.some((p) => !p || p === ".." || p === "." || p.includes("\\") || p.includes("/"))
      )
        return new Response(null, { status: 404 });
      const catalogue = m.editeurs[studio]?.fichiers;
      const s = catalogue && Object.hasOwn(catalogue, nom) ? catalogue[nom] : undefined;
      if (!s || !/^[a-f0-9]{64}$/.test(s.sha256) || (s.gzip && s.gzip !== nom + ".gz"))
        return new Response(null, { status: 404 });
      const gzip = !!s.gzip && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
      const f = Bun.file(resolve(root, studio, s.gzip ?? nom));
      if (!(await f.exists())) return new Response(null, { status: 404 });
      const contenu = s.gzip && !gzip ? Bun.gunzipSync(await f.bytes()) : f;
      return new Response(contenu, {
        headers: {
          "content-type": MIME[nom.split(".").at(-1) ?? ""] ?? "text/plain; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "content-security-policy": CSP,
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
          etag: `"${s.sha256}${gzip ? "-gzip" : ""}"`,
          vary: "Accept-Encoding",
          ...(gzip ? { "content-encoding": "gzip" } : {}),
        },
      });
    },
  };
}

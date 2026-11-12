import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PLANS } from "@auto/billing";
import { palettes } from "@auto/ui";
import { demarrerWeb } from "./serveur";
import { PAGES_PUBLIQUES, empreintesScripts, empreintesStyles, routeRapportCsp } from "./securite";
import { IMAGES } from "./site/images.gen";
import { srcsetAvif } from "./site/medias";

let api: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof demarrerWeb>;
const recues: { chemin: string; methode: string; entetes: Headers; corps: string }[] = [];

beforeAll(() => {
  api = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      recues.push({
        chemin: u.pathname + u.search,
        methode: req.method,
        entetes: req.headers,
        corps: await req.text(),
      });
      if (u.pathname === "/v1/moi") return Response.json({ erreur: "non authentifié" }, { status: 401 });
      return Response.json({ ok: true }, { headers: { "set-cookie": "auto_session=abc; HttpOnly; Secure; Path=/" } });
    },
  });
  web = demarrerWeb({ api: api.url });
});

afterAll(async () => {
  await web.stop(true);
  await api.stop(true);
});

const page = async (chemin: string) => {
  const r = await fetch(new URL(chemin, web.url));
  return { status: r.status, type: r.headers.get("content-type") ?? "", texte: await r.text() };
};

test("pages publiques : tarifs et mentions, contact dans le pied de page", async () => {
  for (const c of ["/tarifs", "/mentions-legales"]) {
    const p = await page(c);
    expect(p.status).toBe(200);
    expect(p.type).toContain("text/html");
    expect(p.texte).toContain('lang="fr"');
    expect(p.texte).toContain("mailto:contact@aphrody.com");
    expect(p.texte).toContain('href="#contenu"');
  }
});

// Le premier appel de "/" compile la vitrine React : délai élargi sous charge.
test("accueil : contenu prérendu (h1 avant JavaScript), CSS en ligne, script à empreinte servi", async () => {
  const p = await page("/");
  expect(p.status).toBe(200);
  expect(p.type).toContain("text/html");
  expect(p.texte).toContain('lang="fr"');
  expect(p.texte).toContain('<div id="racine" data-prerendu');
  expect(p.texte).toMatch(/<h1 id="titre">Du chantier/);
  expect(p.texte).toContain('href="/app/inscription"');
  expect(p.texte).not.toContain('<link rel="stylesheet"');
  expect(p.texte).toContain("<style>");
  const script = /<script type="module"[^>]*src="([^"]+)"/.exec(p.texte)?.[1];
  expect(script).toBeTruthy();
  const r = await fetch(new URL(script!, web.url));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("javascript");
  // Page prérendue : seuls les îlots (thème, onglets, film) partent au navigateur, pas React.
  expect((await r.clone().text()).length).toBeLessThan(20_000);
  expect(p.texte).toContain('role="tablist"');
  expect(p.texte).toContain('<template id="modele-film">');
  expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  // Images et affiche du film : variantes à empreinte (l'original ne reste qu'en lien « Agrandir »).
  expect(p.texte).not.toMatch(/(src|poster)="\/img\/btp-analytique\.webp"/);
  // Film : ni affiche ni source avant le clic ; l'affiche est une <picture> paresseuse (variantes de la capture).
  const film = /<template id="modele-film">([\s\S]*?)<\/template>/.exec(p.texte)![1]!;
  expect(film).not.toContain("poster=");
  expect(film).not.toContain("lancement-btp.mp4");
  expect(film).toContain('loading="lazy"');
  expect(film).toContain("btp-heros-film-affiche");
}, 30_000);

test("téléchargements : places réservées aux cartes du catalogue et aux notes (pas de décalage)", async () => {
  const html = (await page("/telechargements")).texte;
  expect(html.match(/distribution-attente/g)?.length).toBe(4);
  expect(html).toContain('id="notes-distributions"');
});

test("application : CSS en ligne, écrans découpés en morceaux chargés à la demande", async () => {
  const html = (await page("/app")).texte;
  expect(html).not.toContain('<link rel="stylesheet"');
  expect(html).toContain("<style>");
  const script = /<script type="module"[^>]*src="([^"]+)"/.exec(html)![1]!;
  const entree = await (await fetch(new URL(script, web.url))).text();
  const morceaux = [
    ...new Set([...entree.matchAll(/import\(["']((?:\.|)\/chunk-[^"']+\.js)["']\)/g)].map((m) => m[1]!)),
  ];
  expect(morceaux.length).toBeGreaterThan(10);
  const base = new URL(script, web.url);
  for (const m of morceaux.slice(0, 3)) expect((await fetch(new URL(m, base))).status).toBe(200);
}, 30_000);

/** CSS d'une page : feuille liée, ou `<style>` en ligne pour l'accueil. */
async function cssPage(html: string) {
  const lien = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
  if (!lien) return /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
  const r = await fetch(new URL(lien, web.url));
  expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  return r.text();
}

// Polices hors de la CSS bloquante (audit AU-1) : WOFF2 à empreinte, cache immuable, préchargement cohérent.
test("polices : CSS sans base64, fichiers /polices à empreinte en cache immuable, préchargements servis", async () => {
  for (const chemin of ["/", "/app"]) {
    const html = (await page(chemin)).texte;
    const texte = await cssPage(html);
    expect(texte).not.toContain("data:font");
    expect(texte).not.toContain("data:image");
    expect(texte.length).toBeLessThan(200_000);
    const urls = new Set([...texte.matchAll(/url\((\/polices\/[^)]+\.woff2)\)/g)].map((m) => m[1]!));
    expect(urls.size).toBeGreaterThan(10);
    expect(texte).toContain("font-display:swap");
    expect(texte).toContain("unicode-range");
    const precharges = [...html.matchAll(/<link\s+rel="preload"\s+as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
    // L'accueil n'utilise plus la police d'icônes (SVG en ligne) ; l'application la garde (icônes dynamiques).
    expect(texte.includes("material-symbols-rounded")).toBe(chemin === "/app");
    expect(precharges.length).toBeGreaterThanOrEqual(1);
    expect(precharges.length).toBeLessThanOrEqual(2);
    for (const p of precharges) {
      expect(urls.has(p)).toBe(true);
      const f = await fetch(new URL(p, web.url));
      expect(f.status).toBe(200);
      expect(f.headers.get("content-type")).toBe("font/woff2");
      expect(f.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(new Uint8Array(await f.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("wOF2"));
    }
  }
  for (const refus of [
    "/polices/inter-latin-400-normal-0000000000.woff2",
    "/polices/roboto-latin-400-normal-8909904ab6.woff2",
    "/polices/..%2Fpackage.json",
  ])
    expect((await fetch(new URL(refus, web.url))).status).toBe(404);
  const accueil = (await page("/")).texte;
  expect(accueil).toContain("plus-jakarta-sans-latin-700-normal-");
}, 30_000);

test("héros : fond préchargé en AVIF (fetchpriority=high), variantes à empreinte en cache immuable", async () => {
  const html = (await page("/")).texte;
  const pre = /<link\s+rel="preload"\s+as="image"[^>]*>/.exec(html)?.[0] ?? "";
  expect(pre).toContain('fetchpriority="high"');
  expect(pre).toContain('type="image/avif"');
  expect(pre).toContain(`imagesrcset="${srcsetAvif("btp-plan")}"`);
  for (const i of Object.values(IMAGES))
    for (const [url] of [...i.avif, ...i.webp]) {
      const r = await fetch(new URL(url, web.url));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe(url.endsWith(".avif") ? "image/avif" : "image/webp");
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
  expect((await fetch(new URL("/img/v/btp-plan-768-0000000000.avif", web.url))).status).toBe(404);
  const og = await fetch(new URL("/img/og-auto.jpg", web.url));
  expect(og.status).toBe(200);
  expect(og.headers.get("content-type")).toBe("image/jpeg");
});

test("référencement : plan du site, robots.txt, security.txt, canonique et Open Graph des pages publiques", async () => {
  const plan = await fetch(new URL("/sitemap.xml", web.url));
  expect(plan.status).toBe(200);
  expect(plan.headers.get("content-type")).toContain("application/xml");
  const xml = await plan.text();
  for (const p of PAGES_PUBLIQUES) {
    expect(xml).toContain(`<loc>https://auto.aphrody.com${p}</loc>`);
    const html = (await page(p)).texte;
    expect(html).toContain(`<link rel="canonical" href="https://auto.aphrody.com${p}"`);
    expect(html).toContain(`<meta property="og:url" content="https://auto.aphrody.com${p}"`);
    expect(html).toContain('<meta property="og:image" content="https://auto.aphrody.com/img/og-auto.jpg"');
  }
  const robots = await (await fetch(new URL("/robots.txt", web.url))).text();
  expect(robots).toContain("Sitemap: https://auto.aphrody.com/sitemap.xml");
  const security = await fetch(new URL("/.well-known/security.txt", web.url));
  expect(security.status).toBe(200);
  const s = await security.text();
  expect(s).toContain("Contact: mailto:contact@aphrody.com");
  const expire = new Date(/^Expires: (.+)$/m.exec(s)![1]!);
  expect(expire.getTime()).toBeGreaterThan(Date.now());
  expect(expire.getTime()).toBeLessThan(Date.now() + 366 * 86_400_000);
});

test("pages HTML : CSP appliquée (default-src, scripts par empreinte), rapports, cadre interdit, politiques", async () => {
  for (const chemin of ["/", "/tarifs", "/app", "/app/factures", "/devis/abc"]) {
    const r = await fetch(new URL(chemin, web.url));
    expect(r.status).toBe(200);
    const html = await r.text();
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    const script = /script-src ([^;]+)/.exec(csp)![1]!;
    expect(script).toStartWith("'self'");
    expect(script).not.toContain("unsafe");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("report-to csp");
    const empreintes = empreintesScripts(html);
    expect(empreintes.length).toBeGreaterThan(0);
    for (const e of empreintes) expect(script).toContain(e);
    const observee = r.headers.get("content-security-policy-report-only") ?? "";
    expect(observee).toContain("form-action 'self'");
    expect(/style-src ([^;]+)/.exec(observee)![1]).not.toContain("unsafe");
    for (const e of empreintesStyles(html)) expect(observee).toContain(e);
    expect(r.headers.get("reporting-endpoints")).toBe('csp="/csp-rapport"');
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("permissions-policy")).toContain("camera=()");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    const etag = r.headers.get("etag")!;
    expect((await fetch(new URL(chemin, web.url), { headers: { "if-none-match": etag } })).status).toBe(304);
  }
});

test("rapports CSP : une ligne réduite par violation, sans données personnelles, débit limité", async () => {
  const lignes: string[] = [];
  const route = routeRapportCsp(2, (l) => lignes.push(l));
  const rapport = (n: number) =>
    new Request("http://x/csp-rapport", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify(
        Array.from({ length: n }, () => ({
          type: "csp-violation",
          url: "https://auto.aphrody.com/app/clients?email=jean@exemple.fr",
          body: {
            documentURL: "https://auto.aphrody.com/app/clients?email=jean@exemple.fr",
            blockedURL: "https://traceur.exemple/pixel?id=42",
            effectiveDirective: "img-src",
            disposition: "report",
          },
        })),
      ),
    });
  expect((await route.POST(rapport(3))).status).toBe(204);
  expect(lignes).toEqual([
    "csp violation directive=img-src bloque=https://traceur.exemple document=/app/clients mode=report",
    "csp violation directive=img-src bloque=https://traceur.exemple document=/app/clients mode=report",
  ]);
  expect(lignes.join()).not.toContain("jean@");
  const legacy = await route.POST(
    new Request("http://x/csp-rapport", { method: "POST", body: '{"csp-report":{"blocked-uri":"inline"}}' }),
  );
  expect(legacy.status).toBe(204);
  expect(lignes.length).toBe(2);
  expect((await route.POST(new Request("http://x", { method: "POST", body: "pas du json" }))).status).toBe(400);
  const r = await fetch(new URL("/csp-rapport", web.url), {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: '{"csp-report":{"violated-directive":"style-src","blocked-uri":"inline","document-uri":"https://auto.aphrody.com/"}}',
  });
  expect(r.status).toBe(204);
});

test("captures de la vitrine : /img/*.webp servi en image, autres chemins refusés", async () => {
  const noms = [...new Bun.Glob("*.webp").scanSync({ cwd: fileURLToPath(new URL("../public/img", import.meta.url)) })];
  expect(noms.length).toBeGreaterThanOrEqual(10);
  const r = await fetch(new URL(`/img/${noms[0]}`, web.url));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/webp");
  expect((await fetch(new URL("/img/absente.webp", web.url))).status).toBe(404);
  expect((await fetch(new URL("/img/x.png", web.url))).status).toBe(404);
  const s = await fetch(new URL("/icones/symboles.svg", web.url));
  expect(s.status).toBe(200);
  expect(s.headers.get("content-type")).toBe("image/svg+xml");
});

test("page tarifs alignée sur les plans de @auto/billing", async () => {
  const p = (await page("/tarifs")).texte;
  for (const plan of Object.values(PLANS)) {
    expect(p).toContain(`data-plan="${plan.id}"`);
    expect(p).toContain(`data-prix="${plan.prixHtCents.mensuel / 100}"`);
    if (plan.prixHtCents.annuel) expect(p).toContain(`${plan.prixHtCents.annuel / 100} € HT par an`);
  }
  expect(p).toContain(`${PLANS.pro.essaiJours} jours d'essai`);
});

test("application : toutes les routes /app servent la coque HTML (liens profonds)", async () => {
  for (const c of ["/app", "/app/factures", "/app/documents/123", "/app/inscription"]) {
    const p = await page(c);
    expect(p.status).toBe(200);
    expect(p.texte).toContain('id="racine"');
  }
  expect((await page("/inconnue")).status).toBe(404);
});

test("proxy /v1 : même origine, méthode, corps, cookie et Content-Type transmis, en-têtes de saut retirés", async () => {
  const r = await fetch(new URL("/v1/documents?type=devis", web.url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "auto_session=xyz" },
    body: JSON.stringify({ a: 1 }),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("set-cookie")).toContain("auto_session=abc");
  const q = recues.at(-1)!;
  expect(q).toMatchObject({ chemin: "/v1/documents?type=devis", methode: "POST", corps: '{"a":1}' });
  expect(q.entetes.get("cookie")).toBe("auto_session=xyz");
  expect(q.entetes.get("content-type")).toBe("application/json");
  expect(q.entetes.get("host")).toBe(new URL(api.url).host);

  const moi = await fetch(new URL("/v1/moi", web.url));
  expect(moi.status).toBe(401);
});

test("proxy : API injoignable → 502 JSON", async () => {
  const w = demarrerWeb({ api: "http://127.0.0.1:9" });
  try {
    const r = await fetch(new URL("/v1/moi", w.url));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ erreur: "API injoignable" });
  } finally {
    await w.stop(true);
  }
});

test("vidéo hébergée dans le cloud : redirection HTTPS et refus d'une URL invalide", async () => {
  const ancienne = Bun.env.AUTO_MEDIA_URL;
  try {
    Bun.env.AUTO_MEDIA_URL = "https://storage.example/media/lancement-btp.mp4";
    const r = await fetch(new URL("/media/lancement-btp.mp4", web.url), { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(Bun.env.AUTO_MEDIA_URL);
    Bun.env.AUTO_MEDIA_URL = "http://storage.example/video.mp4";
    expect((await fetch(new URL("/media/lancement-btp.mp4", web.url), { redirect: "manual" })).status).toBe(503);
  } finally {
    if (ancienne === undefined) delete Bun.env.AUTO_MEDIA_URL;
    else Bun.env.AUTO_MEDIA_URL = ancienne;
  }
});

test("application installable : manifeste, icônes et couleur de thème alignée sur les jetons", async () => {
  const m = await fetch(new URL("/manifest.webmanifest", web.url));
  expect(m.headers.get("content-type")).toContain("application/manifest+json");
  const manifeste = (await m.json()) as { start_url: string; display: string; icons: { src: string }[] };
  expect(manifeste).toMatchObject({ start_url: "/app", display: "standalone" });
  for (const { src } of [...manifeste.icons, { src: "/icones/180.png" }]) {
    const r = await fetch(new URL(src, web.url));
    expect(r.headers.get("content-type")).toBe("image/png");
    const v = new DataView(await r.arrayBuffer());
    const taille = Number(/\/(\d+)\.png$/.exec(src)![1]);
    expect([v.getUint32(16), v.getUint32(20)]).toEqual([taille, taille]);
  }
  expect((await fetch(new URL("/icones/64.png", web.url))).status).toBe(404);
  expect((await fetch(new URL("/favicon.ico", web.url))).headers.get("content-type")).toBe("image/png");
  for (const page of ["/", "/app"]) {
    const html = await (await fetch(new URL(page, web.url))).text();
    expect(html).toContain('"/manifest.webmanifest"');
    expect(html).toContain(`<meta name="theme-color" content="${palettes.clair.primaire}"`);
  }
});

// Builds zero-JS public pages, SEO/AISEO manifests, precompiled i18n JSON, and slim /app SPA in `apps/ui/dist/web`.
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCatalog } from "@aphrody/auto-i18n";

const uiDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(uiDir, "../..");
const outDir = resolve(uiDir, "dist/web");
const ORIGIN = (Bun.env.AUTO_PUBLIC_URL ?? "https://auto.aphrody.com").replace(/\/+$/, "");

interface PaletteMap {
  [key: string]: string;
}

async function parsePaletteFromRust(): Promise<{ light: PaletteMap; dark: PaletteMap }> {
  const src = await Bun.file(join(repoRoot, "crates/auto-theme/src/lib.rs")).text();
  const extract = (blockName: string): PaletteMap => {
    const start = src.indexOf(`pub const ${blockName}:`);
    const end = src.indexOf("};", start);
    const body = src.slice(start, end);
    const map: PaletteMap = {};
    for (const match of body.matchAll(
      /(\w+):\s*RgbColor::new\(0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+)\)/g,
    )) {
      const hex = `#${match[2]!.padStart(2, "0")}${match[3]!.padStart(2, "0")}${match[4]!.padStart(2, "0")}`;
      map[match[1]!] = hex.toLowerCase();
    }
    return map;
  };
  return { light: extract("LIGHT_PALETTE"), dark: extract("DARK_PALETTE") };
}

function toCssVars(p: PaletteMap): string {
  return [
    `  --auto-bg: ${p.background};`,
    `  --auto-fg: ${p.foreground};`,
    `  --auto-card: ${p.card};`,
    `  --auto-popover: ${p.popover};`,
    `  --auto-primary: ${p.primary};`,
    `  --auto-primary-fg: ${p.primary_foreground};`,
    `  --auto-secondary: ${p.secondary};`,
    `  --auto-secondary-fg: ${p.secondary_foreground};`,
    `  --auto-muted: ${p.muted};`,
    `  --auto-muted-fg: ${p.muted_foreground};`,
    `  --auto-accent: ${p.accent};`,
    `  --auto-accent-fg: ${p.accent_foreground};`,
    `  --auto-destructive: ${p.destructive};`,
    `  --auto-border: ${p.border};`,
    `  --auto-input: ${p.input};`,
    `  --auto-ring: ${p.ring};`,
    `  --auto-sidebar: ${p.sidebar};`,
    `  --auto-up: ${p.up};`,
    `  --auto-warn: ${p.warn};`,
    `  --auto-info: ${p.info};`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shellHtml(opts: {
  title: string;
  description: string;
  activePath: string;
  mainHtml: string;
  scripts?: string;
}): string {
  const canonicalUrl = `${ORIGIN}${opts.activePath === "/" ? "" : opts.activePath}`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Auto",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Windows, Linux, macOS, Cloudflare Workers",
    url: canonicalUrl,
    description: opts.description,
    potentialAction: {
      "@type": "SearchAction",
      target: `${ORIGIN}/v1/search?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  });

  const navLinks = [
    ["/", "Overview"],
    ["/pricing", "Deployment & Pricing"],
    ["/downloads", "Binaries & SDK"],
    ["/app", "Open Workspace"],
  ]
    .map(
      ([href, label]) =>
        `<a class="nav-link${opts.activePath === href ? " is-active" : ""}" href="${href}"${opts.activePath === href ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />
  <meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:type" content="website" />
  <script type="application/ld+json">${jsonLd}</script>
  <link rel="stylesheet" href="/assets/tokens.css" />
  <link rel="stylesheet" href="/assets/site.css" />
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/">Auto</a>
      <nav aria-label="Primary">${navLinks}</nav>
    </div>
  </header>
  <main id="main" class="container">${opts.mainHtml}</main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <span>Auto — Factur-X EN 16931, Art. 286 CGI, FEC, Rust LTO & Cloudflare Workers</span>
      <div class="footer-links">
        <a href="/legal">Legal</a>
        <a href="/privacy">Privacy</a>
      </div>
    </div>
  </footer>
  ${opts.scripts ?? ""}
</body>
</html>`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "assets"), { recursive: true });
mkdirSync(join(outDir, "pricing"), { recursive: true });
mkdirSync(join(outDir, "downloads"), { recursive: true });
mkdirSync(join(outDir, "legal"), { recursive: true });
mkdirSync(join(outDir, "privacy"), { recursive: true });
mkdirSync(join(outDir, "app"), { recursive: true });

// Precompile French TSV dictionaries into a compact flat JSON fetched lazily only when FR is active
const frCommon = parseCatalog(await Bun.file(join(repoRoot, "locales/fr/common.tsv")).text());
const frAuto = parseCatalog(await Bun.file(join(repoRoot, "locales/fr/auto.tsv")).text());
const frMap: Record<string, string> = {};
for (const [k, v] of frCommon.exact.entries()) frMap[k.slice(k.indexOf("\u0000") + 1)] = v;
for (const [k, v] of frAuto.exact.entries()) frMap[k.slice(k.indexOf("\u0000") + 1)] = v;
await Bun.write(join(outDir, "assets/i18n-fr.json"), JSON.stringify(frMap));

const { light, dark } = await parsePaletteFromRust();

const tokensCss = `:root {
  color-scheme: light dark;
  --auto-radius-sm: 4px;
  --auto-radius-md: 8px;
  --auto-radius-lg: 12px;
${toCssVars(light)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${toCssVars(dark)}
  }
}

:root[data-theme="dark"] {
${toCssVars(dark)}
}
`;

const siteCss = `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--auto-bg); color: var(--auto-fg); font-family: "Inter", system-ui, -apple-system, sans-serif; line-height: 1.5; }
.skip-link { position: absolute; left: -9999px; }
.skip-link:focus { position: fixed; left: 16px; top: 16px; z-index: 100; padding: 8px 12px; background: var(--auto-primary); color: var(--auto-primary-fg); border-radius: var(--auto-radius-md); }
.container { width: min(1160px, 100% - 32px); margin-inline: auto; }
.site-header { border-bottom: 1px solid var(--auto-border); background: var(--auto-sidebar); position: sticky; top: 0; z-index: 20; }
.header-inner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; }
.brand { font-weight: 700; font-size: 1.125rem; color: var(--auto-fg); text-decoration: none; }
nav { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.nav-link { padding: 8px 12px; border-radius: var(--auto-radius-md); text-decoration: none; color: var(--auto-fg); font-size: 0.9375rem; }
.nav-link:hover { background: var(--auto-muted); }
.nav-link.is-active { background: var(--auto-primary); color: var(--auto-primary-fg); font-weight: 600; }
main { padding: 32px 0 48px; }
.hero { display: grid; gap: 20px; padding: 32px; background: var(--auto-card); border: 1px solid var(--auto-border); border-radius: var(--auto-radius-lg); }
.hero h1 { margin: 0; font-size: clamp(1.75rem, 3vw, 2.5rem); line-height: 1.15; }
.hero p { margin: 0; max-width: 68ch; color: var(--auto-muted-fg); }
.hero-actions, .toolbar, .row-actions, .header-controls, .workspace-tabs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.workspace-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
.toolbar-between { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 20px; }
.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 20px; }
.card { background: var(--auto-card); border: 1px solid var(--auto-border); border-radius: var(--auto-radius-lg); padding: 20px; }
.stack { display: grid; gap: 16px; }
.stack-sm { display: grid; gap: 8px; }
.field { display: grid; gap: 6px; font-size: 0.875rem; }
input, select { padding: 8px 12px; border-radius: var(--auto-radius-md); border: 1px solid var(--auto-input); background: var(--auto-bg); color: var(--auto-fg); font: inherit; min-height: 38px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border-radius: var(--auto-radius-md); border: 1px solid var(--auto-border); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; min-height: 38px; transition: background-color 120ms ease; }
.btn.primary { background: var(--auto-primary); color: var(--auto-primary-fg); border-color: var(--auto-primary); }
.btn.outline { background: var(--auto-card); color: var(--auto-fg); }
.btn.outline:hover { background: var(--auto-muted); }
:focus-visible { outline: 2px solid var(--auto-ring); outline-offset: 2px; }
.badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; background: var(--auto-secondary); color: var(--auto-secondary-fg); }
.badge[data-state="connected"], .badge-paid { background: var(--auto-accent); color: var(--auto-accent-fg); }
.table-wrap { overflow-x: auto; padding: 0; }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--auto-border); }
th.num, td.num { text-align: right; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.muted { color: var(--auto-muted-fg); font-size: 0.875rem; }
.code-box { margin: 0; padding: 16px; background: var(--auto-muted); border-radius: var(--auto-radius-md); overflow-x: auto; font-size: 0.8125rem; }
.alert { padding: 12px 16px; border-radius: var(--auto-radius-md); border: 1px solid var(--auto-border); }
.alert-error { border-color: var(--auto-destructive); color: var(--auto-destructive); }
dialog { border: 1px solid var(--auto-border); border-radius: var(--auto-radius-lg); background: var(--auto-card); color: var(--auto-fg); padding: 20px; max-width: 420px; width: 92vw; }
dialog::backdrop { backdrop-filter: blur(2px); }
.site-footer { border-top: 1px solid var(--auto-border); padding: 20px 0; color: var(--auto-muted-fg); font-size: 0.875rem; }
.footer-inner { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
.footer-links { display: flex; gap: 16px; }
.footer-links a { color: inherit; }
@media (pointer: coarse) { .btn, input, .nav-link { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
`;

await Bun.write(join(outDir, "assets/tokens.css"), tokensCss);
await Bun.write(join(outDir, "assets/site.css"), siteCss);
await Bun.write(
  join(outDir, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /v1/\nSitemap: ${ORIGIN}/sitemap.xml\n`,
);
const today = new Date().toISOString().slice(0, 10);
await Bun.write(
  join(outDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    "/",
    "/pricing",
    "/downloads",
    "/app",
    "/legal",
    "/privacy",
  ]
    .map((p) => `  <url><loc>${ORIGIN}${p === "/" ? "" : p}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`,
);
await Bun.write(
  join(outDir, "llms.txt"),
  `# Auto\n\n> Factur-X EN 16931 e-invoicing, Art. 286 CGI immutable accounting ledger, FEC exports, DAG workflows, and Rust Better Auth in a single LTO binary and Cloudflare Worker.\n\n## Canonical Routes\n- [Overview](${ORIGIN}/)\n- [Deployment & Pricing](${ORIGIN}/pricing)\n- [Binaries & SDKs](${ORIGIN}/downloads)\n- [Workspace](${ORIGIN}/app)\n- [OpenAPI & Docs](${ORIGIN}/health)\n`,
);
await Bun.write(
  join(outDir, "_headers"),
  `/*\n  Strict-Transport-Security: max-age=31536000; includeSubDomains\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`,
);

await Bun.write(
  join(outDir, "index.html"),
  shellHtml({
    title: "Auto — Invoicing, Ledger, E-Invoicing & Cluster",
    description: "Dual-mode business operations engine for Cloudflare Workers and Self-Hosted LTO binaries.",
    activePath: "/",
    mainHtml: `
<section class="hero">
  <h1>Business accounting, Factur-X invoicing, and automations in one LTO binary.</h1>
  <p>Run Auto as a stateless Cloudflare Worker backed by D1, CompanyDO SQLite Durable Objects, and R2, or deploy the standalone LTO binary with built-in Rust Better Auth, Ed25519 JWKS, and HTTP failover load balancing across your VPS fleet.</p>
  <div class="hero-actions">
    <a class="btn primary" href="/app">Open Workspace</a>
    <a class="btn outline" href="/downloads">Download LTO Binary & SDKs</a>
    <a class="btn outline" href="/pricing">Compare Deployment Modes</a>
  </div>
</section>
<section class="grid-3">
  <article class="card stack-sm">
    <h2>Compliant Documents</h2>
    <p class="muted">Sequential gapless numbering, SHA-256 hash-chained audit log, Factur-X EN 16931 PDF/A-3b XML, and 18-column FEC export.</p>
  </article>
  <article class="card stack-sm">
    <h2>Rust Better Auth</h2>
    <p class="muted">Argon2id password hashing, ChaCha20-Poly1305 vault sealing, Ed25519 JWT/JWKS, RFC 6238 TOTP, passkeys, and RBAC across Rust and Wasm.</p>
  </article>
  <article class="card stack-sm">
    <h2>Real-Time Sync & LB</h2>
    <p class="muted">Hybrid Logical Clock delta synchronization over hibernatable WebSockets with automatic L7 health-checked upstream failover.</p>
  </article>
</section>`,
  }),
);

await Bun.write(
  join(outDir, "pricing/index.html"),
  shellHtml({
    title: "Auto — Deployment & Pricing",
    description: "Serverless Cloudflare Workers mode versus Self-Hosted single LTO binary fleet comparison.",
    activePath: "/pricing",
    mainHtml: `
<section class="grid-2">
  <article class="card stack">
    <h1>Cloudflare Serverless Mode</h1>
    <p class="muted">Zero idle compute. D1 for global authentication, isolated per-company SQLite Durable Objects, Durable Workflows, and R2 archival storage.</p>
    <ul>
      <li>Automatic global edge routing</li>
      <li>Hibernatable WebSocket HLC sync</li>
      <li>11-year R2 archive lifecycle rule</li>
    </ul>
  </article>
  <article class="card stack">
    <h1>Self-Hosted Single LTO Binary</h1>
    <p class="muted">Apache-2.0 standalone deployment via auto-server AOT or unified Rust LTO binary with built-in L7 load balancer and Ed25519 self-updates.</p>
    <ul>
      <li>Multi-VPS failover via Pingora & auto lb</li>
      <li>Library & SDK mode for Rust, C FFI, TS, MCP</li>
      <li>Bi-directional edge-to-cloud replication</li>
    </ul>
  </article>
</section>`,
  }),
);

await Bun.write(
  join(outDir, "downloads/index.html"),
  shellHtml({
    title: "Auto — Binaries, Crates & SDKs",
    description: "Single LTO/AOT executables, C header, Wasm bridge, Cargo crates, and Bun SDK packages.",
    activePath: "/downloads",
    mainHtml: `
<section class="card stack">
  <h1>Single Binaries & Developer Libraries</h1>
  <p class="muted">Consume Auto as a standalone server binary or embed any layer as a typed crate, npm workspace package, C ABI shared library, or MCP server.</p>
  <pre class="code-box">cargo add aphrody-auto auto-auth auto-facturx auto-model auto-client
bun add @aphrody/auto @aphrody/auto-client @aphrody/auto-native
auto serve --mode self-hosted --port 3000
auto lb --listen 127.0.0.1:8080 --upstreams https://auto.aphrody.com</pre>
  <p><a class="btn outline" href="/releases/manifest.json">Inspect Signed Release Manifest</a></p>
</section>`,
  }),
);

await Bun.write(
  join(outDir, "legal/index.html"),
  shellHtml({
    title: "Auto — Regulatory Compliance",
    description: "French and European invoicing compliance: Factur-X EN 16931, Art. 286 CGI, and DGFiP FEC.",
    activePath: "/legal",
    mainHtml: `
<section class="card stack">
  <h1>Regulatory Compliance</h1>
  <p>Auto enforces gapless sequential numbering per fiscal year, immutable issued invoice triggers, Article 286 CGI hash-chained audit logs, Factur-X EN 16931 PDF/A-3b attachments, and DGFiP Article A47 A-1 FEC TSV exports.</p>
</section>`,
  }),
);

await Bun.write(
  join(outDir, "privacy/index.html"),
  shellHtml({
    title: "Auto — Privacy & Security",
    description: "Per-company SQLite isolation, ChaCha20-Poly1305 encryption, and Argon2id credentials.",
    activePath: "/privacy",
    mainHtml: `
<section class="card stack">
  <h1>Privacy & Data Isolation</h1>
  <p>Tenant business ledgers reside inside isolated per-company SQLite storage. Sensitive secrets are sealed with ChaCha20-Poly1305 and Argon2id credentials remain inside your Cloudflare account or self-hosted hosts.</p>
</section>`,
  }),
);

await Bun.write(
  join(outDir, "app/index.html"),
  shellHtml({
    title: "Auto Workspace",
    description: "Interactive Auto accounting, e-invoicing, automations, and cluster workspace application.",
    activePath: "/app",
    mainHtml: `
<div id="app-root"></div>
<dialog id="cmd-dialog" aria-label="Command palette">
  <div class="stack">
    <strong>Quick navigation</strong>
    <button class="btn outline" type="button" data-cmd-tab="documents">Documents</button>
    <button class="btn outline" type="button" data-cmd-tab="customers">Customers</button>
    <button class="btn outline" type="button" data-cmd-tab="accounting">Accounting & FEC</button>
    <button class="btn outline" type="button" data-cmd-tab="automations">Automations</button>
    <button class="btn outline" type="button" data-cmd-tab="cluster">Cluster & Auth</button>
  </div>
</dialog>`,
    scripts: '<script type="module" src="/app/app.js"></script>',
  }),
);

const bundled = await Bun.build({
  entrypoints: [join(uiDir, "src/web/app.ts")],
  outdir: join(outDir, "app"),
  target: "browser",
  minify: true,
  naming: "app.js",
});

if (!bundled.success) {
  for (const log of bundled.logs) console.error(log);
  process.exit(1);
}

console.log(`Built apps/ui/dist/web (${bundled.outputs.length} bundle, 6 routes)`);

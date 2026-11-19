// Builds Chrome Extension MV3 bundle cleanly using Bun.build.
const root = new URL("..", import.meta.url);
const DIST = new URL("dist/", root);
const toPath = (u: URL) => Bun.fileURLToPath(u);

export async function buildExtension(opts: { dist?: URL; hosts?: string[] } = {}): Promise<string[]> {
  const dist = opts.dist ?? DIST;
  await Bun.$`rm -rf ${toPath(dist)}`.quiet();
  const res = await Bun.build({
    entrypoints: ["service-worker.ts", "popup.ts"].map((f) => toPath(new URL(`src/${f}`, root))),
    outdir: toPath(dist),
    target: "browser",
    format: "esm",
    naming: "[name].[ext]",
    minify: true,
  });
  if (!res.success) throw new AggregateError(res.logs, "Extension build failed");
  for (const f of ["popup.html", "popup.css"]) {
    await Bun.write(new URL(f, dist), Bun.file(new URL(`static/${f}`, root)));
  }
  const manifest = (await Bun.file(new URL("static/manifest.json", root)).json()) as {
    version: string;
    host_permissions: string[];
  };
  if (opts.hosts?.length) manifest.host_permissions = [...manifest.host_permissions, ...opts.hosts];
  await Bun.write(new URL("manifest.json", dist), `${JSON.stringify(manifest, null, 2)}\n`);
  return [...new Bun.Glob("**/*").scanSync({ cwd: toPath(dist) })].sort();
}

if (import.meta.main) {
  const files = await buildExtension();
  console.log(`extension dist: ${files.join(", ")}`);
  if (Bun.argv.includes("--zip")) {
    const { version } = (await Bun.file(new URL("static/manifest.json", root)).json()) as { version: string };
    const entries = Object.fromEntries(
      await Promise.all(files.map(async (f) => [f, await Bun.file(new URL(f, DIST)).bytes()] as const)),
    );
    const zipPath = toPath(new URL(`auto-extension-${version}.zip`, DIST));
    await Bun.Archive.write(zipPath, entries, { format: "zip", mtime: 0 });
    console.log(`extension zip: ${zipPath}`);
  }
}

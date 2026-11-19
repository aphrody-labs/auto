// Builds standalone Bun single-file AOT executable (`dist/aot/auto-server`).
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = Bun.fileURLToPath(new URL("../", import.meta.url));
const outDir = join(root, "dist", "aot");
mkdirSync(outDir, { recursive: true });
const exeName = process.platform === "win32" ? "auto-server.exe" : "auto-server";
const outPath = join(outDir, exeName);

const EMBEDDED_ASSETS = [
  "--asset",
  "packages/native/wasm/auto_ffi_bg.wasm",
  "--asset",
  "packages/store/migrations/001_global.sql",
  "--asset",
  "packages/store/migrations/002_company.sql",
];

function runCompile(flags: string[]): number {
  const proc = Bun.spawnSync(
    ["bun", "build", "--compile", ...EMBEDDED_ASSETS, ...flags, "apps/server/src/bin.ts", "--outfile", outPath],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return proc.exitCode ?? 1;
}

let code = runCompile(["--aot", "--trim", "--minify"]);
if (code !== 0) {
  console.warn("--aot reported non-AOT construct; falling back to --bytecode --trim --minify");
  code = runCompile(["--bytecode", "--trim", "--minify"]);
}
if (code !== 0) process.exit(code);

const size = (await Bun.file(outPath).stat()).size;
console.log(`Built ${outPath} (${(size / 1024 / 1024).toFixed(2)} MiB)`);

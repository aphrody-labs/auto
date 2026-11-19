import { join } from "node:path";

const root = Bun.fileURLToPath(new URL("../", import.meta.url));
const outDir = join(root, "packages", "native", "wasm");

const env = {
  ...Bun.env,
  RUSTC_WRAPPER: "",
  RUSTUP_TOOLCHAIN: "nightly",
  CARGO_TERM_COLOR: "never",
  ...(process.platform === "win32"
    ? { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: "-C target-cpu=native -Zthreads=8 -Zshare-generics=off" }
    : {}),
};

function runOrExit(cmd: string[], cwd = root): void {
  const res = Bun.spawnSync(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (res.exitCode !== 0) process.exit(res.exitCode ?? 1);
}

function cargoTargetDir(): string {
  const meta = Bun.spawnSync(["cargo", "metadata", "--no-deps", "--format-version", "1"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (meta.exitCode !== 0) process.exit(meta.exitCode ?? 1);
  const parsed = JSON.parse(meta.stdout.toString()) as { target_directory: string };
  return parsed.target_directory;
}

runOrExit(["cargo", "build", "-p", "auto-ffi", "--target", "wasm32-unknown-unknown", "--profile", "wasm-lto"]);

const rawWasm = join(cargoTargetDir(), "wasm32-unknown-unknown", "wasm-lto", "auto_ffi.wasm");

runOrExit(["wasm-bindgen", "--target", "web", "--out-dir", outDir, rawWasm]);
runOrExit(["bun", "fmt", outDir]);

const bgWasm = join(outDir, "auto_ffi_bg.wasm");
if (Bun.which("wasm-opt")) {
  runOrExit([
    "wasm-opt",
    "-Oz",
    "--enable-bulk-memory-opt",
    "--enable-nontrapping-float-to-int",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    bgWasm,
    "-o",
    bgWasm,
  ]);
}

const rawBytes = await Bun.file(bgWasm).bytes();
const gzBytes = Bun.gzipSync(rawBytes);
console.log(
  `auto_ffi_bg.wasm: ${(rawBytes.length / 1024 / 1024).toFixed(2)} MiB raw, ${(gzBytes.length / 1024 / 1024).toFixed(2)} MiB gzip`,
);

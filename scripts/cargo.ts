const env = {
  ...Bun.env,
  RUSTC_WRAPPER: "",
  RUSTUP_TOOLCHAIN: "nightly",
  CARGO_TERM_COLOR: "never",
  ...(process.platform === "win32"
    ? { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: "-C target-cpu=native -Zthreads=8 -Zshare-generics=off" }
    : {}),
};

const proc = Bun.spawn(["cargo", ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env,
});

process.exitCode = await proc.exited;
export {};

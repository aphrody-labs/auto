// Même environnement Rust sous Windows et Linux ; aucun shell système nécessaire.
import { $ } from "bun";
import { racineDocker } from "./docker-racine";

const racine = Bun.fileURLToPath(new URL("../", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/\/$/, "");
const dockerfile = `${racine}/docker/rust.Dockerfile`;
const empreinte = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(dockerfile).bytes())
  .digest("hex")
  .slice(0, 12);
const image = `auto-rust:${empreinte}`;
if ((await $`docker image inspect ${image}`.quiet().nothrow()).exitCode !== 0) {
  await $`docker build -q -t ${image} -f ${dockerfile} ${`${racine}/docker`}`;
}
const processus = Bun.spawn(
  [
    "docker",
    "run",
    "--rm",
    "-v",
    `${await racineDocker(racine)}:/w`,
    "-w",
    "/w",
    "-v",
    "auto-cargo-registry:/usr/local/cargo/registry",
    "-v",
    "auto-cargo-git:/usr/local/cargo/git",
    "-v",
    "auto-cargo-target:/target",
    "-e",
    "CARGO_TARGET_DIR=/target",
    "-e",
    "CARGO_TERM_COLOR=never",
    image,
    "cargo",
    ...Bun.argv.slice(2),
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...Bun.env, MSYS_NO_PATHCONV: "1" } },
);
process.exitCode = await processus.exited;

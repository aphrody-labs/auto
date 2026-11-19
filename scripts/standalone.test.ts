import { expect, test } from "bun:test";
import { resolve } from "node:path";

const binary = Bun.env.AUTO_STANDALONE;
(binary ? test : test.skip)("compiled AOT server starts, answers /health, and accepts signups", async () => {
  const exe = resolve(binary!);
  const help = Bun.spawnSync([exe, "--help"]);
  expect(help.exitCode).toBe(0);

  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);

  const srv = Bun.spawn([exe, "--host", "127.0.0.1", "--port", String(port), "--db", ":memory:"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (r?.ok) {
        ok = true;
        break;
      }
      await Bun.sleep(100);
    }
    expect(ok).toBe(true);
  } finally {
    srv.kill();
    await srv.exited;
  }
});

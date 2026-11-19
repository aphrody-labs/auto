import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension } from "../scripts/build";

test("builds MV3 extension bundle cleanly", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "auto-ext-"));
  try {
    const files = await buildExtension({ dist: Bun.pathToFileURL(`${tmp}/`), hosts: ["http://127.0.0.1/*"] });
    expect(files).toContain("manifest.json");
    expect(files).toContain("service-worker.js");
    expect(files).toContain("popup.js");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

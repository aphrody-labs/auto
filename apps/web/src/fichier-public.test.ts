import { test, expect } from "bun:test";
import { fichierPublic } from "./fichier-public";

test("vidéo et téléchargements : HEAD, plages, suffixes, reprise et refus des plages multiples", async () => {
  const path = `${Bun.env.TEMP ?? "/tmp"}/auto-range-${crypto.randomUUID()}`;
  await Bun.write(path, "0123456789");
  try {
    const lire = (headers = {}, method = "GET") =>
      fichierPublic(new Request("https://auto.test/media", { method, headers }), path, {
        type: "video/mp4",
        empreinte: "abc",
      });
    const head = await lire({}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    const extrait = await lire({ range: "bytes=2-5" });
    expect(extrait.status).toBe(206);
    expect(extrait.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await extrait.text()).toBe("2345");
    expect(await (await lire({ range: "bytes=-3" })).text()).toBe("789");
    expect((await lire({ range: "bytes=10-" })).status).toBe(416);
    expect((await lire({ range: "bytes=0-1,4-5" })).status).toBe(416);
    expect((await lire({ "if-none-match": '"abc"' })).status).toBe(304);
    expect(await (await lire({ range: "bytes=2-5", "if-range": '"ancien"' })).text()).toBe("0123456789");
  } finally {
    await Bun.file(path).delete();
  }
});

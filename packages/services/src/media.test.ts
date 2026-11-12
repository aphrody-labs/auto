import { afterAll, expect, test } from "bun:test";
import { executer, valider, type Services } from "@auto/automate";
import { gardeUrl } from "./automatisations";
import { servicesMedia } from "./media";

const media = servicesMedia((u) => gardeUrl(u, false));
const capture = await Bun.file(new URL("../../../apps/web/public/img/hero-tableau.webp", import.meta.url)).bytes();
const VIDEO = new URL(
  "../../../docs/modeles/automatisation-factures/video/video_automatisation_factures.mp4",
  import.meta.url,
);

const page = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      `<!doctype html><title>Avant</title><body><p id="p">statique</p><script>document.title = "Rendu";document.getElementById("p").textContent = "écrit par JavaScript"</script></body>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
});
afterAll(() => page.stop(true));

const essai = (noeud: object, services: Partial<Services>) =>
  executer(
    valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        { id: "n", nom: "n", ...noeud },
      ],
      connexions: [{ de: "t", vers: "n" }],
    }),
    [{ json: {} }],
    { services: { fetch, ...services }, workflow: { id: "w", nom: "W" }, executionId: "e" },
  );

test("Bun.Image : redimensionner et convertir", async () => {
  const r = await essai(
    {
      type: "media.image",
      parametres: {
        fichier: { nom: "capture.webp", type: "image/webp", base64: capture.toBase64() },
        largeur: 320,
        format: "jpeg",
        niveauxDeGris: true,
      },
    },
    media,
  );
  expect(r.statut).toBe("succes");
  const j = r.sortie[0]!.json as { fichier: { nom: string; type: string; base64: string }; largeur: number };
  expect(j.fichier).toMatchObject({ nom: "capture.jpg", type: "image/jpeg" });
  expect(j.largeur).toBe(320);
  const m = await new Bun.Image(Uint8Array.fromBase64(j.fichier.base64)).metadata();
  expect(m).toMatchObject({ width: 320, format: "jpeg" });
});

test.skipIf(!Bun.Video.available || !(await Bun.file(VIDEO).exists()))(
  "Bun.Video : métadonnées, image extraite et GIF",
  async () => {
    const octets = await Bun.file(VIDEO).bytes();
    const meta = await media.video!.metadonnees(octets);
    expect(meta).toMatchObject({ largeur: 1920, hauteur: 1080, audio: true });
    const jpg = await media.video!.image(octets, 30, 320);
    expect(await new Bun.Image(jpg).metadata()).toMatchObject({ width: 320, format: "jpeg" });
    const gif = await media.video!.gif(octets, 10, 1, 160);
    expect(new TextDecoder().decode(gif.subarray(0, 3))).toBe("GIF");
  },
  60_000,
);

test("Bun.WebView : page rendue avec son JavaScript, texte et capture", async () => {
  const r = await media.navigateur!(page.url.href, {
    largeur: 800,
    hauteur: 600,
    attendreMs: 200,
    texte: true,
    capture: true,
  });
  expect(r.titre).toBe("Rendu");
  expect(r.texte).toContain("écrit par JavaScript");
  expect(await new Bun.Image(r.capture!).metadata()).toMatchObject({ format: "png" });
}, 60_000);

test("ia.ocr : image réduite par Bun.Image puis envoyée au modèle de vision (API compatible OpenAI)", async () => {
  let recu: { model: string; messages: { content: { type: string; image_url?: { url: string } }[] }[] } | null = null;
  const vision = Bun.serve({
    port: 0,
    fetch: async (req) => {
      recu = await req.json();
      return Response.json({ choices: [{ message: { content: '{"total": "120,00 €"}' } }] });
    },
  });
  try {
    const r = await essai(
      {
        type: "ia.ocr",
        parametres: {
          fichier: { nom: "ticket.webp", type: "image/webp", base64: capture.toBase64() },
          api: `${vision.url.origin}/v1`,
          modele: "qwen2.5vl",
          json: true,
          largeurMax: 512,
        },
      },
      media,
    );
    expect(r.statut).toBe("succes");
    expect(r.sortie[0]!.json).toMatchObject({ source: "ticket.webp", texte: { total: "120,00 €" } });
    const url = recu!.messages[0]!.content.find((c) => c.type === "image_url")!.image_url!.url;
    expect(url).toStartWith("data:image/jpeg;base64,");
    const envoyee = await new Bun.Image(Uint8Array.fromBase64(url.split(",")[1]!)).metadata();
    expect(envoyee.width).toBeLessThanOrEqual(512);
  } finally {
    await vision.stop(true);
  }
});

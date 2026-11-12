// Chaîne reproductible du monorepo : composition déterministe, capture Bun Video, encodage NVENC.
import { chromium } from "../apps/web/node_modules/playwright-core";
import { lancement, type Scene } from "../packages/video/src/scenario";
import { genererCatalogue } from "../packages/video/src/catalogue";
import { validerTimeline } from "../packages/video/src/timeline";

const root = process.cwd().replaceAll("\\", "/");
const out = `${root}/dist/lancement-btp`;
const source = `${root}/packages/video/src`;
const fps = 24;
const width = 1920;
const height = 1080;
const frameWorkers = Number(Bun.env.AUTO_VIDEO_FRAME_WORKERS ?? 4);
if (!Number.isSafeInteger(frameWorkers) || frameWorkers < 1 || frameWorkers > 4)
  throw new Error("AUTO_VIDEO_FRAME_WORKERS doit être compris entre 1 et 4");
const command = process.argv[2] ?? "preparer";
const packageRoot = (
  Bun.env.BUN_VIDEO_PACKAGE_ROOT ??
  Bun.fileURLToPath(new URL("../../packages/bun-video/", Bun.pathToFileURL(process.execPath)))
)
  .replaceAll("\\", "/")
  .replace(/\/$/, "");
const cachedFfmpeg = [
  ...new Bun.Glob(".cache/video-outils/**/bin/ffmpeg.exe").scanSync({ cwd: root, onlyFiles: true }),
][0];
const ffmpeg = Bun.env.AUTO_VIDEO_FFMPEG ?? (cachedFfmpeg ? `${root}/${cachedFfmpeg}` : Bun.which("ffmpeg"));
if (!ffmpeg) throw new Error("Définir AUTO_VIDEO_FFMPEG vers un FFmpeg avec h264_nvenc.");
const ffprobe = Bun.env.AUTO_VIDEO_FFPROBE ?? ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const chromeRoot = `${Bun.env.LOCALAPPDATA}/ms-playwright`;
const browser =
  Bun.env.AUTO_CHROME ??
  [...new Bun.Glob("chromium-*/chrome-win64/chrome.exe").scanSync({ cwd: chromeRoot, onlyFiles: true })].map(
    (p) => `${chromeRoot}/${p}`,
  )[0];
if (!browser) throw new Error("AUTO_CHROME doit désigner Chromium.");

async function run(args: string[], options: Record<string, unknown> = {}) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", ...options });
  const [stdout, stderr, code] = await Promise.all([p.stdout.text(), p.stderr.text(), p.exited]);
  if (code !== 0) throw new Error(`${args[0]} a échoué (${code}): ${stderr.slice(-5000)}`);
  return { stdout, stderr };
}

async function inputHashes(scenes: Scene[], smoke: boolean) {
  const paths = ["composition.html", "composition.css", "composition.js"].map((p) => `${source}/${p}`);
  paths.push(
    `${out}/${smoke ? "timeline-brouillon" : "timeline"}.json`,
    `${out}/assets/inter.woff2`,
    `${out}/assets/jakarta.woff2`,
  );
  for (const scene of scenes) if (scene.image) paths.push(`${out}/captures/${scene.image}.png`);
  const hashes: Record<string, string> = {};
  for (const path of new Set(paths))
    hashes[path.replace(`${root}/`, "")] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path).bytes())
      .digest("hex");
  return hashes;
}

async function prepare() {
  await Bun.write(
    `${out}/assets/jakarta.woff2`,
    Bun.file(
      `${root}/apps/web/node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-700-normal.woff2`,
    ),
  );
  await Bun.write(
    `${out}/assets/inter.woff2`,
    Bun.file(`${root}/apps/web/node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2`),
  );
  await Bun.write(`${out}/scenario.json`, JSON.stringify(lancement, null, 2));
  // La timeline de voix est conservée lorsqu'elle existe. Le brouillon sert aux previews avant narration.
  if (!(await Bun.file(`${out}/timeline.json`).exists())) {
    let time = 0;
    const timeline = lancement.map((s) => {
      const duration = Math.ceil((s.speech.split(/\s+/).length / 2.45 + 1) * fps) / fps;
      const item = { ...s, start: time, duration };
      time += duration;
      return item;
    });
    await Bun.write(`${out}/timeline-brouillon.json`, JSON.stringify(timeline, null, 2));
  }
  console.log("Scénario et ressources préparés", out);
  if (await Bun.file(`${out}/captures/provenance.json`).exists()) await genererCatalogue(out, lancement);
}

async function timeline(): Promise<Scene[]> {
  const f = (await Bun.file(`${out}/timeline.json`).exists())
    ? `${out}/timeline.json`
    : `${out}/timeline-brouillon.json`;
  return validerTimeline(lancement, await Bun.file(f).json(), fps);
}

function server(scenes: Scene[]) {
  const options = {
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      const p = new URL(req.url).pathname;
      if (p === "/timeline.json") return Response.json(scenes);
      if (p === "/") return new Response(Bun.file(`${source}/composition.html`));
      if (["/composition.css", "/composition.js"].includes(p)) return new Response(Bun.file(`${source}${p}`));
      if (/^\/(captures\/[a-z0-9-]+\.png|assets\/[a-z]+\.woff2)$/.test(p)) return new Response(Bun.file(`${out}${p}`));
      return new Response("Introuvable", { status: 404 });
    },
  };
  if (Bun.env.AUTO_VIDEO_PORT) return Bun.serve({ ...options, port: Number(Bun.env.AUTO_VIDEO_PORT) });
  // Même précaution que le banc E2E : éviter les ports bas parfois rendus par port:0 sur ce runtime Windows.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return Bun.serve({ ...options, port: 30000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 30000) });
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Aucun port de composition disponible");
}

async function render(previewsOnly = false, smoke = false) {
  await prepare();
  const scenes = smoke
    ? validerTimeline(lancement, await Bun.file(`${out}/timeline-brouillon.json`).json(), fps)
    : await timeline();
  for (const s of scenes)
    if (s.image && !(await Bun.file(`${out}/captures/${s.image}.png`).exists()))
      throw new Error(`Capture absente : ${s.image}`);
  const total = smoke ? 2 : scenes.at(-1)!.start! + scenes.at(-1)!.duration!;
  const frames = Math.round(total * fps);
  const inputs = await inputHashes(scenes, smoke);
  const provenance = (await Bun.file(`${out}/captures/provenance.json`).json()) as { file: string }[];
  for (const scene of scenes)
    if (scene.image && !provenance.some((p) => p.file === `${scene.image}.png`))
      throw new Error(`Provenance absente : ${scene.image}`);
  const srv = server(scenes);
  const nav = await chromium.launch({
    executablePath: browser,
    headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--disable-gpu-sandbox"],
  });
  const context = await nav.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("composition", e.message));
  const started = Date.now();
  try {
    await page.goto(srv.url.toString());
    await page.waitForFunction(() => (window as any).__videoReady === true);
    let gpu = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "non exposé";
    });
    for (const [i, s] of scenes.entries()) {
      await page.evaluate((t) => (window as any).__hf.seek(t), s.start! + Math.min(3.5, s.duration! / 2));
      await page.screenshot({ path: `${out}/planches/${String(i + 1).padStart(2, "0")}-${s.id}.png` });
    }
    console.log("Planches vérifiées", scenes.length, "GPU", gpu, "durée", total);
    if (previewsOnly) return;
    if (!(await Bun.file(`${out}/timeline.json`).exists()))
      throw new Error("La timeline voix finale est requise pour le rendu.");
    const modulePath = `${packageRoot}/src/hyperframes-native.ts`;
    const { captureNativeWebViewFrames } = await import(Bun.pathToFileURL(modulePath).href);
    const target = `${out}/${smoke ? "essai" : "image"}.mp4`;
    const encoder = Bun.spawn(
      [
        ffmpeg!,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-c:v",
        "png",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p5",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "19",
        "-b:v",
        "8M",
        "-maxrate",
        "18M",
        "-bufsize",
        "24M",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        target,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const diagnostics = encoder.stderr.text();
    const encoderStdout = encoder.stdout.text();
    // Chaque contexte garde un seul PNG en vol ; la publication reste strictement ordonnée.
    const pages = [page, ...(await Promise.all(Array.from({ length: frameWorkers - 1 }, () => context.newPage())))];
    const sessions = await Promise.all(pages.map((p) => context.newCDPSession(p)));
    const nativeContexts: any[] = [];
    if ((Bun.env.AUTO_VIDEO_CAPTURE_PROVIDER ?? "native") === "native") {
      const { openChromiumFrameContext } = await import(Bun.pathToFileURL(`${packageRoot}/src/chromium-frame.ts`).href);
      for (let i = 0; i < frameWorkers; i++)
        nativeContexts.push(
          await openChromiumFrameContext({
            url: srv.url.toString(),
            width,
            height,
            executable: browser,
            signal: AbortSignal.timeout(30 * 60 * 1000),
          }),
        );
      gpu = await nativeContexts[0].context.evaluate(
        `(()=>{const gl=document.createElement('canvas').getContext('webgl2');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'non exposé';})()`,
      );
      console.log("GPU du fournisseur natif", gpu);
      if (/SwiftShader|llvmpipe|software/i.test(gpu))
        throw new Error(
          "Le fournisseur natif utilise un rendu logiciel ; utiliser AUTO_VIDEO_CAPTURE_PROVIDER=playwright",
        );
    }
    const captureStarted = Date.now();
    const streams = pages.map((p, index) =>
      captureNativeWebViewFrames(
        nativeContexts[index]?.context ?? {
          navigate: async (url: string) => {
            await p.goto(url);
          },
          evaluate: async (expression: string) => p.evaluate(expression),
          screenshot: async () => {
            const { data } = await sessions[index]!.send("Page.captureScreenshot", {
              format: "png",
              fromSurface: true,
              captureBeyondViewport: false,
              optimizeForSpeed: false,
            });
            return Uint8Array.fromBase64(data);
          },
        },
        {
          url: srv.url.toString(),
          fps: { num: fps, den: 1 },
          startFrame: index,
          endFrame: frames,
          frameStride: pages.length,
          timeoutMs: 30000,
        },
      ),
    );
    let count = 0;
    try {
      while (count < frames) {
        const batch = await Promise.all(streams.map((stream) => stream.next()));
        for (const item of batch) {
          if (item.done) continue;
          const frame = item.value;
          if (frame.frame !== count) throw new Error("Ordre des images de capture incorrect");
          if (encoder.exitCode !== null) throw new Error(`NVENC interrompu : ${await diagnostics}`);
          encoder.stdin.write(frame.png);
          await encoder.stdin.flush();
          count++;
          if (count % (fps * 5) === 0)
            console.log(
              `Rendu ${Math.round((count / frames) * 100)} % · ${count}/${frames} · ${((Date.now() - started) / 1000).toFixed(0)} s`,
            );
        }
      }
      await encoder.stdin.end();
      const code = await encoder.exited;
      const stderr = await diagnostics;
      await encoderStdout;
      if (code !== 0) throw new Error(`NVENC ${code} : ${stderr}`);
      const probe = JSON.parse(
        (await run([ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", target]))
          .stdout,
      );
      const video = probe.streams.find((s: any) => s.codec_type === "video");
      if (video?.width !== width || video?.height !== height || Number(video.nb_read_frames) !== frames)
        throw new Error("Le fichier encodé ne correspond pas au plan");
      if (!Bun.deepEquals(inputs, await inputHashes(scenes, smoke)))
        throw new Error("Les sources de la composition ont changé pendant le rendu ; relancer sur une entrée stable");
      await Bun.write(
        `${out}/${smoke ? "essai" : "rendu"}.json`,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            provider: "Bun Video captureNativeWebViewFrames",
            modulePath,
            moduleSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(modulePath).bytes()).digest("hex"),
            runtime: { version: Bun.version, revision: Bun.revision, videoAvailable: Bun.Video.available },
            encoder: "h264_nvenc",
            gpu,
            frameWorkers: pages.length,
            screenshotProvider: nativeContexts.length
              ? "Bun Video openChromiumFrameContext / bun:chromium"
              : "Chromium CDP PNG",
            captureElapsedSeconds: (Date.now() - captureStarted) / 1000,
            inputs,
            fps,
            width,
            height,
            frames,
            duration: total,
            elapsedSeconds: (Date.now() - started) / 1000,
            probe,
          },
          null,
          2,
        ),
      );
    } finally {
      await Promise.allSettled(streams.map((stream) => stream.return()));
      await Promise.allSettled(nativeContexts.map((ctx) => ctx.close()));
      if (encoder.exitCode === null) encoder.kill();
      await encoder.exited;
      await Promise.allSettled([diagnostics, encoderStdout]);
    }
  } finally {
    await nav.close();
    srv.stop(true);
  }
}

async function verify() {
  const target = `${out}/auto-btp-lancement-fr.mp4`;
  const data = JSON.parse(
    (await run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", target])).stdout,
  );
  const v = data.streams.find((s: any) => s.codec_type === "video");
  const a = data.streams.find((s: any) => s.codec_type === "audio");
  if (v?.width !== width || v?.height !== height || !a) throw new Error("Vidéo finale incomplète");
  await run([ffmpeg!, "-v", "error", "-i", target, "-f", "null", "-"]);
  const native = new Bun.Video(target);
  const nativeMetadata = await native.metadata();
  await native.frame(3.5).resize(1280).jpeg({ quality: 90 }).write(`${out}/affiche.jpg`);
  await Bun.write(
    `${out}/verification.json`,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        decode: "passed",
        nativeMetadata,
        sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(target).bytes()).digest("hex"),
        media: data,
      },
      null,
      2,
    ),
  );
  console.log("Vidéo finale décodée et vérifiée", target, data.format.duration);
}

if (command === "preparer") await prepare();
else if (command === "planches") await render(true);
else if (command === "rendre") await render();
else if (command === "essai") await render(false, true);
else if (command === "verifier") await verify();
else if (command === "servir") {
  await prepare();
  const srv = server(await timeline());
  console.log("Composition", srv.url.toString());
} else if (command === "doctor") {
  console.log(
    JSON.stringify(
      {
        runtime: Bun.version,
        revision: Bun.revision,
        nativeVideo: Bun.Video.available,
        packageRoot,
        browser,
        ffmpeg,
        ffprobe,
      },
      null,
      2,
    ),
  );
  console.log((await run([ffmpeg, "-version"])).stdout.split("\n")[0]);
  console.log(
    (
      await run([
        ffmpeg,
        "-hide_banner",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1920x1080:r=24",
        "-t",
        "1",
        "-c:v",
        "h264_nvenc",
        "-f",
        "null",
        "-",
      ])
    ).stderr.slice(-1000),
  );
} else throw new Error(`Commande vidéo inconnue : ${command}`);

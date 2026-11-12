// Voix française native Windows, pauses et sous-titres alignés sur le rendu à 24 images/s.
import { resolve } from "node:path";
import { lancement } from "../packages/video/src/scenario";
const dossier = resolve("dist/lancement-btp/audio"),
  fps = 24,
  frequence = 48000;
const remplacements: Record<string, string> = {
  pdf: "pé dé èf",
  siret: "sirète",
  siren: "sirène",
  ht: "hors taxes",
  ttc: "toutes taxes comprises",
  "auto point aphrody point com": "auto point afrodi point com",
};
function prononcer(texte: string) {
  let dit = "",
    debut = 0;
  const cartes: { a: number; b: number; x: number; y: number }[] = [];
  for (const m of texte.matchAll(/auto point aphrody point com|\bPDF\b|\bSIRET\b|\bSIREN\b|\bHT\b|\bTTC\b/gi)) {
    const a = m.index!,
      b = a + m[0].length,
      avant = texte.slice(debut, a);
    cartes.push({ a: debut, b: a, x: dit.length, y: dit.length + avant.length });
    dit += avant;
    const mot = remplacements[m[0].toLowerCase()]!;
    cartes.push({ a, b, x: dit.length, y: dit.length + mot.length });
    dit += mot;
    debut = b;
  }
  const reste = texte.slice(debut);
  cartes.push({ a: debut, b: texte.length, x: dit.length, y: dit.length + reste.length });
  dit += reste;
  return {
    dit,
    position(p: number) {
      const c = cartes.find((c) => p >= c.a && p <= c.b) ?? cartes.at(-1)!;
      return c.x + (c.b === c.a ? 0 : ((p - c.a) * (c.y - c.x)) / (c.b - c.a));
    },
  };
}
const textes = lancement.map((s) => ({ id: s.id, texte: prononcer(s.speech).dit }));
await Bun.write(resolve(dossier, "textes-fr.json"), JSON.stringify(textes, null, 2));
const referenceVoix = Bun.env.AUTO_VIDEO_VOICE_REFERENCE;
const preview = process.argv.includes("--preview");
const assembleOnly = process.argv.includes("--assemble-only");
const sceneIndex = process.argv.indexOf("--scene");
const sceneId = sceneIndex >= 0 ? process.argv[sceneIndex + 1] : undefined;
if (sceneIndex >= 0 && !sceneId) throw Error("La valeur de --scene est obligatoire");
if (referenceVoix && !assembleOnly) {
  const script = resolve("scripts/video-lancement-chatterbox.py");
  const p = Bun.spawn(
    [
      process.execPath,
      "uv",
      "run",
      "--python",
      resolve(".cache/voix-auto/Scripts/python.exe"),
      "--",
      script,
      "--textes",
      resolve(dossier, "textes-fr.json"),
      "--reference",
      resolve(referenceVoix),
      "--destination",
      dossier,
      ...(sceneId ? ["--scene", sceneId] : []),
      ...(preview ? ["--limit", "1"] : []),
    ],
    { stdout: "inherit", stderr: "inherit", windowsHide: true },
  );
  if (await p.exited) throw Error("La synthèse locale Chatterbox n'a pas abouti");
  if (preview) {
    console.log("Échantillon local généré :", resolve(dossier, lancement[0]!.id + "-voix.wav"));
    process.exit(0);
  }
} else if (!assembleOnly) {
  const executable = Bun.which("pwsh.exe") ?? Bun.which("powershell.exe");
  if (!executable) throw Error("PowerShell Windows requis");
  let p = Bun.spawn(
    [
      executable,
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve("scripts/video-lancement-voix.ps1"),
      "-Source",
      resolve(dossier, "textes-fr.json"),
      "-Destination",
      dossier,
    ],
    { stdout: "inherit", stderr: "inherit", windowsHide: true },
  );
  if (await p.exited) throw Error("Synthèse vocale française impossible");
}
const outils = resolve(".cache/video-outils/ffmpeg-9.0.2-essentials_build/bin");
const ffmpeg = Bun.env.AUTO_VIDEO_FFMPEG ?? resolve(outils, "ffmpeg.exe"),
  ffprobe = Bun.env.AUTO_VIDEO_FFPROBE ?? resolve(outils, "ffprobe.exe");
for (const chemin of [ffmpeg, ffprobe])
  if (!(await Bun.file(chemin).exists())) throw Error("Fournisseur média qualifié requis : " + chemin);
async function commande(args: string[]) {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw Error("Média : " + err.slice(-1600));
  return out;
}
const paroles = JSON.parse((await Bun.file(resolve(dossier, "paroles-fr.json")).text()).replace(/^\uFEFF/, "")) as {
  voix: string;
  langue: string;
  scenes: { id: string; mots: { position: number; secondes: number }[] }[];
};
const timeline: any[] = [];
let frame = 0;
for (const scene of lancement) {
  const source = resolve(dossier, scene.id + "-voix.wav");
  const meta = JSON.parse(
    await commande([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", source]),
  );
  const duree = Number(meta.format.duration);
  if (!Number.isFinite(duree) || duree <= 0) throw Error("Durée vocale invalide");
  const images = Math.max(8 * fps, Math.ceil(duree * fps) + 30),
    sortie = resolve(dossier, scene.id + ".wav");
  await commande([
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    "-af",
    `aresample=${frequence},adelay=${frequence}S:all=1,apad,atrim=end_sample=${images * (frequence / fps)}`,
    "-ar",
    String(frequence),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    sortie,
  ]);
  const mots = paroles.scenes.find((s) => s.id === scene.id)?.mots ?? [],
    carte = prononcer(scene.speech),
    blocs: { texte: string; position: number }[] = [];
  let texte = "",
    debut = 0;
  for (const m of scene.speech.matchAll(/\S+\s*/g)) {
    if (texte.length + m[0].length > 88 && texte) {
      blocs.push({ texte: texte.trim(), position: debut });
      texte = "";
    }
    if (!texte) debut = m.index!;
    texte += m[0];
  }
  if (texte) blocs.push({ texte: texte.trim(), position: debut });
  const captions = blocs.map((b) => {
    const mot = referenceVoix ? undefined : mots.find((m) => m.position >= carte.position(b.position));
    const start = 0.5 + (mot?.secondes ?? (duree * b.position) / scene.speech.length);
    return { text: b.texte, start: Math.max(0, Math.min(start, duree + 0.45)), end: 0 };
  });
  for (let i = 0; i < captions.length; i++) {
    const current = captions[i]!;
    const next = captions[i + 1]?.start;
    current.end = Math.min(next ?? 0.5 + duree, duree + 0.5);
    if (current.end <= current.start) current.end = Math.min(current.start + 0.1, duree + 0.5);
    if (current.end <= current.start || current.end > images / fps)
      throw Error(`Sous-titre hors timeline : ${scene.id}`);
  }
  timeline.push({
    id: scene.id,
    start: frame / fps,
    duration: images / fps,
    startFrame: frame,
    durationFrames: images,
    audio: "audio/" + scene.id + ".wav",
    speechDuration: duree,
    voice: paroles.voix,
    captions,
  });
  frame += images;
}
await Bun.write(resolve(dossier, "concat.txt"), timeline.map((s) => `file '${s.id}.wav'`).join("\n") + "\n");
await commande([
  ffmpeg,
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "concat",
  "-safe",
  "1",
  "-i",
  resolve(dossier, "concat.txt"),
  "-ar",
  String(frequence),
  "-ac",
  "1",
  "-c:a",
  "pcm_s16le",
  resolve(dossier, "narration-fr.wav"),
]);
await Bun.write(resolve(dossier, "timeline.json"), JSON.stringify(timeline, null, 2));
await Bun.write(resolve("dist/lancement-btp/timeline.json"), JSON.stringify(timeline, null, 2));
function time(t: number) {
  const ms = Math.round(t * 1000),
    h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
let index = 1;
await Bun.write(
  resolve("dist/lancement-btp/sous-titres-fr.srt"),
  timeline
    .flatMap((s) =>
      s.captions.map((c: any) => `${index++}\n${time(s.start + c.start)} --> ${time(s.start + c.end)}\n${c.text}\n`),
    )
    .join("\n"),
);
await Bun.write(
  resolve(dossier, "qualification-voix.json"),
  JSON.stringify(
    {
      voix: paroles.voix,
      langue: paroles.langue,
      frequence,
      canaux: 1,
      fps,
      frames: frame,
      duree: frame / fps,
      scenes: timeline.length,
      horodatageParMots: referenceVoix
        ? "répartition proportionnelle au texte, sous-titres bornés à chaque scène"
        : "System.Speech SpeakProgress réel",
      BunVideoWav:
        "conteneur WAV non pris en charge par le décodeur installé ; durée mesurée avec le fournisseur FFprobe qualifié",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    voix: paroles.voix,
    scenes: timeline.length,
    frames: frame,
    duration: frame / fps,
    narration: resolve(dossier, "narration-fr.wav"),
    timeline: resolve("dist/lancement-btp/timeline.json"),
  }),
);

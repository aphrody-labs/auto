// Ajoute la narration au rendu muet, conserve les images NVENC et contrôle le résultat.
import { rename } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd(),
  out = resolve("dist/lancement-btp"),
  image = resolve(out, "image.mp4"),
  narration = resolve(out, "audio/narration-fr.wav"),
  timelinePath = resolve(out, "timeline.json"),
  sousTitres = resolve(out, "sous-titres-fr.srt"),
  final = resolve(out, "auto-btp-lancement-fr.mp4"),
  temp = resolve(out, "auto-btp-lancement-fr.mix.mp4");
const ffmpeg =
    Bun.env.AUTO_VIDEO_FFMPEG ??
    [...new Bun.Glob(".cache/video-outils/**/bin/ffmpeg.exe").scanSync({ cwd: root, onlyFiles: true })].map((p) =>
      resolve(p),
    )[0] ??
    Bun.which("ffmpeg"),
  ffprobe =
    Bun.env.AUTO_VIDEO_FFPROBE ?? (ffmpeg ? ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1") : Bun.which("ffprobe"));
if (!ffmpeg || !ffprobe) throw new Error("FFmpeg et FFprobe doivent être installés pour le mix final.");
for (const path of [image, narration, timelinePath, sousTitres])
  if (!(await Bun.file(path).exists())) throw new Error(`Élément requis avant le mix absent : ${path}`);

async function run(args: string[]) {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} a échoué (${code}) : ${stderr.slice(-3000)}`);
  return { stdout, stderr };
}
const timeline = (await Bun.file(timelinePath).json()) as {
  id: string;
  startFrame: number;
  durationFrames: number;
  captions: { start: number; end: number }[];
}[];
if (timeline.length !== 23) throw new Error(`La timeline doit contenir les 23 scènes, contient ${timeline.length}.`);
let frame = 0;
for (const scene of timeline) {
  if (scene.startFrame !== frame || !Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0)
    throw new Error(`Timeline discontinue ou invalide à la scène ${scene.id}.`);
  for (const caption of scene.captions ?? [])
    if (!(caption.start >= 0 && caption.end > caption.start && caption.end <= scene.durationFrames / 24))
      throw new Error(`Sous-titre hors scène ${scene.id}.`);
  frame += scene.durationFrames;
}
const duration = frame / 24,
  samples = frame * 2000,
  probe = JSON.parse(
    (
      await run([
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration,sample_rate,channels",
        "-show_format",
        "-of",
        "json",
        image,
      ])
    ).stdout,
  ),
  video = probe.streams.find((s: any) => s.codec_type === "video");
if (!video || video.width !== 1920 || video.height !== 1080 || video.codec_name !== "h264")
  throw new Error("Le rendu muet ne contient pas la vidéo H.264 1080p prévue.");
if (Number(video.nb_frames) !== frame)
  throw new Error(`Le rendu muet contient ${video.nb_frames} images, la timeline en prévoit ${frame}.`);
const audioProbe = JSON.parse(
  (
    await run([
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "stream=sample_rate,channels,duration",
      "-select_streams",
      "a:0",
      "-of",
      "json",
      narration,
    ])
  ).stdout,
);
const audio = audioProbe.streams[0];
if (!audio || Number(audio.sample_rate) !== 48000 || Number(audio.channels) !== 1)
  throw new Error("La narration doit être en PCM mono 48 kHz.");
const expectedAudioDuration = samples / 48000;
if (Math.abs(Number(audio.duration) - expectedAudioDuration) > 1 / 48000)
  throw new Error("La narration et la timeline n'ont pas la même durée exacte.");

await run([
  ffmpeg,
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  image,
  "-i",
  narration,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-c:v",
  "copy",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-af",
  `loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=end_sample=${samples}`,
  "-t",
  duration.toFixed(6),
  "-movflags",
  "+faststart",
  temp,
]);
const finalProbe = JSON.parse(
  (
    await run([
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration,sample_rate,channels",
      "-show_format",
      "-of",
      "json",
      temp,
    ])
  ).stdout,
);
const finalVideo = finalProbe.streams.find((s: any) => s.codec_type === "video"),
  finalAudio = finalProbe.streams.find((s: any) => s.codec_type === "audio");
if (
  !finalVideo ||
  !finalAudio ||
  Number(finalVideo.nb_frames) !== frame ||
  finalAudio.codec_name !== "aac" ||
  Number(finalAudio.sample_rate) !== 48000 ||
  Math.abs(Number(finalProbe.format.duration) - duration) > 1 / 24
)
  throw new Error("Le conteneur final ne correspond pas à la vidéo et à l'audio synchronisés.");
await run([ffmpeg, "-v", "error", "-i", temp, "-f", "null", "-"]);
await rename(temp, final);
const hasher = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(final).stream()) hasher.update(chunk);
const receipt = {
  fichier: final,
  sha256: hasher.digest("hex"),
  tailleOctets: Bun.file(final).size,
  dureeSecondes: duration,
  fps: 24,
  images: frame,
  scenes: timeline.length,
  video: { codec: finalVideo.codec_name, largeur: finalVideo.width, hauteur: finalVideo.height },
  audio: {
    codec: finalAudio.codec_name,
    frequence: Number(finalAudio.sample_rate),
    canaux: Number(finalAudio.channels),
  },
  decodageComplet: "reussi",
  horodatage: new Date().toISOString(),
};
await Bun.write(resolve(out, "mixage.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));

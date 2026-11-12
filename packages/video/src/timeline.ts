import type { Scene } from "./scenario";

export interface Caption {
  start: number;
  end: number;
  text: string;
}
export interface TimedScene extends Scene {
  start: number;
  duration: number;
  captions: Caption[];
  audio?: string;
}

/** Les timecodes des sous-titres sont locaux à chaque scène et ceux des scènes sont alignés sur les images. */
export function validerTimeline(scenes: Scene[], input: unknown, fps = 24): TimedScene[] {
  const rows = Array.isArray(input) ? input : (input as { scenes?: unknown })?.scenes;
  if (!Array.isArray(rows) || rows.length !== scenes.length) throw new Error("Nombre de scènes de narration incorrect");
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("Identifiant de narration dupliqué");
  let nextFrame = 0;
  return scenes.map((scene) => {
    const timing = rows.find((row) => row.id === scene.id);
    if (!timing || !Number.isFinite(timing.start) || !Number.isFinite(timing.duration) || timing.duration <= 0)
      throw new Error(`Timeline invalide : ${scene.id}`);
    const startFrame = Math.round(timing.start * fps);
    const durationFrames = Math.round(timing.duration * fps);
    if (
      startFrame !== nextFrame ||
      durationFrames < 1 ||
      Math.abs(startFrame / fps - timing.start) > 0.00001 ||
      Math.abs(durationFrames / fps - timing.duration) > 0.00001
    )
      throw new Error(`Timecodes non continus ou non alignés : ${scene.id}`);
    nextFrame += durationFrames;
    const captions: Caption[] = timing.captions ?? [];
    if (!Array.isArray(captions)) throw new Error(`Sous-titres invalides : ${scene.id}`);
    let previous = 0;
    for (const caption of captions) {
      if (
        !Number.isFinite(caption.start) ||
        !Number.isFinite(caption.end) ||
        caption.start < previous - 0.001 ||
        caption.end <= caption.start ||
        caption.end > timing.duration + 0.001 ||
        typeof caption.text !== "string" ||
        !caption.text.trim()
      )
        throw new Error(`Sous-titres invalides : ${scene.id}`);
      previous = caption.end;
    }
    return {
      ...scene,
      start: timing.start,
      duration: timing.duration,
      captions,
      ...(typeof timing.audio === "string" ? { audio: timing.audio } : {}),
    };
  });
}

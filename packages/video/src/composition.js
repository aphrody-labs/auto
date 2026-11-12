// Contrat de composition déterministe Bun Video / HyperFrames : aucun délai lié au temps réel.
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = (v) => 1 - (1 - clamp(v)) ** 3;
const escapeText = (v = "") =>
  String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const blueprint = `<div class="blueprint"><svg viewBox="0 0 760 520" aria-hidden="true"><g class="drawing"><path class="thin" d="M0 390L360 180L760 410M80 440L460 220M170 485L540 270M0 300L420 510M250 200L760 490"/><path class="fill" d="M100 260L370 110L650 265L385 420Z"/><path d="M100 260V135L370 0L650 145V265M370 0V110M385 420V290L650 145M100 135L385 290M190 185V310M280 235V360M470 242V370M560 190V315"/><path class="block" d="M205 199L266 232V302L205 270ZM453 250L515 217V288L453 321Z"/><path class="thin" d="M75 330L75 440M75 420L385 595M665 310V425M385 450V550"/></g></svg><div class="doc-chip chip-one">▤ Devis</div><div class="doc-chip chip-two">✓ Achats vérifiés</div><div class="doc-chip chip-three">CH-001 · Villa des Pins</div></div>`;
let scenes;
let active = -1;
const container = document.querySelector("#scene");
const caption = document.querySelector("#caption");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

async function mount(i) {
  active = i;
  const s = scenes[i];
  const kind = s.kind ?? "screen";
  container.className = `${kind}-scene`;
  const points = s.points?.length
    ? `<ul class="points">${s.points.map((p) => `<li>${escapeText(p)}</li>`).join("")}</ul>`
    : "";
  const copy = `<div class="copy ${kind === "intro" ? "intro-copy" : ""}">${kind === "intro" ? '<div class="pill">LA GESTION QUI SUIT VOTRE CHANTIER</div>' : ""}<h1>${escapeText(s.title)}</h1><p class="sub">${escapeText(s.subtitle)}</p>${points}${s.note ? `<p class="note">${escapeText(s.note)}</p>` : ""}</div>`;
  const image = s.image
    ? `<div class="screen-label">${s.origin === "production" ? "CAPTURE DU SITE EN LIGNE" : "APPLICATION RÉELLE · DONNÉES DE DÉMONSTRATION"}</div><div class="screen-shell ${kind === "phone" ? "phone-shell" : ""}">${kind === "phone" ? "" : '<div class="browser-bar"><span class="dots"><i></i><i></i><i></i></span>auto · gestion d’entreprise</div>'}<img class="screen-image" src="/captures/${escapeText(s.image)}.png" alt="Écran réel de l’application auto" /></div>`
    : "";
  container.innerHTML = copy + image + (["intro", "steps"].includes(kind) ? blueprint : "");
  document.querySelector("#chapter").textContent = s.chapter;
  document.querySelector("#counter").textContent = `${String(i + 1).padStart(2, "0")} / ${scenes.length}`;
  await Promise.all([...container.querySelectorAll("img")].map((img) => img.decode()));
}

function wordsCaption(s, local) {
  if (s.captions?.length) return s.captions.find((c) => local >= c.start && local < c.end)?.text ?? "";
  const sentences = s.speech.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [s.speech];
  const count = sentences.reduce((n, t) => n + t.length, 0);
  let at = 0.35;
  for (const text of sentences) {
    const length = ((s.duration - 0.7) * text.length) / count;
    if (local >= at && local < at + length) return text.trim();
    at += length;
  }
  return "";
}

async function seek(time) {
  const i = Math.max(
    0,
    scenes.findLastIndex((s) => time >= s.start),
  );
  if (i !== active) await mount(i);
  const s = scenes[i];
  const local = Math.max(0, time - s.start);
  const p = clamp(local / s.duration);
  const enter = reduced ? 1 : ease(local / 0.85);
  const leave = reduced ? 1 : clamp((s.duration - local) / 0.32);
  container.style.opacity = Math.min(1, enter * 1.3, leave);
  const copy = container.querySelector(".copy");
  copy.style.transform = `translateY(${(1 - enter) * 32}px)`;
  const screen = container.querySelector(".screen-shell");
  if (screen) {
    const rotation = reduced ? 0 : (1 - enter) * -3;
    screen.style.transform = `perspective(1800px) translateX(${(1 - enter) * 75}px) rotateY(${rotation}deg) scale(${0.975 + enter * 0.025})`;
    const img = screen.querySelector("img");
    img.style.transformOrigin = "center top";
    img.style.transform = `scale(${reduced ? 1 : 1 + p * 0.025})`;
  }
  const model = container.querySelector(".blueprint");
  if (model) {
    model.style.transform = `perspective(1500px) rotateY(${reduced ? 0 : -9 + 12 * p}deg) translateY(${reduced ? 0 : -10 * Math.sin(p * Math.PI)}px)`;
    for (const path of model.querySelectorAll("path"))
      path.style.strokeDashoffset = String(2200 * (1 - ease(local / 2.3)));
    for (const [index, chip] of [...model.querySelectorAll(".doc-chip")].entries()) {
      const a = ease((local - 0.5 - index * 0.3) / 0.7);
      chip.style.opacity = a;
      chip.style.transform = `translateY(${(1 - a) * 25}px)`;
    }
  }
  caption.textContent = wordsCaption(s, local);
  caption.style.visibility = caption.textContent ? "visible" : "hidden";
  document.querySelector("#progress").style.setProperty("--progress", `${(100 * time) / window.__hf.duration}%`);
}

async function init() {
  scenes = await (await fetch("/timeline.json")).json();
  await document.fonts.ready;
  const duration = scenes.at(-1).start + scenes.at(-1).duration;
  window.__hf = { duration, seek };
  window.__hfFlushSync = () => {
    document.querySelector("#scene").getBoundingClientRect();
  };
  await seek(0);
  window.__videoReady = true;
  window.showcaseReady = true;
}
init().catch((error) => {
  document.body.textContent = String(error);
  throw error;
});

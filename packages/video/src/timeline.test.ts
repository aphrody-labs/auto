import { expect, test } from "bun:test";
import { validerTimeline } from "./timeline";
import type { Scene } from "./scenario";
const scenes: Scene[] = [
  { id: "a", chapter: "Exemple", title: "Chantier", subtitle: "Démonstration", speech: "Un vrai parcours." },
];
test("accepte des timecodes audio alignés et des sous-titres locaux", () => {
  const [result] = validerTimeline(scenes, [
    { id: "a", start: 0, duration: 12 + 2 / 24, captions: [{ start: 0.5, end: 11, text: "Un vrai parcours." }] },
  ]);
  expect(result?.duration).toBe(12 + 2 / 24);
});
test("refuse des timestamps SAPI cumulés hors de la scène", () => {
  expect(() =>
    validerTimeline(scenes, [
      {
        id: "a",
        start: 0,
        duration: 12 + 2 / 24,
        captions: [
          { start: 0.749375, end: 21.897875, text: "Trop long" },
          { start: 21.897875, end: 11.512375, text: "Retour en arrière" },
        ],
      },
    ]),
  ).toThrow("Sous-titres invalides");
});
test("refuse les trous et les durées non alignées", () => {
  expect(() => validerTimeline(scenes, [{ id: "a", start: 1, duration: 12 }])).toThrow("Timecodes");
  expect(() => validerTimeline(scenes, [{ id: "a", start: 0, duration: 12.01 }])).toThrow("Timecodes");
});

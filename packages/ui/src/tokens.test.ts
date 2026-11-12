import { describe, expect, test } from "bun:test";
import { type Theme, contraste, genererCss, palettes, roles, statuts } from "./tokens";

const themes: Theme[] = ["clair", "sombre"];

describe("contrastes WCAG AA", () => {
  test("référence : noir sur blanc = 21", () => {
    expect(contraste("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  for (const t of themes) {
    const p = palettes[t];
    test(`${t} : texte >= 4.5`, () => {
      for (const fond of [p.fond, p.surface, p.surfaceAlt]) {
        expect(contraste(p.texte, fond)).toBeGreaterThanOrEqual(4.5);
        expect(contraste(p.texteAttenue, fond)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contraste(p.surPrimaire, p.primaire)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.surDanger, p.danger)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.primaire, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.danger, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.succes, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(p.avertissement, p.surface)).toBeGreaterThanOrEqual(4.5);
    });
    test(`${t} : éléments non textuels >= 3`, () => {
      expect(contraste(p.bordureControle, p.surface)).toBeGreaterThanOrEqual(3);
      expect(contraste(p.focus, p.surface)).toBeGreaterThanOrEqual(3);
      expect(contraste(p.focus, p.fond)).toBeGreaterThanOrEqual(3);
    });
    test(`${t} : badges de statut >= 4.5`, () => {
      for (const [nom, s] of Object.entries(statuts[t])) {
        expect(contraste(s.texte, s.fond), nom).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("tokens.css", () => {
  test("est le miroir exact de tokens.ts", async () => {
    const css = await Bun.file(new URL("./tokens.css", import.meta.url)).text();
    expect(css).toBe(genererCss());
  });
});

describe("alias Material 3", () => {
  test("chaque var(--…) référencée est définie (ici ou dans les jetons système M3)", async () => {
    const css = genererCss();
    const m3 = await Bun.file(Bun.fileURLToPath(import.meta.resolve("@aphrody/m3-tokens/m3-tokens.css"))).text();
    const definies = new Set([...(css + m3).matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const references = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    expect([...references].filter((v) => !definies.has(v))).toEqual([]);
  });

  test("primaire = rôle M3 primary de la graine de marque", () => {
    expect(palettes.clair.primaire).toBe(roles.clair["--md-sys-color-primary"]!);
    expect(palettes.sombre.texte).toBe(roles.sombre["--md-sys-color-on-surface"]!);
  });
});

test("schéma de couleurs des contrôles natifs aligné sur le thème imposé", () => {
  const css = genererCss();
  expect(css).toMatch(/:root\[data-theme="clair"\] \{\n {2}color-scheme: light;/);
  expect(css).toMatch(/:root\[data-theme="sombre"\] \{\n {2}color-scheme: dark;/);
  expect(css).toMatch(/:root \{\n {2}color-scheme: light dark;/);
});

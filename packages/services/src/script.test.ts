import { expect, test } from "bun:test";
import { executer, valider } from "@auto/automate";
import { executerScript, LIMITES_SCRIPT } from "./script";

const donnees = (elements: Record<string, unknown>[]) => ({
  elements,
  json: elements[0] ?? null,
  noeuds: { lire: { total: 3 } },
  execution: { id: "e" },
  workflow: { id: "w", nom: "W" },
});

test("API n8n : $input, items, $json, $(), console, async", async () => {
  const r = await executerScript(
    `console.log("n", items.length);
     const t = $("lire").first().json.total;
     await Promise.resolve();
     return $input.all().map((i) => ({ nom: i.json.nom.toUpperCase(), t, premier: $json.nom }));`,
    donnees([{ nom: "a" }, { nom: "b" }]),
  );
  expect(r.resultat).toEqual([
    { nom: "A", t: 3, premier: "a" },
    { nom: "B", t: 3, premier: "a" },
  ]);
  expect(r.journal).toEqual(["n 2"]);
});

test("isolation : ni Bun, ni fetch, ni process, ni require", async () => {
  const r = await executerScript(
    `return [typeof Bun, typeof fetch, typeof process, typeof require, typeof globalThis.Deno];`,
    donnees([]),
  );
  expect(r.resultat).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
});

test("bornes : boucle infinie, mémoire, erreur levée, promesse jamais résolue", async () => {
  const debut = Date.now();
  await expect(executerScript(`while (true) {}`, donnees([]), { ...LIMITES_SCRIPT, dureeMs: 200 })).rejects.toThrow(
    "durée maximale",
  );
  expect(Date.now() - debut).toBeLessThan(2000);
  await expect(
    executerScript("const a = []; for (let i = 0; i < 2e6; i++) a.push({ i }); return a.length;", donnees([]), {
      ...LIMITES_SCRIPT,
      memoire: 8 * 1024 * 1024,
    }),
  ).rejects.toThrow("mémoire maximale");
  await expect(executerScript(`throw new TypeError("mauvais client")`, donnees([]))).rejects.toThrow(
    "TypeError : mauvais client",
  );
  await expect(executerScript(`await new Promise(() => {}); return 1;`, donnees([]))).rejects.toThrow("jamais");
});

test("nœud Code dans le moteur : par lot et par élément", async () => {
  const def = (mode: string, code: string) =>
    valider({
      noeuds: [
        { id: "t", type: "declencheur.manuel", nom: "t", parametres: {} },
        { id: "c", type: "donnees.code", nom: "c", parametres: { mode, code } },
      ],
      connexions: [{ de: "t", vers: "c" }],
    });
  const services = { fetch: () => Promise.reject(new Error("réseau")), script: executerScript };
  const o = { services, workflow: { id: "w", nom: "W" }, executionId: "e" };
  const lot = await executer(def("lot", "return [{ n: items.length }]"), [{ json: { a: 1 } }, { json: { a: 2 } }], o);
  expect(lot.sortie.map((e) => e.json)).toEqual([{ n: 2 }]);
  const parElement = await executer(
    def("element", "return { double: $json.a * 2 }"),
    [{ json: { a: 1 } }, { json: { a: 2 } }],
    o,
  );
  expect(parElement.sortie.map((e) => e.json)).toEqual([{ double: 2 }, { double: 4 }]);
});

test("le code tourne dans un thread à part : la boucle d'événements reste libre", async () => {
  let ticks = 0;
  const h = setInterval(() => ticks++, 10);
  await expect(executerScript(`while (true) {}`, donnees([]), { ...LIMITES_SCRIPT, dureeMs: 300 })).rejects.toThrow();
  clearInterval(h);
  expect(ticks).toBeGreaterThan(5);
});

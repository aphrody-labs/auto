// Bac à sable du nœud Code : QuickJS compilé en WebAssembly. Le code de l'utilisateur n'a ni réseau, ni fichiers,
// ni `Bun`, ni `process` ; un runtime neuf par appel (aucun état partagé entre entreprises), mémoire et pile
// bornées, interruption à l'échéance (boucles infinies comprises). Le `ShadowRealm` de Bun n'isole pas : il expose
// `Bun`, `fetch` et `process` au code évalué (vérifié sur Bun 1.4.6), d'où ce moteur séparé.
import type { DonneesScript } from "@auto/automate";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

export const LIMITES_SCRIPT = { memoire: 64 * 1024 * 1024, pile: 1024 * 1024, dureeMs: 5_000, sortie: 5_000_000 };

/** Prélude : l'API d'un nœud Code de n8n, sur les données passées en JSON. */
const prelude = (donnees: string) => `
const __d = JSON.parse(${JSON.stringify(donnees)});
const items = __d.elements.map((json) => ({ json }));
const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1], item: items[0] };
const $json = __d.json;
const $execution = __d.execution;
const $workflow = __d.workflow;
const $noeud = Object.fromEntries(Object.entries(__d.noeuds).map(([k, json]) => [k, { json }]));
const $ = (id) => {
  const json = __d.noeuds[id];
  if (!json) throw new Error("nœud inconnu ou pas encore exécuté : " + id);
  return { first: () => ({ json }), last: () => ({ json }), all: () => [{ json }], item: { json } };
};
const __journal = [];
const console = { log: (...a) => { if (__journal.length < 100) __journal.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ").slice(0, 2000)); } };
console.info = console.warn = console.error = console.log;
`;

export class ErreurScript extends Error {}

/** Exécution dans le thread courant (bloquant jusqu'à l'échéance) : utilisée par le Worker ci-dessous. */
export async function executerScriptIci(
  code: string,
  donnees: DonneesScript,
  limites = LIMITES_SCRIPT,
): Promise<{ resultat: unknown; journal: string[] }> {
  const Q = await getQuickJS();
  const rt = Q.newRuntime();
  rt.setMemoryLimit(limites.memoire);
  rt.setMaxStackSize(limites.pile);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limites.dureeMs));
  const vm = rt.newContext();
  try {
    const source = `${prelude(JSON.stringify(donnees))}
(async () => {
${code}
})().then((r) => JSON.stringify({ r: r === undefined ? null : r, j: __journal }))`;
    const r = vm.evalCode(source, "code.js");
    if (r.error) {
      const e = vm.dump(r.error) as { name?: string; message?: string };
      r.error.dispose();
      throw new ErreurScript(traduire(e));
    }
    const promesse = r.value;
    try {
      const jobs = rt.executePendingJobs();
      if (jobs.error) {
        const e = vm.dump(jobs.error) as { message?: string };
        jobs.error.dispose();
        throw new ErreurScript(traduire(e));
      }
      const etat = vm.getPromiseState(promesse);
      if (etat.type === "pending") throw new ErreurScript("le code attend une promesse qui ne se résout jamais");
      if (etat.type === "rejected") {
        const e = vm.dump(etat.error) as { name?: string; message?: string };
        etat.error.dispose();
        throw new ErreurScript(traduire(e));
      }
      const texte = vm.dump(etat.value) as string;
      etat.value.dispose();
      if (texte.length > limites.sortie) throw new ErreurScript("résultat trop volumineux (5 Mo au plus)");
      const { r: resultat, j: journal } = JSON.parse(texte) as { r: unknown; j: string[] };
      return { resultat, journal };
    } finally {
      promesse.dispose();
    }
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

function traduire(e: { name?: string; message?: string } | string): string {
  if (typeof e === "string") return e;
  if (e.message === "interrupted") return "durée maximale du code dépassée";
  if (e.message === "out of memory") return "mémoire maximale du code dépassée";
  return `${e.name ?? "Error"} : ${e.message ?? String(e)}`;
}

/**
 * Exécution dans un Worker Bun dédié : le WebAssembly synchrone ne bloque pas la boucle de l'API ou du worker,
 * et le thread est arrêté si l'échéance interne ne suffit pas.
 */
export function executerScript(
  code: string,
  donnees: DonneesScript,
  limites = LIMITES_SCRIPT,
): Promise<{ resultat: unknown; journal: string[] }> {
  const w = new Worker(new URL("./script-worker.ts", import.meta.url));
  return new Promise<{ resultat: unknown; journal: string[] }>((ok, ko) => {
    const garde = setTimeout(() => ko(new ErreurScript("durée maximale du code dépassée")), limites.dureeMs + 2_000);
    w.onmessage = (
      e: MessageEvent<{ ok: true; r: { resultat: unknown; journal: string[] } } | { ok: false; erreur: string }>,
    ) => {
      clearTimeout(garde);
      if (e.data.ok) ok(e.data.r);
      else ko(new ErreurScript(e.data.erreur));
    };
    w.onerror = (e) => {
      clearTimeout(garde);
      ko(new ErreurScript(e.message));
    };
    w.postMessage({ code, donnees, limites });
  }).finally(() => w.terminate());
}

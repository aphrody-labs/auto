// Thread du bac à sable du nœud Code (voir script.ts).
import { executerScriptIci } from "./script";

declare const self: Worker;

self.onmessage = async (e: MessageEvent) => {
  try {
    const r = await executerScriptIci(e.data.code, e.data.donnees, e.data.limites);
    self.postMessage({ ok: true, r });
  } catch (err) {
    self.postMessage({ ok: false, erreur: err instanceof Error ? err.message : String(err) });
  }
};

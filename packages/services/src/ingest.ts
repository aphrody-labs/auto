// Lot ingest : factures fournisseurs reçues (dépôt, liste, fichier, validation manuelle).
import { clientOpenAi, configLlmDepuisEnv, ingerer, type ClientLlm, type Ocr, type StatutRecue } from "@auto/ingest";
import {
  empreinteSha256,
  enregistrerRecue,
  ErreurMetier,
  recueParFichier,
  withTenant,
  type FichierEntrant,
  type Recue,
  type Sql,
} from "@auto/store";
import { consommer, verifierQuota } from "@auto/billing";

/** Réglages de l'ingestion (remplaçables en test). Le LLM est résolu à chaque appel : aucun état partagé. */
export const reglages: { ocr?: Ocr; llm: () => ClientLlm | null } = {
  llm: () => {
    const c = configLlmDepuisEnv();
    return c && clientOpenAi(c);
  },
};

/** Client LLM compté : quota `appels_llm` vérifié puis consommé avant chaque appel (402 au-delà). */
export function avecQuota(sql: Sql, tenantId: string, c: ClientLlm | null): ClientLlm | null {
  if (!c) return null;
  return {
    async completer(r) {
      await withTenant(sql, tenantId, async (tx) => {
        await verifierQuota(tx, "appels_llm");
        await consommer(tx, "appels_llm");
      });
      return c.completer(r);
    },
  };
}

export const TAILLE_MAX = 20 * 1024 * 1024;
export const STATUTS: StatutRecue[] = ["a_verifier", "validee", "rejetee"];

/**
 * Dépôt d'un fichier reçu pour un tenant, quel que soit le canal (API, et demain mail et PA) :
 * dédoublonnage par SHA-256, extraction hors transaction (OCR et LLM peuvent être lents), enregistrement.
 */
export async function deposer(
  sql: Sql,
  tenantId: string,
  actor: string | null,
  e: FichierEntrant,
  signal?: AbortSignal,
): Promise<{ recue: Recue; doublon: boolean }> {
  if (!e.contenu.length) throw new ErreurMetier("fichier vide");
  if (e.contenu.length > TAILLE_MAX) throw new ErreurMetier("fichier trop volumineux (20 Mo au plus)", [], 413);
  const empreinte = empreinteSha256(e.contenu);
  const existante = await withTenant(sql, tenantId, (tx) => recueParFichier(tx, empreinte));
  if (existante) return { recue: existante, doublon: true };
  const llm = avecQuota(sql, tenantId, reglages.llm());
  const r = await ingerer(e.contenu, {
    ocr: reglages.ocr,
    llm: llm && signal ? { completer: (r) => llm.completer({ ...r, signal }) } : llm,
  });
  signal?.throwIfAborted();
  try {
    return { recue: await withTenant(sql, tenantId, (tx) => enregistrerRecue(tx, actor, e, r)), doublon: false };
  } catch (err) {
    // Dépôt concurrent du même fichier : on renvoie la facture déjà enregistrée.
    const deja = await withTenant(sql, tenantId, (tx) => recueParFichier(tx, empreinte));
    if (deja) return { recue: deja, doublon: true };
    throw err;
  }
}

export async function lireDepot(req: Request): Promise<Omit<FichierEntrant, "canal">> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (type === "multipart/form-data") {
    const f = (await req.formData()).get("fichier");
    if (!(f instanceof Blob)) throw new ErreurMetier("champ « fichier » manquant");
    return {
      contenu: new Uint8Array(await f.arrayBuffer()),
      nom: f instanceof File ? f.name : undefined,
      typeMime: f.type || "application/pdf",
    };
  }
  if (!["application/pdf", "application/xml", "text/xml", "application/octet-stream"].includes(type))
    throw new ErreurMetier("Content-Type attendu : application/pdf, application/xml ou multipart/form-data", [], 415);
  const nom = new URL(req.url).searchParams.get("nom") ?? undefined;
  return { contenu: new Uint8Array(await req.arrayBuffer()), nom, typeMime: type };
}

import { extname } from "node:path";
import { ErreurMetier, indexerImport, importConnu, empreinteSha256, withTenant, type Sql } from "@auto/store";
import { MIMES, texteDocument } from "./sources-fichiers";
import { deposerDevis } from "./devis-recus";
import { deposer, TAILLE_MAX } from "./ingest";
export function cheminImport(v: unknown, nom: string) {
  const chemin = typeof v === "string" && v ? v.replaceAll("\\", "/") : nom;
  if (
    chemin.length > 1024 ||
    chemin.split("/").length > 32 ||
    chemin
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.includes(":") || [...p].some((c) => c.charCodeAt(0) < 32)) ||
    chemin.split("/").at(-1) !== nom
  )
    throw new ErreurMetier("chemin relatif invalide");
  return chemin;
}
/** Un seul fichier par requête : le navigateur orchestre la file et la reprise par SHA. */
export async function importerFichier(
  sql: Sql,
  tenantId: string,
  actor: string,
  p: { nom: string; chemin: string; segment: string; cible: string; contenu: Uint8Array<ArrayBuffer> },
  signal?: AbortSignal,
) {
  const ext = extname(p.nom).toLowerCase();
  if (!Object.hasOwn(MIMES, ext) || !p.contenu.length || p.contenu.length > TAILLE_MAX)
    throw new ErreurMetier("format non pris en charge, fichier vide ou supérieur à 20 Mo", [], 422);
  if (!["index", "devis", "facture"].includes(p.cible)) throw new ErreurMetier("traitement invalide");
  if (p.cible !== "index" && p.segment !== "fournisseurs")
    throw new ErreurMetier("les devis et factures reçus appartiennent au segment fournisseurs", [], 403);
  if (
    (p.cible === "devis" && ![".pdf", ".png", ".jpg", ".jpeg", ".docx"].includes(ext)) ||
    (p.cible === "facture" && ![".pdf", ".xml"].includes(ext))
  )
    throw new ErreurMetier("format incompatible avec cette extraction");
  const e = { nom: p.nom, contenu: p.contenu, typeMime: MIMES[ext]!, canal: "api" as const };
  const connu = await withTenant(sql, tenantId, (tx) =>
    importConnu(tx, { chemin: p.chemin, segment: p.segment, empreinte: empreinteSha256(p.contenu), cible: p.cible }),
  );
  if (connu) return { ...connu, nom: p.nom, cheminRelatif: p.chemin, segment: p.segment, doublon: true };
  let texte = "",
    devisId: string | null = null,
    recueId: string | null = null;
  if (p.cible === "devis") {
    const r = await deposerDevis(sql, tenantId, actor, e, signal);
    devisId = r.devis.id;
    texte = r.devis.texte;
  } else if (p.cible === "facture") {
    const r = await deposer(sql, tenantId, actor, e, signal);
    recueId = r.recue.id;
    texte = JSON.stringify(r.recue.facture ?? {});
  } else
    try {
      texte = await texteDocument(p.contenu, ext);
    } catch {
      throw new ErreurMetier("lecture du fichier impossible");
    }
  signal?.throwIfAborted();
  const r = await withTenant(sql, tenantId, (tx) =>
    indexerImport(tx, actor, e, { chemin: p.chemin, segment: p.segment, texte, devisId, recueId }),
  );
  return { ...r, nom: p.nom, cheminRelatif: p.chemin, segment: p.segment, devisId, recueId };
}

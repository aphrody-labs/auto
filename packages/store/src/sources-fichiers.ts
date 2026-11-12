import type { Tx } from "./db";
import { ErreurMetier, journaliser, identifiant } from "./index";
import { RACINE_IMPORTS_LOCAUX } from "./imports-fichiers";
export type SegmentMetier = "clients" | "fournisseurs" | "chantiers" | "livraisons" | "commandes";
export interface SourceFichiers {
  id: string;
  nom: string;
  racine: string;
  sousDossier: string;
  segment: SegmentMetier;
  traitement: "index" | "facture" | "devis";
  actif: boolean;
  synchroniseAt: string | null;
  erreur: string | null;
  curseur?: string | null;
}
const COLONNES = `id,nom,racine,sous_dossier AS "sousDossier",segment,traitement,actif,synchronise_at::text AS "synchroniseAt",erreur,curseur`;
export async function sourcesFichiers(tx: Tx): Promise<SourceFichiers[]> {
  return tx.unsafe(`SELECT ${COLONNES} FROM source_fichiers WHERE racine<>$1 ORDER BY nom`, [
    RACINE_IMPORTS_LOCAUX,
  ]) as Promise<SourceFichiers[]>;
}
export async function sourceFichiers(tx: Tx, id: string): Promise<SourceFichiers> {
  const [s] = (await tx.unsafe(`SELECT ${COLONNES} FROM source_fichiers WHERE id=$1`, [
    identifiant(id),
  ])) as SourceFichiers[];
  if (!s) throw new ErreurMetier("source introuvable", [], 404);
  return s;
}
export async function sauverSource(
  tx: Tx,
  actor: string,
  p: Omit<SourceFichiers, "id" | "synchroniseAt" | "erreur">,
  id?: string,
) {
  if (p?.racine === RACINE_IMPORTS_LOCAUX) throw new ErreurMetier("dépôt d’import géré automatiquement");
  if (
    !p ||
    typeof p.nom !== "string" ||
    !p.nom.trim() ||
    typeof p.racine !== "string" ||
    typeof p.sousDossier !== "string" ||
    !["clients", "fournisseurs", "chantiers", "livraisons", "commandes"].includes(p.segment) ||
    !["index", "facture", "devis"].includes(p.traitement) ||
    typeof p.actif !== "boolean"
  )
    throw new ErreurMetier("configuration de source invalide");
  if (p.traitement !== "index" && p.segment !== "fournisseurs")
    throw new ErreurMetier("les arrivages de factures et devis fournisseurs appartiennent au segment fournisseurs");
  if (id) {
    if ((await sourceFichiers(tx, id)).racine === RACINE_IMPORTS_LOCAUX)
      throw new ErreurMetier("dépôt d’import géré automatiquement");
    const verrou = await tx`SELECT id FROM source_fichiers WHERE id=${identifiant(id)} AND bail_jusqua>now()`;
    if (verrou.length) throw new ErreurMetier("synchronisation en cours", [], 409);
  }
  const r = id
    ? await tx`UPDATE source_fichiers SET nom=${p.nom.trim()},racine=${p.racine},sous_dossier=${p.sousDossier},segment=${p.segment},traitement=${p.traitement},actif=${p.actif},curseur=NULL WHERE id=${id} AND (bail_jusqua IS NULL OR bail_jusqua<now()) RETURNING id`
    : await tx`INSERT INTO source_fichiers (nom,racine,sous_dossier,segment,traitement,actif) VALUES (${p.nom.trim()},${p.racine},${p.sousDossier},${p.segment},${p.traitement},${p.actif}) RETURNING id`;
  if (!r[0]) throw new ErreurMetier("source introuvable", [], 404);
  if (id) await tx`UPDATE fichier_indexe SET segment=${p.segment} WHERE source_id=${id}`;
  await journaliser(tx, actor, id ? "source_fichiers.modifier" : "source_fichiers.creer", r[0].id);
  return sourceFichiers(tx, r[0].id);
}
export interface FichierIndexe {
  id: string;
  sourceId: string;
  nom: string;
  chemin: string;
  segment: SegmentMetier;
  archive: boolean;
  texte: string;
  recueId: string | null;
  devisId: string | null;
}
export async function fichiersIndexes(tx: Tx, segments: readonly string[]): Promise<FichierIndexe[]> {
  return tx<
    FichierIndexe[]
  >`SELECT id,source_id AS "sourceId",nom,chemin,segment,archive,left(texte,280) AS texte,recue_id AS "recueId",devis_id AS "devisId" FROM fichier_indexe WHERE segment=ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(segments)}::text::jsonb))) ORDER BY created_at DESC LIMIT 500`;
}
export async function rechercherFichiersIndexes(tx: Tx, segments: readonly string[], q: unknown = "", page = 1) {
  if (typeof q !== "string" || q.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 10000)
    throw new ErreurMetier("recherche ou page invalide");
  const motif = q.trim() ? "%" + q.trim().replace(/[\\%_]/g, "\\$&") + "%" : null;
  const fichiers = await tx<
    FichierIndexe[]
  >`SELECT id,source_id AS "sourceId",nom,chemin,segment,archive,left(texte,280) AS texte,recue_id AS "recueId",devis_id AS "devisId" FROM fichier_indexe WHERE segment=ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(segments)}::text::jsonb))) AND (${motif}::text IS NULL OR nom ILIKE ${motif} OR chemin ILIKE ${motif} OR texte ILIKE ${motif}) ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET ${(page - 1) * 100}`;
  return { fichiers: fichiers.slice(0, 100), suite: fichiers.length > 100 };
}
export async function fichierIndexe(tx: Tx, id: string, segments: readonly string[]) {
  const [f] = await tx<
    { nom: string; contenu: Uint8Array<ArrayBuffer>; type_mime: string }[]
  >`SELECT i.nom,f.contenu,f.type_mime FROM fichier_indexe i JOIN fichier_recu f ON f.tenant_id=i.tenant_id AND f.id=i.fichier_id WHERE i.id=${identifiant(id)} AND i.segment=ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(segments)}::text::jsonb)))`;
  if (!f) throw new ErreurMetier("fichier introuvable", [], 404);
  return f;
}

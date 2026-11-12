import type { Tx } from "./db";
import { conserverFichier } from "./arrivages";
import { ErreurMetier, identifiant, journaliser, type FichierEntrant } from "./index";
export type FormatAtelier = "word" | "excel" | "pdf";
export type OperationAtelier =
  | {
      type: "cellules";
      editions: {
        feuille: string;
        ligne: number;
        colonne: number;
        valeur?: string | number | boolean | null;
        formule?: string;
      }[];
    }
  | { type: "remplacer"; remplacements: { chercher: string; remplacer: string }[] }
  | { type: "champs"; valeurs: Record<string, string> }
  | { type: "pages"; pages: number[] };
export interface DocumentAtelier {
  id: string;
  nom: string;
  format: FormatAtelier;
  segment: string;
  revision: number;
  archive: boolean;
  createdAt: string;
  updatedAt: string;
}
const C = `id,nom,format,segment,revision,archive,created_at::text AS "createdAt",updated_at::text AS "updatedAt"`;
export function listerAtelier(tx: Tx, segments: readonly string[]): Promise<DocumentAtelier[]> {
  return tx.unsafe(
    `SELECT ${C} FROM atelier_document WHERE segment IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY updated_at DESC LIMIT 500`,
    [JSON.stringify(segments)],
  ) as Promise<DocumentAtelier[]>;
}
export async function lireAtelier(tx: Tx, id: string, segments: readonly string[]): Promise<DocumentAtelier> {
  const [d] = (await tx.unsafe(
    `SELECT ${C} FROM atelier_document WHERE id=$1 AND segment IN (SELECT jsonb_array_elements_text($2::text::jsonb))`,
    [identifiant(id), JSON.stringify(segments)],
  )) as DocumentAtelier[];
  if (!d) throw new ErreurMetier("document introuvable", [], 404);
  return d;
}
export async function creerAtelier(
  tx: Tx,
  actor: string,
  meta: { nom: string; format: FormatAtelier; segment: string },
  e: FichierEntrant,
) {
  const fichier = await conserverFichier(tx, e);
  const [d] =
    await tx`INSERT INTO atelier_document(nom,format,segment,fichier_id) VALUES (${meta.nom},${meta.format},${meta.segment},${fichier}) RETURNING id`;
  await tx`INSERT INTO atelier_revision(document_id,revision,fichier_id,actor) VALUES (${d!.id},1,${fichier},${actor})`;
  await journaliser(tx, actor, "atelier.creer", d!.id, { format: meta.format, segment: meta.segment });
  return lireAtelier(tx, d!.id, [meta.segment]);
}
export async function fichierAtelier(tx: Tx, id: string, segments: readonly string[], revision?: number) {
  const d = await lireAtelier(tx, id, segments);
  const [f] = await tx<
    { nom: string; typeMime: string; contenu: Uint8Array<ArrayBuffer>; sha256: string; revision: number }[]
  >`SELECT f.nom,f.type_mime AS "typeMime",f.contenu,f.sha256,v.revision FROM atelier_revision v JOIN fichier_recu f ON f.id=v.fichier_id AND f.tenant_id=v.tenant_id WHERE v.document_id=${d.id} AND v.revision=${revision ?? d.revision}`;
  if (!f) throw new ErreurMetier("version introuvable", [], 404);
  return { ...f, nom: f.nom || d.nom, document: d };
}
export async function sauverAtelier(
  tx: Tx,
  actor: string,
  id: string,
  segments: readonly string[],
  revision: number,
  e: FichierEntrant,
) {
  await tx`SELECT id FROM atelier_document WHERE id=${identifiant(id)} FOR UPDATE`;
  const d = await lireAtelier(tx, id, segments);
  if (!Number.isSafeInteger(revision) || revision !== d.revision)
    throw new ErreurMetier("le document a changé : rechargez sa dernière version avant de sauvegarder", [], 409);
  if (d.archive) throw new ErreurMetier("restaurez le document avant de le modifier", [], 409);
  const fichier = await conserverFichier(tx, e);
  const [avant] = await tx`SELECT fichier_id FROM atelier_document WHERE id=${id}`;
  if (avant!.fichier_id === fichier) return d;
  const suivante = d.revision + 1;
  await tx`UPDATE atelier_document SET fichier_id=${fichier},revision=${suivante},updated_at=now() WHERE id=${id}`;
  await tx`INSERT INTO atelier_revision(document_id,revision,fichier_id,actor) VALUES (${id},${suivante},${fichier},${actor})`;
  await journaliser(tx, actor, "atelier.sauver", id, { revision: suivante });
  return lireAtelier(tx, id, segments);
}
export async function versionsAtelier(tx: Tx, id: string, segments: readonly string[]) {
  const d = await lireAtelier(tx, id, segments);
  return tx<
    { revision: number; createdAt: string }[]
  >`SELECT revision,created_at::text AS "createdAt" FROM atelier_revision WHERE document_id=${d.id} ORDER BY revision DESC`;
}
export async function classerAtelier(tx: Tx, actor: string, id: string, segments: readonly string[], archive: boolean) {
  const d = await lireAtelier(tx, id, segments);
  if (typeof archive !== "boolean") throw new ErreurMetier("état d’archive invalide");
  await tx`UPDATE atelier_document SET archive=${archive},updated_at=now() WHERE id=${d.id}`;
  await journaliser(tx, actor, "atelier.archiver", id, { archive });
  return lireAtelier(tx, id, segments);
}

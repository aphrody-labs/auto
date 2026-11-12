import { conserverFichier, empreinteSha256, journaliser, type Tx, type FichierEntrant } from "./index";
export const RACINE_IMPORTS_LOCAUX = "__auto_imports__";
export async function importConnu(tx: Tx, p: { chemin: string; segment: string; empreinte: string; cible: string }) {
  const [f] =
    await tx`SELECT i.id,i.fichier_id AS "fichierId",i.devis_id AS "devisId",i.recue_id AS "recueId" FROM fichier_indexe i JOIN source_fichiers s ON s.tenant_id=i.tenant_id AND s.id=i.source_id WHERE s.racine=${RACINE_IMPORTS_LOCAUX} AND i.segment=${p.segment} AND i.chemin=${p.chemin} AND i.empreinte=${p.empreinte} AND (${p.cible}='index' OR (${p.cible}='devis' AND i.devis_id IS NOT NULL) OR (${p.cible}='facture' AND i.recue_id IS NOT NULL))`;
  return f ?? null;
}
/** Dépôt logique géré par Auto, jamais un chemin du disque ni une source à scanner. */
export async function indexerImport(
  tx: Tx,
  actor: string,
  e: FichierEntrant,
  p: { chemin: string; segment: string; texte: string; devisId?: string | null; recueId?: string | null },
) {
  await tx`INSERT INTO source_fichiers(nom,racine,sous_dossier,segment,traitement,actif) VALUES (${"Imports locaux — " + p.segment},${RACINE_IMPORTS_LOCAUX},${p.segment},${p.segment},'index',false) ON CONFLICT (tenant_id,racine,sous_dossier) DO NOTHING`;
  const [s] =
    await tx`SELECT id FROM source_fichiers WHERE racine=${RACINE_IMPORTS_LOCAUX} AND sous_dossier=${p.segment}`;
  const fichierId = await conserverFichier(tx, e),
    empreinte = empreinteSha256(e.contenu);
  const [nouveau] =
    await tx`INSERT INTO fichier_indexe(source_id,fichier_id,chemin,nom,segment,texte,empreinte,devis_id,recue_id) VALUES (${s!.id},${fichierId},${p.chemin},${e.nom!},${p.segment},${p.texte.slice(0, 100000)},${empreinte},${p.devisId ?? null},${p.recueId ?? null}) ON CONFLICT (tenant_id,source_id,chemin,empreinte) DO NOTHING RETURNING id`;
  const [f] =
    await tx`SELECT id,devis_id,recue_id FROM fichier_indexe WHERE source_id=${s!.id} AND chemin=${p.chemin} AND empreinte=${empreinte}`;
  const nouvelleAnalyse = (!f!.devis_id && !!p.devisId) || (!f!.recue_id && !!p.recueId);
  if (!nouveau && nouvelleAnalyse)
    await tx`UPDATE fichier_indexe SET devis_id=coalesce(devis_id,${p.devisId ?? null}),recue_id=coalesce(recue_id,${p.recueId ?? null}),texte=${p.texte.slice(0, 100000)} WHERE id=${f!.id}`;
  if (nouveau || nouvelleAnalyse)
    await journaliser(tx, actor, "fichier.importer", f!.id, { chemin: p.chemin, segment: p.segment });
  return { id: String(f!.id), fichierId, doublon: !nouveau && !nouvelleAnalyse };
}

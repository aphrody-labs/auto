import type { DevisExtrait } from "@auto/ingest";
import { ErreurMetier, journaliser, type Tx, type FichierEntrant, empreinteSha256 } from "./index";
export interface DevisRecu {
  id: string;
  fichierId: string;
  statut: "a_verifier" | "valide" | "rejete";
  data: DevisExtrait | null;
  anomalies: string[];
  texte: string;
  brouillonId: string | null;
  createdAt: string;
}
const COLONNES = `id,fichier_id AS "fichierId",statut,data,anomalies,texte,brouillon_id AS "brouillonId",created_at::text AS "createdAt"`;
export async function conserverFichier(tx: Tx, e: FichierEntrant) {
  const sha = empreinteSha256(e.contenu);
  await tx`INSERT INTO fichier_recu (nom,type_mime,sha256,taille,contenu) VALUES (${e.nom ?? null},${e.typeMime},${sha},${e.contenu.length},${e.contenu}) ON CONFLICT (tenant_id,sha256) DO NOTHING`;
  const [f] = await tx<{ id: string }[]>`SELECT id FROM fichier_recu WHERE sha256=${sha}`;
  return f!.id;
}
export async function listerDevisRecus(tx: Tx): Promise<DevisRecu[]> {
  return tx.unsafe(`SELECT ${COLONNES} FROM devis_recu ORDER BY created_at DESC`) as Promise<DevisRecu[]>;
}
export async function lireDevisRecu(tx: Tx, id: string): Promise<DevisRecu> {
  const [d] = (await tx.unsafe(`SELECT ${COLONNES} FROM devis_recu WHERE id=$1`, [id])) as DevisRecu[];
  if (!d) throw new ErreurMetier("devis reçu introuvable", [], 404);
  return d;
}
export async function enregistrerDevisRecu(
  tx: Tx,
  actor: string | null,
  e: FichierEntrant,
  r: { devis: DevisExtrait | null; texte: string; anomalies: string[] },
) {
  const fichierId = await conserverFichier(tx, e);
  const [d] = await tx<
    { id: string }[]
  >`INSERT INTO devis_recu (fichier_id,data,anomalies,texte) VALUES (${fichierId},${JSON.stringify(r.devis)}::text::jsonb,${JSON.stringify(r.anomalies)}::text::jsonb,${r.texte}) ON CONFLICT (tenant_id,fichier_id) DO NOTHING RETURNING id`;
  if (d) await journaliser(tx, actor, "devis_recu.deposer", d.id);
  const [existant] = await tx<{ id: string }[]>`SELECT id FROM devis_recu WHERE fichier_id=${fichierId}`;
  return { devis: await lireDevisRecu(tx, existant!.id), doublon: !d };
}

import { withTenant, type Sql, type Tx } from "./db";

export const avecCourrier = <T>(sql: Sql, tenant: string, user: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(sql, tenant, async (tx) => {
    await tx`SELECT set_config('app.courrier_user',${user},true)`;
    return fn(tx);
  });

export interface CompteCourrier {
  id: string;
  tenant_id: string;
  user_id: string;
  fournisseur: "google" | "microsoft" | "ovh";
  adresse: string;
  secret: Uint8Array;
  curseur: Record<string, any>;
  actif: boolean;
  synchronise_at: Date | null;
  erreur: string | null;
}
export const compteCourrier = async (tx: Tx, id: string): Promise<CompteCourrier | undefined> =>
  (await tx<CompteCourrier[]>`SELECT * FROM courrier_compte WHERE id=${id}`)[0];
export const comptesCourrier = (tx: Tx) =>
  tx`SELECT id,fournisseur,adresse,actif,synchronise_at,erreur FROM courrier_compte ORDER BY created_at`;
export interface CourrierRecu {
  distantId: string;
  messageId?: string | null;
  expediteur: string;
  destinataires: string[];
  sujet: string;
  texte: string;
  date: string;
  lu: boolean;
  dossier?: "reception" | "envoyes";
  pieces?: { nom: string; type: string; octets: Uint8Array }[];
}
export async function stockerCourrier(tx: Tx, c: CompteCourrier, m: CourrierRecu) {
  const [row] =
    await tx`INSERT INTO courrier_message(user_id,compte_id,distant_id,message_id,expediteur,destinataires,sujet,texte,date_envoi,lu,dossier)
 VALUES(${c.user_id},${c.id},${m.distantId},${m.messageId ?? null},${m.expediteur},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(m.destinataires)}::text::jsonb)),${m.sujet},${m.texte},${m.date},${m.lu},${m.dossier ?? "reception"})
 ON CONFLICT(compte_id,distant_id) DO UPDATE SET expediteur=EXCLUDED.expediteur,destinataires=EXCLUDED.destinataires,sujet=EXCLUDED.sujet,texte=EXCLUDED.texte,present=true
 RETURNING id`;
  for (const [rang, p] of (m.pieces ?? []).entries())
    await tx`INSERT INTO courrier_piece(user_id,message_id,rang,nom,type,contenu)
 VALUES(${c.user_id},${row!.id},${rang},${p.nom},${p.type},${p.octets}) ON CONFLICT(message_id,rang) DO NOTHING`;
  return String(row!.id);
}

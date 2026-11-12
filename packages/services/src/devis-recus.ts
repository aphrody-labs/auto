import { extraireDevis } from "@auto/ingest";
import {
  enregistrerDevisRecu,
  lireDevisRecu,
  empreinteSha256,
  journaliser,
  withTenant,
  ErreurMetier,
  type Sql,
  type FichierEntrant,
} from "@auto/store";
import { avecQuota, reglages, TAILLE_MAX } from "./ingest";
import { exporterAtelierPdf } from "./atelier";
function extraire(
  sql: Sql,
  tenantId: string,
  e: Pick<FichierEntrant, "contenu" | "nom" | "typeMime">,
  signal?: AbortSignal,
) {
  const llm = avecQuota(sql, tenantId, reglages.llm());
  let contenu = e.contenu;
  if (
    /\.docx$/i.test(e.nom ?? "") ||
    e.typeMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      contenu = exporterAtelierPdf(contenu, "word");
    } catch {
      return Promise.resolve({
        devis: null,
        texte: "",
        anomalies: ["lecture Word impossible : original conservé pour vérification"],
      });
    }
  }
  return extraireDevis(new Uint8Array(contenu), {
    ocr: reglages.ocr,
    llm: llm && signal ? { completer: (r) => llm.completer({ ...r, signal }) } : llm,
  });
}
export async function deposerDevis(
  sql: Sql,
  tenantId: string,
  actor: string | null,
  e: FichierEntrant,
  signal?: AbortSignal,
) {
  if (!e.contenu.length || e.contenu.length > TAILLE_MAX)
    throw new ErreurMetier("pièce vide ou supérieure à 20 Mo", [], 413);
  const existant = await withTenant(sql, tenantId, async (tx) => {
    const [d] =
      await tx`SELECT d.id FROM devis_recu d JOIN fichier_recu f ON f.id=d.fichier_id WHERE f.sha256=${empreinteSha256(e.contenu)}`;
    return d ? lireDevisRecu(tx, d.id) : null;
  });
  if (existant) return { devis: existant, doublon: true };
  const r = await extraire(sql, tenantId, e, signal);
  signal?.throwIfAborted();
  return withTenant(sql, tenantId, (tx) => enregistrerDevisRecu(tx, actor, e, r));
}
export async function reextraireDevis(sql: Sql, tenantId: string, actor: string, id: string) {
  const contenu = await withTenant(sql, tenantId, async (tx) => {
    const d = await lireDevisRecu(tx, id);
    if (d.statut !== "a_verifier" || d.brouillonId)
      throw new ErreurMetier("seuls les devis à vérifier peuvent être réextraits", [], 409);
    const [f] = await tx`SELECT contenu,nom,type_mime AS "typeMime" FROM fichier_recu WHERE id=${d.fichierId}`;
    return f as Pick<FichierEntrant, "contenu" | "nom" | "typeMime">;
  });
  const r = await extraire(sql, tenantId, contenu);
  return withTenant(sql, tenantId, async (tx) => {
    await tx`SELECT id FROM devis_recu WHERE id=${id} FOR UPDATE`;
    const d = await lireDevisRecu(tx, id);
    if (d.statut !== "a_verifier" || d.brouillonId)
      throw new ErreurMetier("le devis a été traité pendant l’extraction", [], 409);
    await tx`UPDATE devis_recu SET data=${JSON.stringify(r.devis)}::text::jsonb,anomalies=${JSON.stringify(r.anomalies)}::text::jsonb,texte=${r.texte} WHERE id=${id}`;
    await journaliser(tx, actor, "devis_recu.reextraire", id);
    return lireDevisRecu(tx, id);
  });
}

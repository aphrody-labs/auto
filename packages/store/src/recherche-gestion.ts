import type { Tx } from "./db";
import { ErreurMetier } from "./index";
export interface ResultatGestion {
  id: string;
  segment: string;
  reference: string;
  tiers: string;
  chantier: string;
  archive: boolean;
  url: string;
  total: number;
}
/** Recherche des pièces connues d'auto, jamais de parcours arbitraire du réseau ou du disque de l'hôte. */
export async function rechercherGestion(
  tx: Tx,
  q: unknown,
  segments: readonly string[] = ["clients", "fournisseurs", "chantiers", "livraisons", "commandes"],
): Promise<{ resultats: Omit<ResultatGestion, "total">[]; total: number }> {
  if (typeof q !== "string" || q.trim().length < 2 || q.length > 200)
    throw new ErreurMetier("recherche : 2 à 200 caractères attendus");
  const motif = "%" + q.trim() + "%";
  const rows = await tx<ResultatGestion[]>`WITH pieces AS (
 SELECT d.id,d.type AS segment,coalesce(d.numero,'Brouillon') AS reference,d.data->'client'->>'nom' AS tiers,coalesce(c.nom,'') AS chantier,false AS archive,
 '/app/documents/'||d.id AS url,coalesce(d.numero,'')||' '||d.data::text||' '||coalesce(c.nom,'') AS texte
 FROM document d LEFT JOIN chantier_document l ON l.tenant_id=d.tenant_id AND l.document_id=d.id LEFT JOIN chantier c ON c.tenant_id=l.tenant_id AND c.id=l.chantier_id
 UNION ALL
 SELECT f.id,'achat',coalesce(f.numero,'Sans référence'),coalesce(s.nom,f.fournisseur,''),coalesce(c.nom,''),false,'/v1/factures-recues/'||f.id||'/fichier',
 coalesce(f.numero,'')||' '||coalesce(f.data::text,'')||' '||coalesce(s.nom,'')||' '||coalesce(c.nom,'')
 FROM facture_recue f LEFT JOIN achat_affectation a ON a.tenant_id=f.tenant_id AND a.recue_id=f.id LEFT JOIN fournisseur s ON s.tenant_id=a.tenant_id AND s.id=a.fournisseur_id LEFT JOIN chantier c ON c.tenant_id=a.tenant_id AND c.id=a.chantier_id
 UNION ALL
 SELECT p.id,p.type,p.reference,f.nom,c.nom,p.archive,'/app/pieces?q='||p.reference,
 p.reference||' '||p.lignes::text||' '||p.notes||' '||f.nom||' '||c.nom
 FROM piece_chantier p JOIN fournisseur f ON f.tenant_id=p.tenant_id AND f.id=p.fournisseur_id JOIN chantier c ON c.tenant_id=p.tenant_id AND c.id=p.chantier_id
 UNION ALL
 SELECT c.id,'chantier',c.code,'',c.nom,c.archive,'/app/chantiers/'||c.id,c.nom||' '||c.code||' '||c.adresse||' '||c.notes FROM chantier c
 UNION ALL SELECT d.id,'devis_recu',coalesce(d.data->>'numero','Devis à vérifier'),coalesce(d.data->'fournisseur'->>'nom',''),'',false,'/app/devis-recus',d.texte||' '||coalesce(d.data::text,'') FROM devis_recu d
 UNION ALL SELECT i.id,'fichier_'||i.segment,i.nom,'',i.chemin,i.archive,'/v1/fichiers-indexes/'||i.id||'/fichier',i.nom||' '||i.chemin||' '||i.texte FROM fichier_indexe i
 ) SELECT id,segment,reference,tiers,chantier,archive,url,count(*) over()::integer AS total FROM pieces
 WHERE texte ILIKE ${motif} AND (CASE WHEN segment='chantier' THEN 'chantiers' WHEN segment IN ('achat','devis_recu') THEN 'fournisseurs' WHEN segment='bon_livraison' THEN 'livraisons' WHEN segment='confirmation_commande' THEN 'commandes' WHEN segment LIKE 'fichier_%' THEN substring(segment FROM 9) ELSE 'clients' END)=ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(segments)}::text::jsonb)))
 ORDER BY reference,id LIMIT 100`;
  return {
    resultats: rows.map(({ total: _total, ...r }) => ({
      ...r,
      url:
        r.segment === "bon_livraison" || r.segment === "confirmation_commande"
          ? "/app/pieces?q=" + encodeURIComponent(r.reference) + (r.archive ? "&archives=1" : "")
          : r.url,
    })),
    total: rows[0]?.total ?? 0,
  };
}

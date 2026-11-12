// Exports des cinq espaces à partir des données persistées, avec le moteur tableur/PDF existant.
import { totaux } from "@auto/domain";
import {
  calculerAnalytique,
  documentsGestion,
  listerChantiers,
  listerFournisseurs,
  listerPieces,
  listerRecues,
  ErreurMetier,
  type Tx,
} from "@auto/store";
import { creerDocx, docxEnPdf, type Classeur, type DocumentSimple } from "@auto/native";
export async function classeurGestion(
  tx: Tx,
  segments: readonly string[] = ["clients", "fournisseurs", "chantiers", "livraisons", "commandes"],
): Promise<Classeur> {
  const documents = await documentsGestion(tx),
    chantiers = await listerChantiers(tx),
    fournisseurs = await listerFournisseurs(tx),
    pieces = await listerPieces(tx),
    achats = await listerRecues(tx);
  const liens = await tx<
    { document_id: string; chantier_id: string }[]
  >`SELECT document_id,chantier_id FROM chantier_document`;
  const affectations = await tx<
    { recue_id: string; fournisseur_id: string; chantier_id: string | null }[]
  >`SELECT recue_id,fournisseur_id,chantier_id FROM achat_affectation`;
  const liensParDocument = new Map(liens.map((l) => [l.document_id, l.chantier_id]));
  const documentsParNumero = new Map(documents.filter((d) => d.numero).map((d) => [d.numero!, d.id]));
  const affectationsParAchat = new Map(affectations.map((a) => [a.recue_id, a]));
  const chantiersParId = new Map(chantiers.map((c) => [c.id, c]));
  const fournisseursParId = new Map(fournisseurs.map((f) => [f.id, f]));
  const achatsParId = new Map(achats.map((a) => [a.id, a]));
  const docChantier = (d: (typeof documents)[number]) =>
    d.type === "avoir"
      ? liensParDocument.get(documentsParNumero.get(d.data.origine || "") || "")
      : liensParDocument.get(d.id);
  const chantier = (id: string | undefined | null) => chantiersParId.get(id || "");
  const signe = (type: string) => (type === "avoir" ? -1 : 1);
  const colonnesPiece: Classeur["feuilles"][number]["colonnes"] = [
    { titre: "Référence", largeur: 24 },
    { titre: "Fournisseur", largeur: 30 },
    { titre: "Chantier", largeur: 30 },
    { titre: "Code analytique" },
    { titre: "Date", type: "date" },
    { titre: "Statut" },
    { titre: "HT", type: "euros" },
    { titre: "TVA", type: "euros" },
    { titre: "TTC", type: "euros" },
    { titre: "Facture liée", largeur: 24 },
    { titre: "Archivé" },
    { titre: "Notes", largeur: 48 },
  ];
  const feuilles: Classeur["feuilles"] = [
    {
      nom: "Comptabilité fournisseurs",
      colonnes: [
        { titre: "Référence", largeur: 24 },
        { titre: "Fournisseur", largeur: 30 },
        { titre: "Code analytique" },
        { titre: "Chantier", largeur: 30 },
        { titre: "Date", type: "date" },
        { titre: "Statut" },
        { titre: "Type" },
        { titre: "Devise" },
        { titre: "HT EUR", type: "euros" },
        { titre: "TVA EUR", type: "euros" },
        { titre: "TTC EUR", type: "euros" },
        { titre: "Classement" },
      ],
      lignes: achats.map((a) => {
        const l = affectationsParAchat.get(a.id),
          c = chantier(l?.chantier_id),
          f = a.facture,
          euro = f?.devise === "EUR",
          s = signe(f?.type || "");
        return [
          a.numero,
          fournisseursParId.get(l?.fournisseur_id || "")?.nom || a.fournisseur,
          c?.code || "",
          c?.nom || "",
          a.date,
          a.statut,
          f?.type || "",
          f?.devise || "",
          euro ? s * f!.totaux.htCents : null,
          euro ? s * f!.totaux.tvaCents : null,
          euro ? s * f!.totaux.ttcCents : null,
          l ? "Classé" : "À classer",
        ];
      }),
    },
    {
      nom: "Comptabilité clients",
      colonnes: [
        { titre: "Référence", largeur: 24 },
        { titre: "Type" },
        { titre: "Client", largeur: 30 },
        { titre: "Code analytique" },
        { titre: "Chantier", largeur: 30 },
        { titre: "Date", type: "date" },
        { titre: "Statut" },
        { titre: "HT", type: "euros" },
        { titre: "TVA", type: "euros" },
        { titre: "TTC", type: "euros" },
      ],
      lignes: documents.map((d) => {
        const c = chantier(docChantier(d)),
          s = signe(d.type);
        return [
          d.numero || "Brouillon",
          d.type,
          d.data.client.nom,
          c?.code || "",
          c?.nom || "",
          d.data.date,
          d.statut,
          s * d.htCents,
          s * d.tvaCents,
          s * d.ttcCents,
        ];
      }),
    },
    {
      nom: "Analytique chantiers",
      colonnes: [
        { titre: "Code analytique" },
        { titre: "Chantier", largeur: 30 },
        { titre: "Budget HT", type: "euros" },
        { titre: "Ventes émises HT", type: "euros" },
        { titre: "Achats validés HT", type: "euros" },
        { titre: "Solde HT", type: "euros" },
        { titre: "Commandes ouvertes HT", type: "euros" },
        { titre: "Achats non chiffrés", type: "nombre" },
        { titre: "Avancement", type: "pourcent" },
        { titre: "Statut" },
        { titre: "Archivé" },
      ],
      lignes: chantiers.map((c) => {
        const a = calculerAnalytique(
          documents.filter((d) => docChantier(d) === c.id),
          achats.filter((r) => affectationsParAchat.get(r.id)?.chantier_id === c.id),
          pieces.filter((p) => p.chantierId === c.id),
        );
        return [
          c.code,
          c.nom,
          c.budgetHtCents,
          a.ventesHtCents,
          a.achatsHtCents,
          a.soldeHtCents,
          a.commandesHtCents,
          a.achatsNonChiffres,
          c.avancement * 100,
          c.statut,
          c.archive ? "Oui" : "Non",
        ];
      }),
    },
    ...(["bon_livraison", "confirmation_commande"] as const).map((type) => ({
      nom: type === "bon_livraison" ? "Bons de livraison" : "Confirmations de commande",
      colonnes: colonnesPiece,
      lignes: pieces
        .filter((p) => p.type === type)
        .map((p) => {
          const c = chantier(p.chantierId),
            t = totaux(p.lignes);
          return [
            p.reference,
            fournisseursParId.get(p.fournisseurId)?.nom || "",
            c?.nom || "",
            c?.code || "",
            p.date,
            p.statut,
            t.htCents,
            t.tvaCents,
            t.ttcCents,
            achatsParId.get(p.recueId || "")?.numero || "",
            p.archive ? "Oui" : "Non",
            p.notes,
          ];
        }),
    })),
  ];
  const acces: Record<string, string> = {
    "Comptabilité fournisseurs": "fournisseurs",
    "Comptabilité clients": "clients",
    "Analytique chantiers": "chantiers",
    "Bons de livraison": "livraisons",
    "Confirmations de commande": "commandes",
  };
  return { feuilles: feuilles.filter((f) => segments.includes(acces[f.nom]!)) };
}

/** Rapport imprimable des données du classeur ; n'altère pas les exemplaires comptables des factures. */
export function rapportGestion(classeur: Classeur): Uint8Array<ArrayBuffer> {
  if (classeur.feuilles.reduce((s, f) => s + f.lignes.length, 0) > 10000)
    throw new ErreurMetier("rapport PDF limité à 10 000 lignes ; utilisez le classeur Excel", [], 413);
  const paragraphes: DocumentSimple["paragraphes"] = [
    { texte: "Rapport de gestion", style: "titre" },
    {
      texte:
        "Instantané des cinq espaces. Les brouillons et pièces à vérifier sont identifiés. Le solde analytique exclut les charges non saisies.",
    },
  ];
  for (const f of classeur.feuilles) {
    paragraphes.push({ texte: f.nom, style: "titre1" });
    if (!f.lignes.length) paragraphes.push({ texte: "Aucune donnée." });
    for (const row of f.lignes) {
      const texte = row
        .map((v, i) => {
          const c = f.colonnes[i]!;
          const valeur =
            typeof v === "number" && c.type === "euros"
              ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v / 100)
              : typeof v === "number" && c.type === "pourcent"
                ? v / 100 + " %"
                : (v ?? "—");
          return c.titre + " : " + valeur;
        })
        .join(" · ");
      paragraphes.push({ texte });
    }
  }
  return docxEnPdf(creerDocx({ paragraphes }));
}

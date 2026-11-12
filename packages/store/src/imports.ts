// Imports de clients et de produits depuis un tableur (correspondance de colonnes guidée), et données
// des exports comptables : pièces de vente, encaissements, créances.
import { totaux, type Document, type Partie, type PieceVente, type Tva, type Encaissement } from "@auto/domain";
import type { Tx } from "./db";
import { creerClient, creerProduit } from "./gestion";
import { ErreurMetier } from "./index";

export type Cellule = string | number | boolean | null;

export const CHAMPS_CLIENT = ["nom", "siret", "adresse", "tvaIntracom", "email"] as const;
export const CHAMPS_PRODUIT = ["designation", "prixHt", "tva", "unite"] as const;
export type ChampClient = (typeof CHAMPS_CLIENT)[number];
export type ChampProduit = (typeof CHAMPS_PRODUIT)[number];

/** Synonymes d'en-têtes reconnus pour proposer la correspondance. */
const SYNONYMES: Record<ChampClient | ChampProduit, string[]> = {
  nom: ["nom", "raison sociale", "client", "societe", "entreprise", "denomination"],
  siret: ["siret", "siren", "numero siret"],
  adresse: ["adresse", "adresse postale", "rue"],
  tvaIntracom: ["tva intracom", "tva intracommunautaire", "numero tva", "n tva", "tva"],
  email: ["email", "e mail", "mail", "courriel"],
  designation: ["designation", "libelle", "produit", "article", "description"],
  prixHt: ["prix ht", "prix unitaire ht", "pu ht", "prix", "tarif"],
  tva: ["tva", "taux tva", "taux"],
  unite: ["unite", "u"],
};

const normaliser = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Propose une correspondance champ → index de colonne d'après la ligne d'en-tête. */
export function proposerCorrespondance<C extends ChampClient | ChampProduit>(
  entete: Cellule[],
  champs: readonly C[],
): Partial<Record<C, number>> {
  const titres = entete.map(normaliser);
  const pris = new Set<number>();
  const out: Partial<Record<C, number>> = {};
  for (const champ of champs) {
    const i = titres.findIndex((t, i) => !pris.has(i) && SYNONYMES[champ].includes(t));
    if (i >= 0) {
      out[champ] = i;
      pris.add(i);
    }
  }
  return out;
}

export interface ResultatImport {
  crees: number;
  ignores: number;
  erreurs: { ligne: number; message: string }[];
}

/** Point de sauvegarde : une ligne en erreur n'annule pas les lignes déjà importées. */
const enSousTransaction = <T>(tx: Tx, fn: (sp: Tx) => Promise<T>) => tx.savepoint((sp) => fn(sp as unknown as Tx));

const texte = (v: Cellule | undefined) => (v === null || v === undefined ? "" : String(v).trim());

/** Ligne de données → champs, d'après la correspondance (index de colonne). */
const extraire = <C extends string>(ligne: Cellule[], corr: Partial<Record<C, number>>) =>
  Object.fromEntries(Object.entries(corr).map(([k, i]) => [k, ligne[i as number] ?? null])) as Partial<
    Record<C, Cellule>
  >;

/**
 * Importe des clients (lignes de données, sans l'en-tête). Un SIRET déjà présent est ignoré ; une ligne
 * invalide est signalée sans bloquer les autres.
 */
export async function importerClients(
  tx: Tx,
  actor: string | null,
  lignes: Cellule[][],
  corr: Partial<Record<ChampClient, number>>,
  premiereLigne = 2,
): Promise<ResultatImport> {
  if (corr.nom === undefined || corr.adresse === undefined)
    throw new ErreurMetier("correspondance : colonnes nom et adresse obligatoires");
  const existants = new Set(
    (await tx<{ siret: string }[]>`SELECT siret FROM client WHERE siret IS NOT NULL`).map((r) => r.siret),
  );
  const r: ResultatImport = { crees: 0, ignores: 0, erreurs: [] };
  for (const [i, ligne] of lignes.entries()) {
    if (ligne.every((c) => texte(c) === "")) continue;
    const v = extraire(ligne, corr);
    const siret = texte(v.siret).replace(/\s/g, "");
    if (siret && existants.has(siret)) {
      r.ignores++;
      continue;
    }
    const p: Partie = {
      nom: texte(v.nom),
      siret,
      adresse: texte(v.adresse),
      tvaIntracom: texte(v.tvaIntracom) || undefined,
      email: texte(v.email) || undefined,
    };
    try {
      await enSousTransaction(tx, (sp) => creerClient(sp, actor, p));
      if (siret) existants.add(siret);
      r.crees++;
    } catch (e) {
      r.erreurs.push({ ligne: premiereLigne + i, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}

const TAUX: Record<string, Tva> = { "0": 0, "2.1": 21, "5.5": 55, "10": 100, "20": 200 };

/** « 20 », « 20 % », 0,2 ou 20 → dixièmes de pourcent du domaine ; null si taux inconnu. */
export function tauxTva(v: Cellule | undefined): Tva | null {
  if (v === null || v === undefined || v === "") return 200;
  let n = typeof v === "number" ? v : Number(String(v).replace("%", "").replace(",", ".").trim());
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) n *= 100;
  return TAUX[String(Math.round(n * 10) / 10)] ?? null;
}

/** Prix « 12,50 », « 12.5 € » ou 12.5 → centimes. */
export function centimes(v: Cellule | undefined): number | null {
  if (typeof v === "number") return Math.round(v * 100);
  const s = texte(v)
    .replace(/[€\s ]/g, "")
    .replace(",", ".");
  const n = Number(s);
  return s && Number.isFinite(n) ? Math.round(n * 100) : null;
}

export async function importerProduits(
  tx: Tx,
  actor: string | null,
  lignes: Cellule[][],
  corr: Partial<Record<ChampProduit, number>>,
  premiereLigne = 2,
): Promise<ResultatImport> {
  if (corr.designation === undefined || corr.prixHt === undefined)
    throw new ErreurMetier("correspondance : colonnes désignation et prix HT obligatoires");
  const r: ResultatImport = { crees: 0, ignores: 0, erreurs: [] };
  for (const [i, ligne] of lignes.entries()) {
    if (ligne.every((c) => texte(c) === "")) continue;
    const v = extraire(ligne, corr);
    const prix = centimes(v.prixHt);
    const tva = tauxTva(v.tva);
    if (prix === null || tva === null) {
      r.erreurs.push({
        ligne: premiereLigne + i,
        message: prix === null ? "prix HT illisible" : "taux de TVA inconnu",
      });
      continue;
    }
    try {
      await enSousTransaction(tx, (sp) =>
        creerProduit(sp, actor, {
          designation: texte(v.designation),
          prixUnitaireHtCents: prix,
          tva,
          unite: texte(v.unite) || undefined,
        }),
      );
      r.crees++;
    } catch (e) {
      r.erreurs.push({ ligne: premiereLigne + i, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}

// Exports -----------------------------------------------------------------------------------------

/** Pièces de vente émises (factures, acomptes, avoirs) dont la date est dans [du, au]. */
export async function piecesVente(tx: Tx, du: string, au: string): Promise<(PieceVente & { id: string })[]> {
  const rows = await tx<{ id: string; type: Document["type"]; numero: string; data: Document }[]>`
    SELECT id, type, numero, data FROM document
    WHERE numero IS NOT NULL AND type <> 'devis' AND (data ->> 'date') BETWEEN ${du} AND ${au}
    ORDER BY data ->> 'date', numero`;
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    numero: r.numero,
    date: r.data.date,
    client: { nom: r.data.client.nom, siret: r.data.client.siret },
    totaux: totaux(r.data.lignes),
  }));
}

/** Encaissements dont la date est dans [du, au]. */
export async function encaissements(tx: Tx, du: string, au: string): Promise<Encaissement[]> {
  const rows = await tx<{ id: string; date: Date; montant_cents: string; numero: string; data: Document }[]>`
    SELECT p.id, p.date, p.montant_cents, d.numero, d.data FROM paiement p
    JOIN document d ON d.tenant_id = p.tenant_id AND d.id = p.document_id
    WHERE p.date BETWEEN ${du} AND ${au} ORDER BY p.date, p.created_at`;
  return rows.map((r, i) => ({
    numero: `BQ-${du.slice(0, 4)}-${String(i + 1).padStart(5, "0")}`,
    date: r.date.toISOString().slice(0, 10),
    factureNumero: r.numero,
    client: { nom: r.data.client.nom, siret: r.data.client.siret },
    montantCents: Number(r.montant_cents),
  }));
}

export interface Creance {
  id: string;
  numero: string;
  client: string;
  date: string;
  echeance: string | null;
  ttcCents: number;
  resteCents: number;
  retardJours: number;
}

/** Factures et acomptes émis non soldés (reste dû = TTC − avoirs − paiements), à la date `au`. */
export async function creances(tx: Tx, au = new Date().toISOString().slice(0, 10)): Promise<Creance[]> {
  const rows = await tx<{ id: string; numero: string; data: Document; ttc: string; reste: string }[]>`
    SELECT d.id, d.numero, d.data, d.ttc_cents AS ttc,
      d.ttc_cents
        - (SELECT coalesce(sum(a.ttc_cents), 0) FROM document a
           WHERE a.tenant_id = d.tenant_id AND a.type = 'avoir' AND a.numero IS NOT NULL AND a.data ->> 'origine' = d.numero)
        - (SELECT coalesce(sum(p.montant_cents), 0) FROM paiement p WHERE p.tenant_id = d.tenant_id AND p.document_id = d.id)
        AS reste
    FROM document d
    WHERE d.numero IS NOT NULL AND d.type IN ('facture', 'acompte') AND d.statut NOT IN ('paye', 'annule')
    ORDER BY d.data ->> 'echeance' NULLS LAST, d.numero`;
  const jour = Date.parse(`${au}T00:00:00Z`);
  return rows
    .map((r) => {
      const echeance = r.data.echeance ?? null;
      return {
        id: r.id,
        numero: r.numero,
        client: r.data.client.nom,
        date: r.data.date,
        echeance,
        ttcCents: Number(r.ttc),
        resteCents: Number(r.reste),
        retardJours: echeance ? Math.max(0, Math.floor((jour - Date.parse(`${echeance}T00:00:00Z`)) / 86_400_000)) : 0,
      };
    })
    .filter((c) => c.resteCents > 0);
}

// Clients et produits enregistrés, paiements (reste dû, statut payé) et relances d'impayés.
import type { Partie, Tva } from "@auto/domain";
import type { Tx } from "./db";
import { ErreurMetier, journaliser } from "./index";

export interface Client extends Partie {
  id: string;
}

interface ClientRow {
  id: string;
  nom: string;
  siret: string | null;
  adresse: string;
  tva_intracom: string | null;
  email: string | null;
}

const client = (r: ClientRow): Client => ({
  id: r.id,
  nom: r.nom,
  siret: r.siret ?? "",
  adresse: r.adresse,
  tvaIntracom: r.tva_intracom ?? undefined,
  email: r.email ?? undefined,
});

function controlerPartie(p: Partial<Partie>) {
  if (!p.nom?.trim() || !p.adresse?.trim()) throw new ErreurMetier("client : nom et adresse obligatoires");
}

export async function creerClient(tx: Tx, actor: string | null, p: Partie): Promise<Client> {
  controlerPartie(p);
  const [r] = await tx<ClientRow[]>`
    INSERT INTO client (nom, siret, adresse, tva_intracom, email)
    VALUES (${p.nom.trim()}, ${p.siret || null}, ${p.adresse.trim()}, ${p.tvaIntracom ?? null}, ${p.email ?? null})
    RETURNING *`;
  await journaliser(tx, actor, "client.creer", r!.id);
  return client(r!);
}

export async function modifierClient(tx: Tx, actor: string | null, id: string, p: Partie): Promise<Client> {
  controlerPartie(p);
  const [r] = await tx<ClientRow[]>`
    UPDATE client SET nom = ${p.nom.trim()}, siret = ${p.siret || null}, adresse = ${p.adresse.trim()},
      tva_intracom = ${p.tvaIntracom ?? null}, email = ${p.email ?? null}
    WHERE id = ${id} RETURNING *`;
  if (!r) throw new ErreurMetier("client introuvable", [], 404);
  await journaliser(tx, actor, "client.modifier", id);
  return client(r);
}

export async function lireClient(tx: Tx, id: string): Promise<Client | null> {
  const [r] = await tx<ClientRow[]>`SELECT * FROM client WHERE id = ${id}`;
  return r ? client(r) : null;
}

export async function listerClients(tx: Tx, recherche?: string): Promise<Client[]> {
  const rows = recherche
    ? await tx<ClientRow[]>`SELECT * FROM client WHERE nom ILIKE ${`%${recherche}%`} OR siret LIKE ${`${recherche}%`}
        ORDER BY nom LIMIT 100`
    : await tx<ClientRow[]>`SELECT * FROM client ORDER BY nom LIMIT 500`;
  return rows.map(client);
}

export interface Produit {
  id: string;
  designation: string;
  prixUnitaireHtCents: number;
  tva: Tva;
  unite?: string;
}

interface ProduitRow {
  id: string;
  designation: string;
  prix_ht_cents: string;
  tva: number;
  unite: string | null;
}

const produit = (r: ProduitRow): Produit => ({
  id: r.id,
  designation: r.designation,
  prixUnitaireHtCents: Number(r.prix_ht_cents),
  tva: r.tva as Tva,
  unite: r.unite ?? undefined,
});

export async function creerProduit(tx: Tx, actor: string | null, p: Omit<Produit, "id">): Promise<Produit> {
  if (!p.designation?.trim() || !Number.isInteger(p.prixUnitaireHtCents))
    throw new ErreurMetier("produit : désignation et prix entier en centimes obligatoires");
  const [r] = await tx<ProduitRow[]>`
    INSERT INTO produit (designation, prix_ht_cents, tva, unite)
    VALUES (${p.designation.trim()}, ${p.prixUnitaireHtCents}, ${p.tva}, ${p.unite ?? null}) RETURNING *`;
  await journaliser(tx, actor, "produit.creer", r!.id);
  return produit(r!);
}

export async function listerProduits(tx: Tx): Promise<Produit[]> {
  return (await tx<ProduitRow[]>`SELECT * FROM produit ORDER BY designation LIMIT 1000`).map(produit);
}

// Paiements ------------------------------------------------------------------------------------

export type ModePaiement = "virement" | "carte" | "cheque" | "especes" | "prelevement" | "autre";
const MODES: ModePaiement[] = ["virement", "carte", "cheque", "especes", "prelevement", "autre"];

export interface Paiement {
  id: string;
  documentId: string;
  date: string;
  montantCents: number;
  mode: ModePaiement;
  reference: string | null;
}

interface PaiementRow {
  id: string;
  document_id: string;
  date: Date;
  montant_cents: string;
  mode: ModePaiement;
  reference: string | null;
}

const paiement = (r: PaiementRow): Paiement => ({
  id: r.id,
  documentId: r.document_id,
  date: r.date.toISOString().slice(0, 10),
  montantCents: Number(r.montant_cents),
  mode: r.mode,
  reference: r.reference,
});

/** TTC de la facture − avoirs émis − paiements reçus. */
export async function resteDu(tx: Tx, documentId: string): Promise<{ ttcCents: number; resteCents: number }> {
  const [r] = await tx<{ ttc: string; avoirs: string; payes: string }[]>`
    SELECT d.ttc_cents AS ttc,
      (SELECT coalesce(sum(a.ttc_cents), 0) FROM document a
        WHERE a.type = 'avoir' AND a.statut <> 'brouillon' AND a.data ->> 'origine' = d.numero) AS avoirs,
      (SELECT coalesce(sum(p.montant_cents), 0) FROM paiement p WHERE p.document_id = d.id) AS payes
    FROM document d WHERE d.id = ${documentId}`;
  if (!r) throw new ErreurMetier("document introuvable", [], 404);
  return { ttcCents: Number(r.ttc), resteCents: Number(r.ttc) - Number(r.avoirs) - Number(r.payes) };
}

/** Enregistre un paiement ; la facture soldée passe au statut payé. */
export async function enregistrerPaiement(
  tx: Tx,
  actor: string | null,
  documentId: string,
  p: { date: string; montantCents: number; mode: ModePaiement; reference?: string },
): Promise<{ paiement: Paiement; resteCents: number }> {
  if (!Number.isInteger(p.montantCents) || p.montantCents <= 0)
    throw new ErreurMetier("paiement : montant entier positif en centimes");
  if (!MODES.includes(p.mode)) throw new ErreurMetier("paiement : mode invalide", MODES);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new ErreurMetier("paiement : date AAAA-MM-JJ");
  const [d] = await tx<{ type: string; statut: string }[]>`
    SELECT type, statut FROM document WHERE id = ${documentId} FOR UPDATE`;
  if (!d) throw new ErreurMetier("document introuvable", [], 404);
  if (!["facture", "acompte"].includes(d.type)) throw new ErreurMetier("paiement : seulement sur une facture", [], 409);
  if (["brouillon", "annule", "paye", "rejete"].includes(d.statut))
    throw new ErreurMetier(`paiement impossible sur un document ${d.statut}`, [], 409);
  const { resteCents } = await resteDu(tx, documentId);
  if (p.montantCents > resteCents)
    throw new ErreurMetier("paiement supérieur au reste dû", [`reste ${resteCents} centimes`], 409);
  const [r] = await tx<PaiementRow[]>`
    INSERT INTO paiement (document_id, date, montant_cents, mode, reference)
    VALUES (${documentId}, ${p.date}, ${p.montantCents}, ${p.mode}, ${p.reference ?? null}) RETURNING *`;
  const reste = resteCents - p.montantCents;
  if (reste === 0) await tx`UPDATE document SET statut = 'paye', updated_at = now() WHERE id = ${documentId}`;
  await journaliser(tx, actor, "paiement.enregistrer", documentId, { montantCents: p.montantCents, reste });
  return { paiement: paiement(r!), resteCents: reste };
}

export async function listerPaiements(tx: Tx, documentId: string): Promise<Paiement[]> {
  return (
    await tx<PaiementRow[]>`SELECT * FROM paiement WHERE document_id = ${documentId} ORDER BY date, created_at`
  ).map(paiement);
}

// Relances -------------------------------------------------------------------------------------

/** Paliers de relance en jours de retard après l'échéance. */
export const PALIERS = [7, 30, 60] as const;

export interface ARelancer {
  documentId: string;
  numero: string;
  client: Partie;
  echeance: string;
  joursRetard: number;
  niveau: 1 | 2 | 3;
  resteCents: number;
}

/** Factures échues non soldées dont le palier de relance atteint n'a pas encore été envoyé. */
export async function aRelancer(tx: Tx, aujourdhui: string): Promise<ARelancer[]> {
  const rows = await tx<
    { id: string; numero: string; data: { client: Partie; echeance: string }; niveau_max: number }[]
  >`
    SELECT d.id, d.numero, d.data, coalesce((SELECT max(niveau) FROM relance r WHERE r.document_id = d.id), 0) AS niveau_max
    FROM document d
    WHERE d.type IN ('facture', 'acompte') AND d.statut IN ('emis', 'envoye', 'depose')
      AND (d.data ->> 'echeance')::date < ${aujourdhui}::date
    ORDER BY (d.data ->> 'echeance')::date`;
  const jour = Date.parse(`${aujourdhui}T00:00:00Z`);
  const out: ARelancer[] = [];
  for (const r of rows) {
    const joursRetard = Math.round((jour - Date.parse(`${r.data.echeance}T00:00:00Z`)) / 86_400_000);
    const niveau = PALIERS.filter((p) => joursRetard >= p).length as 0 | 1 | 2 | 3;
    if (niveau === 0 || niveau <= Number(r.niveau_max)) continue;
    const { resteCents } = await resteDu(tx, r.id);
    if (resteCents <= 0) continue;
    out.push({
      documentId: r.id,
      numero: r.numero,
      client: r.data.client,
      echeance: r.data.echeance,
      joursRetard,
      niveau,
      resteCents,
    });
  }
  return out;
}

export async function marquerRelance(
  tx: Tx,
  actor: string | null,
  documentId: string,
  niveau: 1 | 2 | 3,
  canal: "mail" | "courrier" | "telephone",
) {
  await tx`INSERT INTO relance (document_id, niveau, canal) VALUES (${documentId}, ${niveau}, ${canal})`;
  await journaliser(tx, actor, "relance.envoyer", documentId, { niveau, canal });
}

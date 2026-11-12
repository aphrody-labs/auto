// Lot ingest : factures fournisseurs reçues et leur fichier d'origine (voir docs/ARCHITECTURE.md).
import type { FactureRecue, Resultat, StatutRecue } from "@auto/ingest";
import type { Tx } from "./db";
import { ErreurMetier, journaliser } from "./index";
import { conserverFichier } from "./arrivages";

export type Canal = "api" | "mail" | "pa";

export interface Recue {
  id: string;
  fichierId: string;
  canal: Canal;
  source: Resultat["source"];
  statut: StatutRecue;
  facture: FactureRecue | null;
  anomalies: string[];
  fournisseur: string | null;
  siren: string | null;
  numero: string | null;
  date: string | null;
  echeance: string | null;
  ttcCents: number | null;
  motif: string | null;
  decideAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  fichier_id: string;
  canal: Canal;
  source: Resultat["source"];
  statut: StatutRecue;
  data: FactureRecue | null;
  anomalies: string[];
  fournisseur: string | null;
  siren: string | null;
  numero: string | null;
  date_facture: Date | null;
  echeance: Date | null;
  ttc_cents: string | null;
  motif: string | null;
  decide_at: Date | null;
  created_at: Date;
}

const jour = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const recue = (r: Row): Recue => ({
  id: r.id,
  fichierId: r.fichier_id,
  canal: r.canal,
  source: r.source,
  statut: r.statut,
  facture: r.data,
  anomalies: r.anomalies,
  fournisseur: r.fournisseur,
  siren: r.siren,
  numero: r.numero,
  date: jour(r.date_facture),
  echeance: jour(r.echeance),
  ttcCents: r.ttc_cents === null ? null : Number(r.ttc_cents),
  motif: r.motif,
  decideAt: r.decide_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** Lecture groupée du dossier analytique, sans limite de liste globale. */
export async function achatsChantier(tx: Tx, chantierId: string): Promise<(Recue & { fournisseurId: string })[]> {
  const rows = await tx<(Row & { fournisseur_id: string })[]>`SELECT f.*, a.fournisseur_id FROM facture_recue f
    JOIN achat_affectation a ON a.tenant_id=f.tenant_id AND a.recue_id=f.id
    WHERE a.chantier_id=${chantierId} ORDER BY f.created_at DESC`;
  return rows.map((r) => ({ ...recue(r), fournisseurId: r.fournisseur_id }));
}

export async function achatsFournisseur(
  tx: Tx,
  fournisseurId: string,
): Promise<(Recue & { chantierId: string | null })[]> {
  const rows = await tx<(Row & { chantier_id: string | null })[]>`SELECT f.*, a.chantier_id FROM facture_recue f
    JOIN achat_affectation a ON a.tenant_id=f.tenant_id AND a.recue_id=f.id
    WHERE a.fournisseur_id=${fournisseurId} ORDER BY f.created_at DESC`;
  return rows.map((r) => ({ ...recue(r), chantierId: r.chantier_id }));
}
const dateOk = (d: string | undefined) =>
  d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;

/** Bun.sql : JSON explicite (un tableau JS serait lu comme un tableau Postgres). */
const jsonb = (v: unknown) => (v == null ? null : JSON.stringify(v));

/** Colonnes de recherche dérivées de la facture normalisée. */
const colonnes = (f: FactureRecue | null) => ({
  fournisseur: f?.fournisseur?.nom ?? null,
  siren: f?.fournisseur?.siren ?? f?.fournisseur?.siret?.slice(0, 9) ?? null,
  numero: f?.numero ?? null,
  date_facture: dateOk(f?.date),
  echeance: dateOk(f?.echeance),
  ttc_cents: f?.totaux?.ttcCents ?? null,
});

export const empreinteSha256 = (o: Uint8Array) => new Bun.CryptoHasher("sha256").update(o).digest("hex");

/** Facture déjà reçue avec le même fichier (même SHA-256) dans ce tenant. */
export async function recueParFichier(tx: Tx, empreinte: string): Promise<Recue | null> {
  const [r] = await tx<Row[]>`
    SELECT f.* FROM facture_recue f JOIN fichier_recu x ON x.tenant_id = f.tenant_id AND x.id = f.fichier_id
    WHERE x.sha256 = ${empreinte}`;
  return r ? recue(r) : null;
}

export interface FichierEntrant {
  contenu: Uint8Array;
  nom?: string;
  typeMime: string;
  canal: Canal;
}

export async function enregistrerRecue(tx: Tx, actor: string | null, e: FichierEntrant, r: Resultat): Promise<Recue> {
  const fichierId = await conserverFichier(tx, e);
  const c = colonnes(r.facture);
  const [row] = await tx<Row[]>`
    INSERT INTO facture_recue (fichier_id, canal, source, statut, data, anomalies, fournisseur, siren, numero,
      date_facture, echeance, ttc_cents)
    VALUES (${fichierId}, ${e.canal}, ${r.source}, ${r.statut}, ${jsonb(r.facture)}::text::jsonb, ${JSON.stringify(r.anomalies)}::text::jsonb, ${c.fournisseur}, ${c.siren},
      ${c.numero}, ${c.date_facture}, ${c.echeance}, ${c.ttc_cents})
    RETURNING *`;
  await journaliser(tx, actor, "facture_recue.deposer", row!.id, {
    canal: e.canal,
    source: r.source,
    statut: r.statut,
  });
  return recue(row!);
}

export async function listerRecues(tx: Tx, o: { statut?: StatutRecue } = {}): Promise<Recue[]> {
  const rows = o.statut
    ? await tx<Row[]>`SELECT * FROM facture_recue WHERE statut = ${o.statut} ORDER BY created_at DESC`
    : await tx<Row[]>`SELECT * FROM facture_recue ORDER BY created_at DESC`;
  return rows.map(recue);
}

export async function lireRecue(tx: Tx, id: string): Promise<Recue | null> {
  if (!UUID.test(id)) return null;
  const [r] = await tx<Row[]>`SELECT * FROM facture_recue WHERE id = ${id}`;
  return r ? recue(r) : null;
}

export async function lireFichierRecu(tx: Tx, id: string) {
  if (!UUID.test(id)) return null;
  const [r] = await tx<{ nom: string | null; type_mime: string; sha256: string; contenu: Uint8Array<ArrayBuffer> }[]>`
    SELECT x.nom, x.type_mime, x.sha256, x.contenu FROM facture_recue f
    JOIN fichier_recu x ON x.tenant_id = f.tenant_id AND x.id = f.fichier_id WHERE f.id = ${id}`;
  return r ? { nom: r.nom, typeMime: r.type_mime, sha256: r.sha256, contenu: r.contenu } : null;
}

export interface Decision {
  statut: Exclude<StatutRecue, "a_verifier">;
  /** Facture corrigée à la main (remplace l'extraction). */
  facture?: FactureRecue;
  /** Anomalies restantes après correction (recalculées par l'appelant). */
  anomalies?: string[];
  motif?: string;
}

/** Validation ou rejet manuel. Une facture rejetée ne change plus. */
export async function deciderRecue(tx: Tx, actor: string, id: string, d: Decision): Promise<Recue> {
  const avant = await lireRecue(tx, id);
  if (!avant) throw new ErreurMetier("facture reçue introuvable", [], 404);
  if (avant.statut === "rejetee") throw new ErreurMetier("facture reçue déjà rejetée", [], 409);
  const f = d.facture ?? avant.facture;
  if (d.statut === "validee" && !f) throw new ErreurMetier("facture à compléter avant validation (champ facture)");
  const c = colonnes(f);
  const [r] = await tx<Row[]>`
    UPDATE facture_recue SET statut = ${d.statut}, data = ${jsonb(f)}::text::jsonb, anomalies = ${JSON.stringify(d.anomalies ?? avant.anomalies)}::text::jsonb,
      fournisseur = ${c.fournisseur}, siren = ${c.siren}, numero = ${c.numero}, date_facture = ${c.date_facture},
      echeance = ${c.echeance}, ttc_cents = ${c.ttc_cents}, motif = ${d.motif ?? null},
      decide_par = ${actor}, decide_at = now()
    WHERE id = ${id} RETURNING *`;
  await journaliser(tx, actor, `facture_recue.${d.statut === "validee" ? "valider" : "rejeter"}`, id, {
    corrigee: Boolean(d.facture),
    motif: d.motif ?? null,
  });
  return recue(r!);
}

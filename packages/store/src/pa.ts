// Lot pa : stockage des connexions aux plateformes agréées, dépôts, statuts, factures reçues et
// e-reporting (migration 008). Toutes les fonctions s'exécutent sous withTenant (RLS).
import type { Tx } from "./db";
import { journaliser } from "./index";

export interface ConnexionPa {
  plateforme: string;
  identifiants: Uint8Array;
  mandat: unknown;
  mandatReference: string;
  connecteLe: string;
}

export async function lireConnexionPa(tx: Tx): Promise<ConnexionPa | null> {
  const [r] = await tx<
    { plateforme: string; identifiants: Uint8Array; mandat: unknown; mandat_reference: string; created_at: Date }[]
  >`SELECT plateforme, identifiants, mandat, mandat_reference, created_at FROM pa_connexion`;
  return r
    ? {
        plateforme: r.plateforme,
        identifiants: new Uint8Array(r.identifiants),
        mandat: r.mandat,
        mandatReference: r.mandat_reference,
        connecteLe: r.created_at.toISOString(),
      }
    : null;
}

/** Connecte (ou remplace) la PA du tenant courant. */
export async function connecterPa(
  tx: Tx,
  actor: string | null,
  c: { plateforme: string; identifiants: Uint8Array; mandat: object; mandatReference: string },
): Promise<void> {
  await tx`DELETE FROM pa_connexion`;
  await tx`INSERT INTO pa_connexion (plateforme, identifiants, mandat, mandat_reference, connecte_par)
    VALUES (${c.plateforme}, ${c.identifiants}, ${c.mandat}, ${c.mandatReference}, ${actor})`;
  await journaliser(tx, actor, "pa.connecter", c.mandatReference, { plateforme: c.plateforme, mandat: c.mandat });
}

export async function deconnecterPa(tx: Tx, actor: string | null): Promise<boolean> {
  const r = await tx`DELETE FROM pa_connexion RETURNING plateforme`;
  if (r.length) await journaliser(tx, actor, "pa.deconnecter", null, { plateforme: r[0].plateforme });
  return r.length > 0;
}

export interface DepotPa {
  id: string;
  documentId: string;
  numero: string | null;
  plateforme: string;
  idPa: string;
  sha256: string;
  statut: string;
  createdAt: string;
  updatedAt: string;
}

interface RowDepot {
  id: string;
  document_id: string;
  numero: string | null;
  plateforme: string;
  id_pa: string;
  sha256: string;
  statut: string;
  created_at: Date;
  updated_at: Date;
}

const depot = (r: RowDepot): DepotPa => ({
  id: r.id,
  documentId: r.document_id,
  numero: r.numero,
  plateforme: r.plateforme,
  idPa: r.id_pa,
  sha256: r.sha256,
  statut: r.statut,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export interface StatutPa {
  statut: string;
  code: number;
  motif?: string | null;
  source: "depot" | "webhook" | "synchro" | "vendeur";
  at: string;
}

/** Dépôt vivant (non rejeté) d'un document, verrouillé. */
export async function depotActif(tx: Tx, documentId: string): Promise<DepotPa | null> {
  const [r] = await tx<RowDepot[]>`
    SELECT p.*, d.numero FROM pa_depot p JOIN document d ON d.id = p.document_id
    WHERE p.document_id = ${documentId} AND p.statut <> 'rejetee' FOR UPDATE OF p`;
  return r ? depot(r) : null;
}

export async function creerDepot(
  tx: Tx,
  actor: string | null,
  d: { documentId: string; plateforme: string; idPa: string; sha256: string; premier: StatutPa },
): Promise<DepotPa> {
  const [{ id }] = (await tx<{ id: string }[]>`
    INSERT INTO pa_depot (document_id, plateforme, id_pa, sha256, statut)
    VALUES (${d.documentId}, ${d.plateforme}, ${d.idPa}, ${d.sha256}, ${d.premier.statut}) RETURNING id`) as unknown as [
    { id: string },
  ];
  await ajouterStatut(tx, id, d.premier);
  await journaliser(tx, actor, "pa.deposer", d.documentId, {
    idPa: d.idPa,
    plateforme: d.plateforme,
    sha256: d.sha256,
  });
  return (await lireDepot(tx, id))!;
}

export async function lireDepot(tx: Tx, id: string): Promise<DepotPa | null> {
  const [r] = await tx<RowDepot[]>`
    SELECT p.*, d.numero FROM pa_depot p JOIN document d ON d.id = p.document_id WHERE p.id = ${id}`;
  return r ? depot(r) : null;
}

export async function depotParIdPa(tx: Tx, plateforme: string, idPa: string): Promise<DepotPa | null> {
  const [r] = await tx<RowDepot[]>`
    SELECT p.*, d.numero FROM pa_depot p JOIN document d ON d.id = p.document_id
    WHERE p.plateforme = ${plateforme} AND p.id_pa = ${idPa} FOR UPDATE OF p`;
  return r ? depot(r) : null;
}

export async function listerDepots(tx: Tx, limite = 100): Promise<DepotPa[]> {
  const rows = await tx<RowDepot[]>`
    SELECT p.*, d.numero FROM pa_depot p JOIN document d ON d.id = p.document_id
    ORDER BY p.created_at DESC LIMIT ${limite}`;
  return rows.map(depot);
}

/**
 * Ajoute un statut (idempotent sur statut + horodatage) et recalcule le statut courant du dépôt :
 * le plus récent. Renvoie false si le statut était déjà connu.
 */
export async function ajouterStatut(tx: Tx, depotId: string, s: StatutPa): Promise<boolean> {
  const r = await tx`
    INSERT INTO pa_statut (depot_id, statut, code, motif, source, at)
    VALUES (${depotId}, ${s.statut}, ${s.code}, ${s.motif ?? null}, ${s.source}, ${s.at})
    ON CONFLICT (tenant_id, depot_id, statut, at) DO NOTHING RETURNING id`;
  if (!r.length) return false;
  await tx`UPDATE pa_depot SET updated_at = now(), statut = (
      SELECT statut FROM pa_statut WHERE depot_id = ${depotId} ORDER BY at DESC, id DESC LIMIT 1)
    WHERE id = ${depotId}`;
  return true;
}

export async function statutsDepot(tx: Tx, depotId: string): Promise<StatutPa[]> {
  const rows = await tx<
    { statut: string; code: number; motif: string | null; source: StatutPa["source"]; at: Date }[]
  >`SELECT statut, code, motif, source, at FROM pa_statut WHERE depot_id = ${depotId} ORDER BY at, id`;
  return rows.map((r) => ({
    statut: r.statut,
    code: r.code,
    motif: r.motif,
    source: r.source,
    at: r.at.toISOString(),
  }));
}

/** Dépôts dont le cycle n'est pas terminé (à synchroniser). */
export async function depotsEnCours(tx: Tx): Promise<DepotPa[]> {
  const rows = await tx<RowDepot[]>`
    SELECT p.*, d.numero FROM pa_depot p JOIN document d ON d.id = p.document_id
    WHERE p.statut NOT IN ('rejetee', 'refusee', 'encaissee')`;
  return rows.map(depot);
}

export interface RecuePa {
  id: string;
  plateforme: string;
  idPa: string;
  sha256: string;
  taille: number;
  numero: string | null;
  emetteur: string | null;
  ttcCents: number | null;
  recueAt: string;
  createdAt: string;
}

interface RowRecue {
  id: string;
  plateforme: string;
  id_pa: string;
  sha256: string;
  taille: number;
  numero: string | null;
  emetteur: string | null;
  ttc_cents: string | number | null;
  recue_at: Date;
  created_at: Date;
}

const recue = (r: RowRecue): RecuePa => ({
  id: r.id,
  plateforme: r.plateforme,
  idPa: r.id_pa,
  sha256: r.sha256,
  taille: r.taille,
  numero: r.numero,
  emetteur: r.emetteur,
  ttcCents: r.ttc_cents === null ? null : Number(r.ttc_cents),
  recueAt: r.recue_at.toISOString(),
  createdAt: r.created_at.toISOString(),
});

export const recueConnue = async (tx: Tx, plateforme: string, idPa: string) =>
  (await tx`SELECT 1 FROM pa_recue WHERE plateforme = ${plateforme} AND id_pa = ${idPa}`).length > 0;

/** Enregistre une facture reçue ; null si elle l'était déjà. */
export async function enregistrerRecuePa(
  tx: Tx,
  actor: string | null,
  r: {
    plateforme: string;
    idPa: string;
    contenu: Uint8Array;
    xml: string | null;
    numero: string | null;
    emetteur: string | null;
    ttcCents: number | null;
    recueAt: string;
  },
): Promise<RecuePa | null> {
  const sha256 = new Bun.CryptoHasher("sha256").update(r.contenu).digest("hex");
  const [row] = await tx<RowRecue[]>`
    INSERT INTO pa_recue (plateforme, id_pa, sha256, taille, contenu, xml, numero, emetteur, ttc_cents, recue_at)
    VALUES (${r.plateforme}, ${r.idPa}, ${sha256}, ${r.contenu.length}, ${r.contenu}, ${r.xml}, ${r.numero},
      ${r.emetteur}, ${r.ttcCents}, ${r.recueAt})
    ON CONFLICT (tenant_id, plateforme, id_pa) DO NOTHING
    RETURNING id, plateforme, id_pa, sha256, taille, numero, emetteur, ttc_cents, recue_at, created_at`;
  if (!row) return null;
  await journaliser(tx, actor, "pa.recevoir", row.id, { idPa: r.idPa, plateforme: r.plateforme, sha256 });
  return recue(row);
}

export async function listerRecuesPa(tx: Tx, limite = 100): Promise<RecuePa[]> {
  const rows = await tx<RowRecue[]>`
    SELECT id, plateforme, id_pa, sha256, taille, numero, emetteur, ttc_cents, recue_at, created_at
    FROM pa_recue ORDER BY created_at DESC LIMIT ${limite}`;
  return rows.map(recue);
}

export async function lireRecuePa(
  tx: Tx,
  id: string,
): Promise<(RecuePa & { xml: string | null; contenu: Uint8Array<ArrayBuffer> }) | null> {
  const [r] = await tx<(RowRecue & { xml: string | null; contenu: Uint8Array })[]>`
    SELECT id, plateforme, id_pa, sha256, taille, numero, emetteur, ttc_cents, recue_at, created_at, xml, contenu
    FROM pa_recue WHERE id = ${id}`;
  return r ? { ...recue(r), xml: r.xml, contenu: new Uint8Array(r.contenu) } : null;
}

export interface EreportingPa {
  id: string;
  plateforme: string;
  idPa: string;
  nature: string;
  periode: string;
  statut: string;
  data: unknown;
  createdAt: string;
}

export async function enregistrerEreporting(
  tx: Tx,
  actor: string | null,
  e: { plateforme: string; idPa: string; nature: string; periode: string; statut: string; data: object },
): Promise<EreportingPa> {
  const [r] = await tx<{ id: string; created_at: Date }[]>`
    INSERT INTO pa_ereporting (plateforme, id_pa, nature, periode, statut, data)
    VALUES (${e.plateforme}, ${e.idPa}, ${e.nature}, ${e.periode}, ${e.statut}, ${e.data}) RETURNING id, created_at`;
  await journaliser(tx, actor, "pa.ereporting", r!.id, { nature: e.nature, periode: e.periode, idPa: e.idPa });
  return { id: r!.id, ...e, createdAt: r!.created_at.toISOString() };
}

export async function listerEreporting(tx: Tx): Promise<EreportingPa[]> {
  const rows = await tx<
    {
      id: string;
      plateforme: string;
      id_pa: string;
      nature: string;
      periode: string;
      statut: string;
      data: unknown;
      created_at: Date;
    }[]
  >`SELECT * FROM pa_ereporting ORDER BY created_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    plateforme: r.plateforme,
    idPa: r.id_pa,
    nature: r.nature,
    periode: r.periode,
    statut: r.statut,
    data: r.data,
    createdAt: r.created_at.toISOString(),
  }));
}

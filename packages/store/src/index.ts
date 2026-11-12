import { numero, serie, totaux, verifier, type Document, type Statut, type Type } from "@auto/domain";
import type { Tx } from "./db";

export { connect, connectMigrations, DEFAULT_URL, migrate, testDb, withTenant, type Sql, type Tx } from "./db";
export * from "./gestion";
export * from "./chantiers";
export * from "./recherche-gestion";
export * from "./arrivages";
export * from "./sources-fichiers";
export * from "./atelier";
export * from "./rh";
export * from "./outbox";
export * from "./comptes";
export * from "./imports";
export * from "./pa";
export * from "./mail";
export * from "./ingest";
export * from "./abonnement";
export * from "./conformite";
export * from "./gabarit";
export * from "./webhooks";
export * from "./encaissement";
export * from "./automatisations";
export * from "./connaissance";

export interface Ligne {
  id: string;
  type: Type;
  statut: Statut;
  numero: string | null;
  data: Document;
  htCents: number;
  tvaCents: number;
  ttcCents: number;
  emisAt: string | null;
  createdAt: string;
  clientId: string | null;
}

interface Row {
  id: string;
  type: Type;
  statut: Statut;
  numero: string | null;
  data: Document;
  ht_cents: string | number;
  tva_cents: string | number;
  ttc_cents: string | number;
  emis_at: Date | null;
  created_at: Date;
  client_id: string | null;
}

const ligne = (r: Row): Ligne => ({
  id: r.id,
  type: r.type,
  statut: r.statut,
  numero: r.numero,
  data: r.data,
  htCents: Number(r.ht_cents),
  tvaCents: Number(r.tva_cents),
  ttcCents: Number(r.ttc_cents),
  emisAt: r.emis_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  clientId: r.client_id,
});

export class ErreurMetier extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    readonly status = 422,
  ) {
    super(message);
  }
}

export async function journaliser(
  tx: Tx,
  actor: string | null,
  action: string,
  ref: string | null,
  payload: object = {},
) {
  await tx`INSERT INTO audit (actor, action, ref, payload) VALUES (${actor}, ${action}, ${ref}, ${payload})`;
}

/** Crée un brouillon (sans numéro). */
export async function creerBrouillon(
  tx: Tx,
  actor: string | null,
  doc: Document,
  clientId: string | null = null,
): Promise<Ligne> {
  const t = totaux(doc.lignes);
  const [r] = await tx<Row[]>`
    INSERT INTO document (type, data, ht_cents, tva_cents, ttc_cents, client_id)
    VALUES (${doc.type}, ${doc}, ${t.htCents}, ${t.tvaCents}, ${t.ttcCents}, ${clientId}) RETURNING *`;
  await journaliser(tx, actor, "document.creer", r!.id, { type: doc.type });
  return ligne(r!);
}

/** Remplace le contenu d'un brouillon. */
export async function modifierBrouillon(
  tx: Tx,
  actor: string | null,
  id: string,
  doc: Document,
  clientId: string | null = null,
): Promise<Ligne> {
  const t = totaux(doc.lignes);
  const [r] = await tx<Row[]>`
    UPDATE document SET data = ${doc}, type = ${doc.type}, ht_cents = ${t.htCents}, tva_cents = ${t.tvaCents},
      ttc_cents = ${t.ttcCents}, client_id = ${clientId}, updated_at = now()
    WHERE id = ${id} AND statut = 'brouillon' RETURNING *`;
  if (!r) throw new ErreurMetier("brouillon introuvable", [], 404);
  await journaliser(tx, actor, "document.modifier", id);
  return ligne(r);
}

/**
 * Émet un brouillon : contrôle des mentions, attribution du numéro suivant de la série
 * (compteur verrouillé dans la même transaction, donc sans trou ni doublon), document figé.
 */
export async function emettre(tx: Tx, actor: string | null, id: string): Promise<Ligne> {
  const [cur] = await tx<Row[]>`SELECT * FROM document WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw new ErreurMetier("document introuvable", [], 404);
  if (cur.statut !== "brouillon") throw new ErreurMetier("document déjà émis", [], 409);
  const erreurs = verifier(cur.data);
  if (erreurs.length) throw new ErreurMetier("mentions obligatoires manquantes", erreurs);
  if (cur.type === "avoir") await controlerAvoir(tx, cur.data.origine!, Number(cur.ttc_cents));
  const s = serie(cur.type);
  const annee = new Date(cur.data.date).getFullYear();
  const [{ seq }] = (await tx<{ seq: number }[]>`
    INSERT INTO compteur (serie, annee, seq) VALUES (${s}, ${annee}, 1)
    ON CONFLICT (tenant_id, serie, annee) DO UPDATE SET seq = compteur.seq + 1
    RETURNING seq`) as unknown as [{ seq: number }];
  const num = numero(cur.type, annee, seq);
  const [r] = await tx<Row[]>`
    UPDATE document SET statut = 'emis', numero = ${num}, serie = ${s}, annee = ${annee}, seq = ${seq},
      emis_at = now(), updated_at = now()
    WHERE id = ${id} RETURNING *`;
  await journaliser(tx, actor, "document.emettre", id, { numero: num, ttcCents: Number(cur.ttc_cents) });
  return ligne(r!);
}

/**
 * Un avoir rectifie une facture ou un acompte émis du même tenant ; le cumul des avoirs émis
 * sur une facture ne dépasse pas son TTC.
 */
async function controlerAvoir(tx: Tx, origine: string, ttcCents: number) {
  const [f] = await tx<{ id: string; ttc_cents: string; statut: Statut }[]>`
    SELECT id, ttc_cents, statut FROM document
    WHERE numero = ${origine} AND type IN ('facture', 'acompte') FOR UPDATE`;
  if (!f) throw new ErreurMetier("avoir : facture d'origine introuvable", [origine]);
  if (f.statut === "annule") throw new ErreurMetier("avoir : facture d'origine déjà annulée", [origine], 409);
  const [{ deja }] = (await tx<{ deja: string }[]>`
    SELECT coalesce(sum(ttc_cents), 0) AS deja FROM document
    WHERE type = 'avoir' AND statut <> 'brouillon' AND data ->> 'origine' = ${origine}`) as unknown as [
    { deja: string },
  ];
  const reste = Number(f.ttc_cents) - Number(deja);
  if (ttcCents > reste)
    throw new ErreurMetier("avoir : montant supérieur au reste de la facture", [`reste ${reste} centimes`], 409);
  // Avoir soldant une facture non payée : la facture est annulée.
  if (ttcCents === reste && f.statut !== "paye")
    await tx`UPDATE document SET statut = 'annule', updated_at = now() WHERE id = ${f.id}`;
}

const TRANSITIONS: Record<Statut, Statut[]> = {
  brouillon: [],
  emis: ["envoye", "accepte", "refuse", "depose", "paye", "annule"],
  envoye: ["accepte", "refuse", "depose", "paye", "annule"],
  accepte: ["paye"],
  refuse: [],
  depose: ["rejete", "paye"],
  rejete: ["depose"],
  paye: [],
  annule: [],
};

export async function changerStatut(tx: Tx, actor: string | null, id: string, statut: Statut): Promise<Ligne> {
  const [cur] = await tx<Row[]>`SELECT * FROM document WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw new ErreurMetier("document introuvable", [], 404);
  if (!TRANSITIONS[cur.statut].includes(statut))
    throw new ErreurMetier(`transition ${cur.statut} → ${statut} interdite`, [], 409);
  const [r] = await tx<Row[]>`UPDATE document SET statut = ${statut}, updated_at = now() WHERE id = ${id} RETURNING *`;
  await journaliser(tx, actor, "document.statut", id, { de: cur.statut, vers: statut });
  return ligne(r!);
}

export async function supprimerBrouillon(tx: Tx, actor: string | null, id: string): Promise<void> {
  const r = await tx`DELETE FROM document WHERE id = ${id} AND statut = 'brouillon' RETURNING id`;
  if (!r.length) throw new ErreurMetier("brouillon introuvable", [], 404);
  await journaliser(tx, actor, "document.supprimer", id);
}

export async function lire(tx: Tx, id: string): Promise<Ligne | null> {
  const [r] = await tx<Row[]>`SELECT * FROM document WHERE id = ${id}`;
  return r ? ligne(r) : null;
}

export async function lister(tx: Tx, type?: Type, limite = 100): Promise<Ligne[]> {
  const rows = type
    ? await tx<Row[]>`SELECT * FROM document WHERE type = ${type} ORDER BY created_at DESC LIMIT ${limite}`
    : await tx<Row[]>`SELECT * FROM document ORDER BY created_at DESC LIMIT ${limite}`;
  return rows.map(ligne);
}

/** Export de gestion complet ; le plafond des listes d'écran ne tronque pas le classeur. */
export async function documentsGestion(tx: Tx): Promise<Ligne[]> {
  return (await tx<Row[]>`SELECT * FROM document ORDER BY created_at DESC`).map(ligne);
}

/** Lecture groupée du chantier ; les avoirs suivent leur facture, même sans affectation manuelle. */
export async function documentsChantier(tx: Tx, chantierId: string): Promise<Ligne[]> {
  const rows = await tx<Row[]>`SELECT d.* FROM document d WHERE
    (d.type <> 'avoir' AND EXISTS (SELECT 1 FROM chantier_document c WHERE c.tenant_id=d.tenant_id AND c.document_id=d.id AND c.chantier_id=${chantierId}))
    OR (d.type='avoir' AND EXISTS (SELECT 1 FROM document f JOIN chantier_document c ON c.tenant_id=f.tenant_id AND c.document_id=f.id
      WHERE c.chantier_id=${chantierId} AND f.numero=d.data->>'origine' AND f.tenant_id=d.tenant_id))
    ORDER BY d.created_at DESC`;
  return rows.map(ligne);
}

/** Vérifie le chaînage de la piste d'audit du tenant courant. */
export async function verifierAudit(tx: Tx): Promise<{ ok: boolean; entrees: number }> {
  const rows = await tx<{ prev_hash: string; hash: string }[]>`SELECT prev_hash, hash FROM audit ORDER BY id`;
  let prev = "0".repeat(64);
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, entrees: rows.length };
    prev = r.hash;
  }
  return { ok: true, entrees: rows.length };
}

export type TypeFichier = "facturx" | "pdf";

/** Fige l'exemplaire d'un document émis (ajout seul) ; renvoie son SHA-256. */
export async function enregistrerFichier(
  tx: Tx,
  actor: string | null,
  documentId: string,
  kind: TypeFichier,
  contenu: Uint8Array,
): Promise<string> {
  const sha256 = new Bun.CryptoHasher("sha256").update(contenu).digest("hex");
  await tx`INSERT INTO fichier (document_id, kind, sha256, taille, contenu)
    VALUES (${documentId}, ${kind}, ${sha256}, ${contenu.length}, ${contenu})`;
  await journaliser(tx, actor, "fichier.figer", documentId, { kind, sha256 });
  return sha256;
}

export async function lireFichier(
  tx: Tx,
  documentId: string,
  kind: TypeFichier,
): Promise<{ contenu: Uint8Array<ArrayBuffer>; sha256: string } | null> {
  const [r] = await tx<{ contenu: Uint8Array; sha256: string }[]>`
    SELECT contenu, sha256 FROM fichier WHERE document_id = ${documentId} AND kind = ${kind}`;
  return r ? { contenu: new Uint8Array(r.contenu), sha256: r.sha256 } : null;
}
export * from "./courrier";
export * from "./imports-fichiers";

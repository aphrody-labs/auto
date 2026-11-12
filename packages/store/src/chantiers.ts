// Répertoires et affectations analytiques. Les montants réutilisent les centimes et taux de @auto/domain.
import { siretValide, totaux, type Ligne as LigneMetier } from "@auto/domain";
import type { Tx } from "./db";
import { documentsChantier, ErreurMetier, journaliser, lire, type Ligne } from "./index";
import { lireClient } from "./gestion";
import { achatsChantier, achatsFournisseur, lireRecue, type Recue } from "./ingest";

export interface Fournisseur {
  id: string;
  nom: string;
  adresse: string;
  siret: string;
  email: string;
  telephone: string;
  contact: string;
  notes: string;
  archive: boolean;
}
export interface Chantier {
  id: string;
  nom: string;
  code: string;
  clientId: string;
  adresse: string;
  budgetHtCents: number;
  avancement: number;
  statut: "planifie" | "en_cours" | "termine" | "en_pause";
  debut: string | null;
  fin: string | null;
  notes: string;
  archive: boolean;
}
export interface PieceChantier {
  id: string;
  type: "bon_livraison" | "confirmation_commande";
  reference: string;
  fournisseurId: string;
  chantierId: string;
  recueId: string | null;
  date: string;
  statut: "a_verifier" | "valide" | "annule";
  lignes: LigneMetier[];
  notes: string;
  archive: boolean;
}
export interface AffectationAchat {
  recueId: string;
  fournisseurId: string;
  chantierId: string | null;
}
export interface AnalytiqueChantier {
  ventesHtCents: number;
  achatsHtCents: number;
  soldeHtCents: number;
  commandesHtCents: number;
  achatsAffectes: number;
  achatsNonChiffres: number;
}
export interface DossierChantier {
  chantier: Chantier;
  documents: Ligne[];
  achats: (Recue & { fournisseurId: string })[];
  pieces: PieceChantier[];
  analytique: AnalytiqueChantier;
}
export interface DossierFournisseur {
  fournisseur: Fournisseur;
  achats: (Recue & { chantierId: string | null })[];
  pieces: PieceChantier[];
}
export async function dossierFournisseur(tx: Tx, id: string): Promise<DossierFournisseur> {
  const fournisseur = await lireFournisseur(tx, id);
  const achats = await achatsFournisseur(tx, id);
  const pieces = (await tx.unsafe(
    `SELECT ${PIECE} FROM piece_chantier WHERE fournisseur_id=$1 ORDER BY date DESC,created_at DESC`,
    [id],
  )) as PieceChantier[];
  return { fournisseur, achats, pieces };
}
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function identifiant(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new ErreurMetier("identifiant invalide");
  return v;
}
const texte = (v: unknown, nom: string, requis = false): string => {
  if (v === undefined && !requis) return "";
  if (typeof v !== "string" || v.length > 10000 || (requis && !v.trim())) throw new ErreurMetier(`${nom} invalide`);
  return v.trim();
};
function objet(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErreurMetier("objet attendu");
  return v as Record<string, unknown>;
}
function entier(v: unknown, nom: string, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) throw new ErreurMetier(`${nom} invalide`);
  return v;
}
function jour(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw new ErreurMetier("date invalide");
  return v;
}
function booleen(v: unknown) {
  if (v !== undefined && typeof v !== "boolean") throw new ErreurMetier("archive : booléen attendu");
  return v === true;
}
export function verifierFournisseur(v: unknown): Omit<Fournisseur, "id"> {
  const p = objet(v);
  const siret = texte(p.siret, "SIRET").replace(/\s/g, "");
  if (siret && !siretValide(siret)) throw new ErreurMetier("SIRET invalide");
  const email = texte(p.email, "e-mail");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErreurMetier("e-mail invalide");
  return {
    nom: texte(p.nom, "nom", true),
    adresse: texte(p.adresse, "adresse"),
    siret,
    email,
    telephone: texte(p.telephone, "téléphone"),
    contact: texte(p.contact, "contact"),
    notes: texte(p.notes, "notes"),
    archive: booleen(p.archive),
  };
}
export function verifierChantier(v: unknown): Omit<Chantier, "id"> {
  const p = objet(v);
  const debut = jour(p.debut),
    fin = jour(p.fin);
  if (debut && fin && fin < debut) throw new ErreurMetier("fin antérieure au début");
  if (!["planifie", "en_cours", "termine", "en_pause"].includes(p.statut as string))
    throw new ErreurMetier("statut du chantier invalide");
  return {
    nom: texte(p.nom, "nom", true),
    code: texte(p.code, "code analytique", true),
    clientId: identifiant(p.clientId),
    adresse: texte(p.adresse, "adresse"),
    budgetHtCents: entier(p.budgetHtCents, "budget"),
    avancement: entier(p.avancement, "avancement", 100),
    statut: p.statut as Chantier["statut"],
    debut,
    fin,
    notes: texte(p.notes, "notes"),
    archive: booleen(p.archive),
  };
}
export function verifierPiece(v: unknown): Omit<PieceChantier, "id"> {
  const p = objet(v);
  if (!["bon_livraison", "confirmation_commande"].includes(p.type as string))
    throw new ErreurMetier("type de pièce invalide");
  if (!["a_verifier", "valide", "annule"].includes(p.statut as string))
    throw new ErreurMetier("statut de pièce invalide");
  const date = jour(p.date);
  if (!date) throw new ErreurMetier("date obligatoire");
  if (!Array.isArray(p.lignes) || p.lignes.length < 1 || p.lignes.length > 200)
    throw new ErreurMetier("1 à 200 lignes attendues");
  const lignes = p.lignes.map((v) => {
    const l = objet(v);
    if (typeof l.quantite !== "number" || !Number.isFinite(l.quantite) || l.quantite <= 0 || l.quantite > 1e6)
      throw new ErreurMetier("quantité invalide");
    if (![0, 21, 55, 100, 200].includes(l.tva as number)) throw new ErreurMetier("TVA invalide");
    return {
      designation: texte(l.designation, "désignation", true),
      quantite: l.quantite,
      prixUnitaireHtCents: entier(l.prixUnitaireHtCents, "prix", 1e10),
      tva: l.tva as LigneMetier["tva"],
      unite: texte(l.unite, "unité"),
    };
  });
  if (!Number.isSafeInteger(totaux(lignes).ttcCents)) throw new ErreurMetier("montant trop élevé");
  return {
    type: p.type as PieceChantier["type"],
    reference: texte(p.reference, "référence", true),
    fournisseurId: identifiant(p.fournisseurId),
    chantierId: identifiant(p.chantierId),
    recueId: p.recueId ? identifiant(p.recueId) : null,
    date,
    statut: p.statut as PieceChantier["statut"],
    lignes,
    notes: texte(p.notes, "notes"),
    archive: booleen(p.archive),
  };
}
export async function listerFournisseurs(tx: Tx): Promise<Fournisseur[]> {
  return tx<Fournisseur[]>`SELECT * FROM fournisseur ORDER BY archive, nom`;
}
export async function lireFournisseur(tx: Tx, id: string): Promise<Fournisseur> {
  const [f] = await tx<Fournisseur[]>`SELECT * FROM fournisseur WHERE id=${identifiant(id)}`;
  if (!f) throw new ErreurMetier("fournisseur introuvable", [], 404);
  return f;
}
export async function enregistrerFournisseur(
  tx: Tx,
  actor: string | null,
  body: unknown,
  id?: string,
): Promise<Fournisseur> {
  const p = verifierFournisseur(body);
  const rows = id
    ? await tx<
        Fournisseur[]
      >`UPDATE fournisseur SET nom=${p.nom},adresse=${p.adresse},siret=${p.siret},email=${p.email},telephone=${p.telephone},contact=${p.contact},notes=${p.notes},archive=${p.archive} WHERE id=${identifiant(id)} RETURNING *`
    : await tx<
        Fournisseur[]
      >`INSERT INTO fournisseur (nom,adresse,siret,email,telephone,contact,notes,archive) VALUES (${p.nom},${p.adresse},${p.siret},${p.email},${p.telephone},${p.contact},${p.notes},${p.archive}) RETURNING *`;
  if (!rows[0]) throw new ErreurMetier("fournisseur introuvable", [], 404);
  await journaliser(tx, actor, id ? "fournisseur.modifier" : "fournisseur.creer", rows[0].id);
  return rows[0];
}
const CHANTIER = `id, nom, code, client_id AS "clientId", adresse, budget_ht_cents::float8 AS "budgetHtCents", avancement, statut, debut::text, fin::text, notes, archive`;
export async function listerChantiers(tx: Tx): Promise<Chantier[]> {
  return tx.unsafe(`SELECT ${CHANTIER} FROM chantier ORDER BY archive, nom`) as Promise<Chantier[]>;
}
export async function lireChantier(tx: Tx, id: string): Promise<Chantier> {
  const [c] = (await tx.unsafe(`SELECT ${CHANTIER} FROM chantier WHERE id=$1`, [identifiant(id)])) as Chantier[];
  if (!c) throw new ErreurMetier("chantier introuvable", [], 404);
  return c;
}
export async function enregistrerChantier(tx: Tx, actor: string | null, body: unknown, id?: string): Promise<Chantier> {
  const c = verifierChantier(body);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(app_tenant()::text || ':chantier:' || ${c.code}, 0))`;
  if (id) {
    await tx`SELECT id FROM chantier WHERE id=${identifiant(id)} FOR UPDATE`;
    const conflit =
      await tx`SELECT d.id FROM document d JOIN chantier_document h ON h.tenant_id=d.tenant_id AND h.document_id=d.id
      WHERE h.chantier_id=${id} AND d.client_id IS DISTINCT FROM ${c.clientId}::uuid LIMIT 1`;
    if (conflit.length)
      throw new ErreurMetier(
        "le client du chantier ne peut pas changer tant que des documents lui sont affectés",
        [],
        409,
      );
  }
  if (!(await lireClient(tx, c.clientId))) throw new ErreurMetier("client introuvable", [], 404);
  const doublon =
    await tx`SELECT id FROM chantier WHERE code=${c.code} AND id<>${id ? identifiant(id) : "00000000-0000-0000-0000-000000000000"}`;
  if (doublon.length) throw new ErreurMetier("code analytique déjà utilisé", [], 409);
  let result;
  if (id) {
    result =
      await tx`UPDATE chantier SET nom=${c.nom},code=${c.code},client_id=${c.clientId},adresse=${c.adresse},budget_ht_cents=${c.budgetHtCents},avancement=${c.avancement},statut=${c.statut},debut=${c.debut},fin=${c.fin},notes=${c.notes},archive=${c.archive} WHERE id=${id} RETURNING id`;
  } else {
    result =
      await tx`INSERT INTO chantier (nom,code,client_id,adresse,budget_ht_cents,avancement,statut,debut,fin,notes,archive) VALUES (${c.nom},${c.code},${c.clientId},${c.adresse},${c.budgetHtCents},${c.avancement},${c.statut},${c.debut},${c.fin},${c.notes},${c.archive}) RETURNING id`;
  }
  if (!result[0]) throw new ErreurMetier("chantier introuvable", [], 404);
  await journaliser(tx, actor, id ? "chantier.modifier" : "chantier.creer", result[0].id);
  return lireChantier(tx, result[0].id);
}
export async function affecterDocument(tx: Tx, actor: string | null, id: string, chantierId: string | null) {
  if (chantierId !== null) identifiant(chantierId);
  await tx`SELECT id FROM document WHERE id=${identifiant(id)} FOR UPDATE`;
  const d = await lire(tx, identifiant(id));
  if (!d) throw new ErreurMetier("document introuvable", [], 404);
  if (d.type === "avoir") {
    const [origine] = await tx<{ chantier_id: string }[]>`SELECT c.chantier_id FROM chantier_document c
      JOIN document f ON f.tenant_id=c.tenant_id AND f.id=c.document_id WHERE f.numero=${d.data.origine ?? ""}`;
    if ((origine?.chantier_id ?? null) !== chantierId)
      throw new ErreurMetier("l'avoir suit le chantier de sa facture d'origine");
    await tx`DELETE FROM chantier_document WHERE document_id=${id}`;
    await journaliser(tx, actor, "document.affecter", id, { chantierId, origine: d.data.origine });
    return;
  }
  if (chantierId) {
    await tx`SELECT id FROM chantier WHERE id=${identifiant(chantierId)} FOR SHARE`;
    const c = await lireChantier(tx, chantierId);
    if (d.clientId !== c.clientId) throw new ErreurMetier("le client du document doit être celui du chantier");
    await tx`INSERT INTO chantier_document (document_id,chantier_id) VALUES (${id},${chantierId}) ON CONFLICT (tenant_id,document_id) DO UPDATE SET chantier_id=excluded.chantier_id`;
  } else await tx`DELETE FROM chantier_document WHERE document_id=${id}`;
  await journaliser(tx, actor, "document.affecter", id, { chantierId });
}
export async function affectationDocument(tx: Tx, id: string): Promise<{ chantierId: string | null }> {
  const d = await lire(tx, identifiant(id));
  if (!d) throw new ErreurMetier("document introuvable", [], 404);
  if (d.type === "avoir") {
    const [a] = await tx<{ chantierId: string }[]>`SELECT c.chantier_id AS "chantierId" FROM chantier_document c
      JOIN document f ON f.tenant_id=c.tenant_id AND f.id=c.document_id WHERE f.numero=${d.data.origine ?? ""}`;
    return { chantierId: a?.chantierId ?? null };
  }
  const [r] = await tx<
    { chantierId: string }[]
  >`SELECT chantier_id AS "chantierId" FROM chantier_document WHERE document_id=${id}`;
  return { chantierId: r?.chantierId ?? null };
}
export async function affectationAchat(tx: Tx, id: string): Promise<AffectationAchat | null> {
  if (!(await lireRecue(tx, identifiant(id)))) throw new ErreurMetier("facture reçue introuvable", [], 404);
  const [a] = await tx<
    AffectationAchat[]
  >`SELECT recue_id AS "recueId", fournisseur_id AS "fournisseurId", chantier_id AS "chantierId" FROM achat_affectation WHERE recue_id=${id}`;
  return a ?? null;
}
export async function affecterAchat(
  tx: Tx,
  actor: string | null,
  id: string,
  fournisseurId: string,
  chantierId: string | null,
) {
  await tx`SELECT id FROM facture_recue WHERE id=${identifiant(id)} FOR UPDATE`;
  if (!(await lireRecue(tx, identifiant(id)))) throw new ErreurMetier("facture reçue introuvable", [], 404);
  await lireFournisseur(tx, fournisseurId);
  if (chantierId) await lireChantier(tx, chantierId);
  const conflit =
    await tx`SELECT id FROM piece_chantier WHERE recue_id=${id} AND (fournisseur_id<>${fournisseurId} OR chantier_id IS DISTINCT FROM ${chantierId}::uuid)`;
  if (conflit.length) throw new ErreurMetier("des pièces rapprochées utilisent une autre affectation", [], 409);
  await tx`INSERT INTO achat_affectation (recue_id,fournisseur_id,chantier_id) VALUES (${id},${fournisseurId},${chantierId}) ON CONFLICT (tenant_id,recue_id) DO UPDATE SET fournisseur_id=excluded.fournisseur_id,chantier_id=excluded.chantier_id`;
  await journaliser(tx, actor, "achat.affecter", id, { fournisseurId, chantierId });
  return { recueId: id, fournisseurId, chantierId };
}
const PIECE = `id,type,reference,fournisseur_id AS "fournisseurId",chantier_id AS "chantierId",recue_id AS "recueId",date::text,statut,lignes,notes,archive`;
export async function listerPieces(tx: Tx): Promise<PieceChantier[]> {
  return tx.unsafe(`SELECT ${PIECE} FROM piece_chantier ORDER BY date DESC,created_at DESC`) as Promise<
    PieceChantier[]
  >;
}
export async function enregistrerPiece(
  tx: Tx,
  actor: string | null,
  body: unknown,
  id?: string,
): Promise<PieceChantier> {
  const p = verifierPiece(body);
  await lireFournisseur(tx, p.fournisseurId);
  await lireChantier(tx, p.chantierId);
  if (id) identifiant(id);
  if (p.recueId) {
    await tx`SELECT id FROM facture_recue WHERE id=${p.recueId} FOR UPDATE`;
    const a = await affectationAchat(tx, p.recueId);
    if (a && (a.fournisseurId !== p.fournisseurId || a.chantierId !== p.chantierId))
      throw new ErreurMetier("la facture est affectée à un autre fournisseur ou chantier", [], 409);
    await affecterAchat(tx, actor, p.recueId, p.fournisseurId, p.chantierId);
  }
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(app_tenant()::text || ':piece:' || ${p.fournisseurId} || ':' || ${p.type} || ':' || ${p.reference}, 0))`;
  const dup =
    await tx`SELECT id FROM piece_chantier WHERE type=${p.type} AND reference=${p.reference} AND fournisseur_id=${p.fournisseurId} AND id<>${id ?? "00000000-0000-0000-0000-000000000000"}`;
  if (dup.length) throw new ErreurMetier("référence de pièce déjà utilisée pour ce fournisseur", [], 409);
  const lignes = JSON.stringify(p.lignes);
  const result = id
    ? await tx`UPDATE piece_chantier SET type=${p.type},reference=${p.reference},fournisseur_id=${p.fournisseurId},chantier_id=${p.chantierId},recue_id=${p.recueId},date=${p.date},statut=${p.statut},lignes=${lignes}::text::jsonb,notes=${p.notes},archive=${p.archive} WHERE id=${id} RETURNING id`
    : await tx`INSERT INTO piece_chantier (type,reference,fournisseur_id,chantier_id,recue_id,date,statut,lignes,notes,archive) VALUES (${p.type},${p.reference},${p.fournisseurId},${p.chantierId},${p.recueId},${p.date},${p.statut},${lignes}::text::jsonb,${p.notes},${p.archive}) RETURNING id`;
  if (!result[0]) throw new ErreurMetier("pièce introuvable", [], 404);
  await journaliser(tx, actor, id ? "piece.modifier" : "piece.creer", result[0].id);
  const [r] = (await tx.unsafe(`SELECT ${PIECE} FROM piece_chantier WHERE id=$1`, [result[0].id])) as PieceChantier[];
  return r!;
}
export async function dossierChantier(tx: Tx, id: string): Promise<DossierChantier> {
  const chantier = await lireChantier(tx, id);
  const documents = await documentsChantier(tx, id);
  const achats = await achatsChantier(tx, id);
  const pieces = (await tx.unsafe(
    `SELECT ${PIECE} FROM piece_chantier WHERE chantier_id=$1 ORDER BY date DESC,created_at DESC`,
    [id],
  )) as PieceChantier[];
  return { chantier, documents, achats, pieces, analytique: calculerAnalytique(documents, achats, pieces) };
}

export function calculerAnalytique(documents: Ligne[], achats: Recue[], pieces: PieceChantier[]): AnalytiqueChantier {
  const ventesHtCents = documents
    .filter(
      (d) =>
        d.statut !== "brouillon" &&
        (d.statut !== "annule" ||
          documents.some(
            (a) => a.type === "avoir" && !["brouillon", "annule"].includes(a.statut) && a.data.origine === d.numero,
          )),
    )
    .reduce(
      (s, d) => s + (d.type === "avoir" ? -d.htCents : ["facture", "acompte"].includes(d.type) ? d.htCents : 0),
      0,
    );
  const valides = achats.filter((a) => a.statut === "validee");
  const achatsHtCents = valides
    .filter((a) => a.facture?.devise === "EUR")
    .reduce((s, a) => s + (a.facture!.type === "avoir" ? -1 : 1) * a.facture!.totaux.htCents, 0);
  const commandesHtCents = pieces
    .filter(
      (p) =>
        p.type === "confirmation_commande" &&
        p.statut === "valide" &&
        !achats.some((a) => a.id === p.recueId && a.statut === "validee"),
    )
    .reduce((s, p) => s + totaux(p.lignes).htCents, 0);
  return {
    ventesHtCents,
    achatsHtCents,
    soldeHtCents: ventesHtCents - achatsHtCents,
    commandesHtCents,
    achatsAffectes: achats.length,
    achatsNonChiffres: valides.filter((a) => !a.facture || a.facture.devise !== "EUR").length,
  };
}

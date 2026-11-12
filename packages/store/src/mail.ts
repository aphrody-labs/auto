// Lot mail : stockage (voir docs/ARCHITECTURE.md et docs/MAIL.md). Le chiffrement est fait par l'appelant.
import type { Tx } from "./db";

type Securite = "tls" | "starttls" | "aucune";

export interface ConfigBoite {
  adresse: string;
  nom: string | null;
  fournisseur: string | null;
  imap: { hote: string; port: number; securite: Securite };
  smtp: { hote: string; port: number; securite: Securite };
  certificatNonVerifie: boolean;
  dossier: string;
}

export interface Boite extends ConfigBoite {
  source: string;
  identifiants: Uint8Array;
  uidValidity: number | null;
  dernierUid: number;
  releveAt: string | null;
  erreur: string | null;
}

interface RowBoite {
  adresse: string;
  nom: string | null;
  fournisseur: string | null;
  imap_hote: string;
  imap_port: number;
  imap_securite: Securite;
  smtp_hote: string;
  smtp_port: number;
  smtp_securite: Securite;
  certificat_non_verifie: boolean;
  dossier: string;
  source: string;
  identifiants: Uint8Array;
  uid_validity: string | null;
  dernier_uid: string;
  releve_at: Date | null;
  erreur: string | null;
}

const boite = (r: RowBoite): Boite => ({
  adresse: r.adresse,
  nom: r.nom,
  fournisseur: r.fournisseur,
  imap: { hote: r.imap_hote, port: r.imap_port, securite: r.imap_securite },
  smtp: { hote: r.smtp_hote, port: r.smtp_port, securite: r.smtp_securite },
  certificatNonVerifie: r.certificat_non_verifie,
  dossier: r.dossier,
  source: r.source,
  identifiants: new Uint8Array(r.identifiants),
  uidValidity: r.uid_validity === null ? null : Number(r.uid_validity),
  dernierUid: Number(r.dernier_uid),
  releveAt: r.releve_at?.toISOString() ?? null,
  erreur: r.erreur,
});

/**
 * Connecte (ou remplace) la boîte du tenant. L'état de relève repart de zéro : les messages déjà
 * enregistrés sont reconnus par leur clé (source, UIDVALIDITY, UID) et ne sont pas dupliqués.
 */
export async function enregistrerBoite(
  tx: Tx,
  actor: string | null,
  c: ConfigBoite & { source: string; identifiants: Uint8Array },
): Promise<void> {
  await tx`
    INSERT INTO boite_mail (adresse, nom, fournisseur, imap_hote, imap_port, imap_securite, smtp_hote, smtp_port,
      smtp_securite, certificat_non_verifie, dossier, source, identifiants)
    VALUES (${c.adresse}, ${c.nom}, ${c.fournisseur}, ${c.imap.hote}, ${c.imap.port}, ${c.imap.securite}, ${c.smtp.hote},
      ${c.smtp.port}, ${c.smtp.securite}, ${c.certificatNonVerifie}, ${c.dossier}, ${c.source}, ${c.identifiants})
    ON CONFLICT (tenant_id) DO UPDATE SET adresse = EXCLUDED.adresse, nom = EXCLUDED.nom,
      fournisseur = EXCLUDED.fournisseur, imap_hote = EXCLUDED.imap_hote, imap_port = EXCLUDED.imap_port,
      imap_securite = EXCLUDED.imap_securite, smtp_hote = EXCLUDED.smtp_hote, smtp_port = EXCLUDED.smtp_port,
      smtp_securite = EXCLUDED.smtp_securite, certificat_non_verifie = EXCLUDED.certificat_non_verifie,
      dossier = EXCLUDED.dossier, source = EXCLUDED.source, identifiants = EXCLUDED.identifiants,
      uid_validity = NULL, dernier_uid = 0, erreur = NULL, updated_at = now()`;
  await tx`INSERT INTO audit (actor, action, ref, payload)
    VALUES (${actor}, 'mail.boite', ${c.adresse}, ${{ imap: c.imap.hote, smtp: c.smtp.hote, fournisseur: c.fournisseur }})`;
}

export async function lireBoite(tx: Tx, verrou = false): Promise<Boite | null> {
  const [r] = verrou
    ? await tx<RowBoite[]>`SELECT * FROM boite_mail FOR UPDATE`
    : await tx<RowBoite[]>`SELECT * FROM boite_mail`;
  return r ? boite(r) : null;
}

export async function supprimerBoite(tx: Tx, actor: string | null): Promise<boolean> {
  const r = await tx<{ adresse: string }[]>`DELETE FROM boite_mail RETURNING adresse`;
  if (r.length)
    await tx`INSERT INTO audit (actor, action, ref) VALUES (${actor}, 'mail.deconnecter', ${r[0]!.adresse})`;
  return r.length > 0;
}

export interface MailRecu {
  id: string;
  messageId: string | null;
  expediteur: string | null;
  destinataires: string[];
  sujet: string;
  dateEnvoi: string | null;
  extrait: string;
  taille: number;
  sha256: string;
  classement: "facture" | "autre";
  createdAt: string;
  pieces: { id: string; nom: string; type: string; taille: number; sha256: string; facturx: boolean }[];
}

export interface NouveauMail {
  source: string;
  uidValidity: number;
  uid: number;
  messageId: string | null;
  expediteur: string | null;
  destinataires: string[];
  sujet: string;
  dateEnvoi: Date | null;
  extrait: string;
  octets: Uint8Array;
  classement: "facture" | "autre";
  pieces: { nom: string; type: string; octets: Uint8Array; facturx: boolean }[];
}

const sha256 = (o: Uint8Array) => new Bun.CryptoHasher("sha256").update(o).digest("hex");

/** Enregistre un message relevé ; `null` s'il l'était déjà (idempotence). */
export async function enregistrerMailRecu(tx: Tx, m: NouveauMail): Promise<MailRecu | null> {
  const [r] = await tx<{ id: string; created_at: Date }[]>`
    INSERT INTO mail_recu (source, uid_validity, uid, message_id, expediteur, destinataires, sujet, date_envoi,
      extrait, taille, sha256, classement)
    VALUES (${m.source}, ${m.uidValidity}, ${m.uid}, ${m.messageId}, ${m.expediteur}, ${tx.array(m.destinataires, "TEXT")},
      ${m.sujet}, ${m.dateEnvoi}, ${m.extrait}, ${m.octets.length}, ${sha256(m.octets)}, ${m.classement})
    ON CONFLICT (tenant_id, source, uid_validity, uid) DO NOTHING RETURNING id, created_at`;
  if (!r) return null;
  const pieces: MailRecu["pieces"] = [];
  for (const [rang, p] of m.pieces.entries()) {
    const h = sha256(p.octets);
    const [x] = await tx<{ id: string }[]>`
      INSERT INTO mail_piece (mail_id, rang, nom, type, taille, sha256, facturx, contenu)
      VALUES (${r.id}, ${rang}, ${p.nom}, ${p.type}, ${p.octets.length}, ${h}, ${p.facturx}, ${p.octets}) RETURNING id`;
    pieces.push({ id: x!.id, nom: p.nom, type: p.type, taille: p.octets.length, sha256: h, facturx: p.facturx });
  }
  return {
    id: r.id,
    messageId: m.messageId,
    expediteur: m.expediteur,
    destinataires: m.destinataires,
    sujet: m.sujet,
    dateEnvoi: m.dateEnvoi?.toISOString() ?? null,
    extrait: m.extrait,
    taille: m.octets.length,
    sha256: sha256(m.octets),
    classement: m.classement,
    createdAt: r.created_at.toISOString(),
    pieces,
  };
}

/** Avance l'état de relève (après enregistrement des messages, dans la même transaction). */
export async function noterReleve(
  tx: Tx,
  actor: string | null,
  e: { uidValidity: number; dernierUid: number; nouveaux: number; erreur?: string | null },
) {
  await tx`UPDATE boite_mail SET uid_validity = ${e.uidValidity}, dernier_uid = GREATEST(
      CASE WHEN uid_validity = ${e.uidValidity} THEN dernier_uid ELSE 0 END, ${e.dernierUid}),
    releve_at = now(), erreur = ${e.erreur ?? null}`;
  if (e.nouveaux)
    await tx`INSERT INTO audit (actor, action, payload) VALUES (${actor}, 'mail.relever', ${{ nouveaux: e.nouveaux }})`;
}

export async function noterErreurReleve(tx: Tx, erreur: string) {
  await tx`UPDATE boite_mail SET erreur = ${erreur}, releve_at = now()`;
}

interface RowMail {
  id: string;
  message_id: string | null;
  expediteur: string | null;
  destinataires: string[];
  sujet: string;
  date_envoi: Date | null;
  extrait: string;
  taille: number;
  sha256: string;
  classement: "facture" | "autre";
  created_at: Date;
  pieces: MailRecu["pieces"];
}

export async function listerMailsRecus(
  tx: Tx,
  o: { classement?: "facture" | "autre"; limite?: number } = {},
): Promise<MailRecu[]> {
  const rows = await tx<RowMail[]>`
    SELECT m.*, coalesce((SELECT json_agg(json_build_object('id', p.id, 'nom', p.nom, 'type', p.type,
        'taille', p.taille, 'sha256', p.sha256, 'facturx', p.facturx) ORDER BY p.rang)
      FROM mail_piece p WHERE p.mail_id = m.id), '[]') AS pieces
    FROM mail_recu m
    WHERE ${o.classement ?? null}::text IS NULL OR m.classement = ${o.classement ?? null}
    ORDER BY m.created_at DESC, m.uid DESC LIMIT ${o.limite ?? 100}`;
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    expediteur: r.expediteur,
    destinataires: r.destinataires,
    sujet: r.sujet,
    dateEnvoi: r.date_envoi?.toISOString() ?? null,
    extrait: r.extrait,
    taille: r.taille,
    sha256: r.sha256,
    classement: r.classement,
    createdAt: r.created_at.toISOString(),
    pieces: typeof r.pieces === "string" ? JSON.parse(r.pieces) : r.pieces,
  }));
}

export async function lirePieceMail(
  tx: Tx,
  id: string,
): Promise<{ nom: string; type: string; sha256: string; contenu: Uint8Array<ArrayBuffer> } | null> {
  const [r] = await tx<{ nom: string; type: string; sha256: string; contenu: Uint8Array }[]>`
    SELECT nom, type, sha256, contenu FROM mail_piece WHERE id = ${id}`;
  return r ? { nom: r.nom, type: r.type, sha256: r.sha256, contenu: new Uint8Array(r.contenu) } : null;
}

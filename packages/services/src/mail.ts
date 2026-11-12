// Lot mail : boîte IMAP/SMTP du tenant, relève classée, envoi des devis et factures (voir docs/MAIL.md).
import { eur, type Type } from "@auto/domain";
import {
  adresseValide,
  analyser,
  relever as releverImap,
  classer,
  cleMaitre,
  construire,
  dechiffrer,
  envoyerSmtp,
  ErreurCle,
  ErreurMail,
  ErreurMime,
  FOURNISSEURS,
  prereglage,
  testerImap,
  testerSmtp,
  type ConfigImap,
  type ConfigSmtp,
  type Identifiants,
  type Securite,
} from "@auto/mail";
import { extraireXml } from "@auto/native";
import {
  changerStatut,
  enregistrerMailRecu,
  ErreurMetier,
  journaliser,
  lire,
  lireBoite,
  lireFichier,
  noterErreurReleve,
  noterReleve,
  withTenant,
  type Boite,
  type ConfigBoite,
  type MailRecu,
  type Sql,
} from "@auto/store";
import { entreprise } from "@auto/tenancy";
import type { Emetteur } from "./evenements";
import { deposer } from "./ingest";

export const USAGE = "mail/identifiants";
export const SECURITES: Securite[] = ["tls", "starttls", "aucune"];

/** Événements du lot (à ajouter à `TypeEvenement` par le lot outbox). */
export type EvenementMail = "mail.recu" | "mail.facture_recue";
/** Publication hors transaction métier : l'événement entre dans l'outbox par sa propre transaction. */
export const emettre = (sql: Sql, publier: Emetteur, type: EvenementMail, tenantId: string, data: unknown) =>
  withTenant(sql, tenantId, (tx) => publier(tx, type, data));

/** Dev et tests : autorise le clair et les certificats auto-signés (`AUTO_MAIL_DEV=1`). */
export const modeDev = () => Bun.env.AUTO_MAIL_DEV === "1";

export function cle(): string {
  try {
    return cleMaitre();
  } catch (e) {
    throw new ErreurMetier((e as Error).message, [], 503);
  }
}

export interface CorpsBoite {
  fournisseur?: string;
  adresse?: string;
  nom?: string;
  utilisateur?: string;
  motDePasse?: string;
  imap?: Partial<ConfigBoite["imap"]>;
  smtp?: Partial<ConfigBoite["smtp"]>;
  dossier?: string;
  certificatNonVerifie?: boolean;
}

export function serveur(quoi: string, v: Partial<ConfigBoite["imap"]> | undefined, defaut?: ConfigBoite["imap"]) {
  const s = { ...defaut, ...v };
  const erreurs: string[] = [];
  if (!s.hote || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s.hote)) erreurs.push(`${quoi} : hôte invalide`);
  if (!Number.isInteger(s.port) || s.port! < 1 || s.port! > 65535) erreurs.push(`${quoi} : port invalide`);
  if (!SECURITES.includes(s.securite!)) erreurs.push(`${quoi} : sécurité attendue tls, starttls ou aucune`);
  if (s.securite === "aucune" && !modeDev()) erreurs.push(`${quoi} : connexion sans chiffrement refusée`);
  return { s: s as ConfigBoite["imap"], erreurs };
}

export function valider(b: CorpsBoite): { config: ConfigBoite; identifiants: Identifiants } {
  const p = b.fournisseur ? prereglage(b.fournisseur) : undefined;
  if (b.fournisseur && !p) throw new ErreurMetier("fournisseur inconnu", [FOURNISSEURS.map((f) => f.id).join(", ")]);
  const imap = serveur("IMAP", b.imap, p?.imap);
  const smtp = serveur("SMTP", b.smtp, p?.smtp);
  const erreurs = [...imap.erreurs, ...smtp.erreurs];
  const adresse = b.adresse?.trim().toLowerCase() ?? "";
  if (!adresseValide(adresse)) erreurs.push("adresse invalide");
  if (!b.motDePasse) erreurs.push("mot de passe manquant");
  if (b.certificatNonVerifie && !modeDev()) erreurs.push("certificat non vérifié refusé");
  if (b.nom && /[\r\n]/.test(b.nom)) erreurs.push("nom invalide");
  if (erreurs.length) throw new ErreurMetier("boîte mail invalide", erreurs);
  return {
    config: {
      adresse,
      nom: b.nom?.trim() || null,
      fournisseur: p?.id ?? null,
      imap: imap.s,
      smtp: smtp.s,
      certificatNonVerifie: !!b.certificatNonVerifie,
      dossier: b.dossier?.trim() || "INBOX",
    },
    identifiants: { utilisateur: b.utilisateur?.trim() || adresse, motDePasse: b.motDePasse! },
  };
}

export const empreinte = (c: ConfigBoite, i: Identifiants) =>
  new Bun.CryptoHasher("sha256")
    .update(`${c.imap.hote.toLowerCase()}:${c.imap.port}|${i.utilisateur.toLowerCase()}|${c.dossier}`)
    .digest("hex")
    .slice(0, 32);

export const configs = (c: ConfigBoite, identifiants: Identifiants): { imap: ConfigImap; smtp: ConfigSmtp } => ({
  imap: { ...c.imap, certificatNonVerifie: c.certificatNonVerifie, identifiants, dossier: c.dossier },
  smtp: { ...c.smtp, certificatNonVerifie: c.certificatNonVerifie, identifiants, ehlo: c.adresse.split("@")[1] },
});

export async function ouvrir(tenantId: string, b: Boite) {
  try {
    return configs(b, await dechiffrer<Identifiants>(cle(), tenantId, USAGE, b.identifiants));
  } catch (e) {
    if (e instanceof ErreurCle) throw new ErreurMetier(e.message, [], 503);
    throw e;
  }
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Test de connexion IMAP et SMTP ; les deux erreurs sont rapportées ensemble. */
export async function tester(c: { imap: ConfigImap; smtp: ConfigSmtp }) {
  const [imap, smtp] = await Promise.allSettled([testerImap(c.imap), testerSmtp(c.smtp)]);
  const details = [
    ...(imap.status === "rejected" ? [`IMAP : ${message(imap.reason)}`] : []),
    ...(smtp.status === "rejected" ? [`SMTP : ${message(smtp.reason)}`] : []),
  ];
  if (details.length) throw new ErreurMetier("connexion à la boîte impossible", details, 422);
  return { imap: { ok: true, messages: imap.status === "fulfilled" ? imap.value.existe : 0 }, smtp: { ok: true } };
}

export const publique = (b: Boite) => ({
  adresse: b.adresse,
  nom: b.nom,
  fournisseur: b.fournisseur,
  imap: b.imap,
  smtp: b.smtp,
  dossier: b.dossier,
  certificatNonVerifie: b.certificatNonVerifie,
  dernierUid: b.dernierUid,
  releveAt: b.releveAt,
  erreur: b.erreur,
});

export const estFacturx = (pdf: Uint8Array) => {
  try {
    return extraireXml(pdf) !== null;
  } catch {
    return false;
  }
};

export const extrait = (texte: string, html: string | null) =>
  (texte || (html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 280);

/**
 * Relève la boîte d'un tenant : messages d'UID supérieur au dernier relevé, analysés et classés hors
 * transaction, puis enregistrés avec l'état de relève dans une seule transaction (idempotente).
 */
export async function relever(sql: Sql, tenantId: string, publier: Emetteur, actor: string | null = null) {
  const b = await withTenant(sql, tenantId, (tx) => lireBoite(tx));
  if (!b) throw new ErreurMetier("aucune boîte mail connectée", [], 404);
  const c = await ouvrir(tenantId, b);
  let r: Awaited<ReturnType<typeof releverImap>>;
  try {
    r = await releverImap(c.imap, { uidValidity: b.uidValidity, dernierUid: b.dernierUid });
  } catch (e) {
    await withTenant(sql, tenantId, (tx) => noterErreurReleve(tx, message(e)));
    throw new ErreurMetier("relève impossible", [message(e)], 502);
  }
  const analyses = r.messages.map((m) => {
    const a = analyser(m.octets);
    const k = classer(a.sujet, a.pieces, estFacturx);
    return { m, a, k };
  });
  const nouveaux = await withTenant(sql, tenantId, async (tx) => {
    const out: MailRecu[] = [];
    for (const { m, a, k } of analyses) {
      const e = await enregistrerMailRecu(tx, {
        source: b.source,
        uidValidity: r.uidValidity,
        uid: m.uid,
        messageId: a.messageId,
        expediteur: a.de,
        destinataires: a.a,
        sujet: a.sujet,
        dateEnvoi: a.date,
        extrait: extrait(a.texte, a.html),
        octets: m.octets,
        classement: k.classement,
        pieces: a.pieces.map((p, i) => ({ ...p, facturx: k.facturx[i]! })),
      });
      if (e) out.push(e);
    }
    const dernierUid = Math.max(0, ...r.messages.map((m) => m.uid));
    await noterReleve(tx, actor, { uidValidity: r.uidValidity, dernierUid, nouveaux: out.length });
    return out;
  });
  for (const m of nouveaux)
    await emettre(sql, publier, m.classement === "facture" ? "mail.facture_recue" : "mail.recu", tenantId, m);
  // Factures reçues par mail : chaque pièce PDF ou XML d'un message classé « facture » part à l'ingestion.
  for (const { a, k } of analyses) {
    for (const [i, p] of a.pieces.entries()) {
      const estDevis = !k.facturx[i] && !/facture/i.test(p.nom) && (/devis/i.test(p.nom) || /\bdevis\b/i.test(a.sujet));
      if (estDevis && (/pdf|image\//i.test(p.type) || /\.(pdf|png|jpe?g)$/i.test(p.nom))) {
        const { deposerDevis } = await import("./devis-recus");
        await deposerDevis(sql, tenantId, actor, {
          contenu: p.octets,
          nom: p.nom,
          typeMime: p.type,
          canal: "mail",
        }).catch(() => console.error("extraction devis mail impossible"));
        continue;
      }
      if (k.classement !== "facture") continue;
      if (!/pdf|xml/i.test(p.type) && !/\.(pdf|xml)$/i.test(p.nom)) continue;
      await deposer(sql, tenantId, actor, { contenu: p.octets, nom: p.nom, typeMime: p.type, canal: "mail" }).catch(
        (e) => console.error(`ingestion mail ${tenantId} : ${message(e)}`),
      );
    }
  }
  return { nouveaux: nouveaux.length, factures: nouveaux.filter((m) => m.classement === "facture").length };
}

/** Tenants ayant une boîte connectée (interrogés un à un : la RLS est forcée). */
export async function tenantsAvecBoite(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  for (const { id } of await sql<{ id: string }[]>`SELECT id FROM tenant ORDER BY id`)
    if (await withTenant(sql, id, (tx) => lireBoite(tx))) out.push(id);
  return out;
}

/** Relève de toutes les boîtes (pour `Bun.cron` du worker) ; une boîte en erreur n'arrête pas les autres. */
export async function releverTous(sql: Sql, publier: Emetteur) {
  const tenants = await sql<{ id: string }[]>`SELECT id FROM tenant`;
  const bilan: Record<string, { nouveaux: number; factures: number } | { erreur: string }> = {};
  for (const { id } of tenants) {
    if (!(await withTenant(sql, id, (tx) => lireBoite(tx)))) continue;
    bilan[id] = await relever(sql, id, publier).catch((e) => ({ erreur: message(e) }));
  }
  return bilan;
}

export const LIBELLES: Record<Type, string> = {
  devis: "devis",
  facture: "facture",
  acompte: "facture d'acompte",
  avoir: "avoir",
};

export const echapper = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const dateFr = (iso: string) => iso.split("-").reverse().join("/");

export interface CorpsEnvoi {
  a?: string[];
  cc?: string[];
  sujet?: string;
  message?: string;
}

/** Objet et texte d'une relance d'impayé selon le palier (J+7 courtois, J+30 ferme, J+60 avant mise en demeure). */
export function texteRelance(
  r: { numero: string; echeance: string; joursRetard: number; niveau: 1 | 2 | 3; resteCents: number },
  entreprise: string,
): { sujet: string; message: string } {
  const reste = `${eur(r.resteCents)} TTC`;
  const rappel = `notre facture ${r.numero}, échue le ${dateFr(r.echeance)}, reste impayée (${reste}, ${r.joursRetard} jours de retard)`;
  const legal =
    "Conformément à l'article L441-10 du Code de commerce, tout retard de paiement entraîne des pénalités de retard " +
    "et une indemnité forfaitaire de 40 € pour frais de recouvrement.";
  const corps = {
    1: `Bonjour,\n\nSauf erreur de notre part, ${rappel}. Il s'agit peut-être d'un simple oubli : vous trouverez la facture ci-jointe.\n\nSi le règlement est déjà parti, merci de ne pas tenir compte de ce message.`,
    2: `Bonjour,\n\nMalgré notre précédent rappel, ${rappel}. Nous vous remercions de procéder au règlement sous huit jours.\n\n${legal}`,
    3: `Bonjour,\n\n${rappel[0]!.toUpperCase() + rappel.slice(1)} malgré nos deux relances. Sans règlement sous huit jours, nous engagerons une procédure de recouvrement, en commençant par une mise en demeure.\n\n${legal}`,
  }[r.niveau];
  const sujet = { 1: "Rappel", 2: "Deuxième relance", 3: "Dernière relance avant mise en demeure" }[r.niveau];
  return {
    sujet: `${sujet} : facture ${r.numero} — ${entreprise}`,
    message: `${corps}\n\nCordialement,\n${entreprise}`,
  };
}

/** Envoie l'exemplaire figé d'un document émis depuis la boîte du tenant ; `emis` passe à `envoye`. */
export async function envoyerDocument(
  sql: Sql,
  publier: Emetteur,
  tenantId: string,
  actor: string | null,
  id: string,
  c: CorpsEnvoi,
) {
  const e = await entreprise(sql, tenantId);
  const pret = await withTenant(sql, tenantId, async (tx) => {
    const d = await lire(tx, id);
    if (!d) throw new ErreurMetier("document introuvable", [], 404);
    if (d.statut === "brouillon") throw new ErreurMetier("document non émis : émettre avant d'envoyer", [], 409);
    if (d.statut === "annule") throw new ErreurMetier("document annulé", [], 409);
    const f = await lireFichier(tx, d.id, d.type === "devis" ? "pdf" : "facturx");
    if (!f) throw new ErreurMetier("exemplaire figé introuvable", [], 500);
    const b = await lireBoite(tx);
    if (!b) throw new ErreurMetier("aucune boîte mail connectée", [], 409);
    return { d, f, b };
  });
  const { d, f, b } = pret;
  const a = c.a?.length ? c.a : d.data.client.email ? [d.data.client.email] : [];
  const cc = c.cc ?? [];
  const invalides = [...a, ...cc].filter((x) => typeof x !== "string" || !adresseValide(x));
  if (!a.length) throw new ErreurMetier("destinataire manquant (aucune adresse sur la fiche client)");
  if (invalides.length) throw new ErreurMetier("adresse invalide", invalides);

  const libelle = LIBELLES[d.type];
  const Libelle = libelle[0]!.toUpperCase() + libelle.slice(1);
  const echeance = d.type !== "devis" && d.data.echeance ? `, à régler avant le ${dateFr(d.data.echeance)}` : "";
  const texte =
    c.message ??
    `Bonjour,\n\nVeuillez trouver ci-joint notre ${libelle} ${d.numero} d'un montant de ${eur(d.ttcCents)} TTC${echeance}.\n\n` +
      `Cordialement,\n${e.nom}`;
  const html = texte
    .split(/\n{2,}/)
    .map((p) => `<p>${echapper(p).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
  const sujet = c.sujet ?? `${Libelle} ${d.numero} — ${e.nom}`;
  const conn = await ouvrir(tenantId, b);
  let x: ReturnType<typeof construire>;
  try {
    x = construire({
      de: { nom: b.nom ?? e.nom, adresse: b.adresse },
      a,
      cc,
      sujet,
      texte,
      html: `<!doctype html><html lang="fr"><body>${html}</body></html>`,
      pieces: [{ nom: `${d.numero}.pdf`, type: "application/pdf", octets: f.contenu }],
    });
  } catch (err) {
    if (err instanceof ErreurMime) throw new ErreurMetier(err.message);
    throw err;
  }
  try {
    await envoyerSmtp(conn.smtp, x.expediteur, x.destinataires, x.octets);
  } catch (err) {
    if (err instanceof ErreurMail) throw new ErreurMetier("envoi impossible", [err.message], 502);
    throw err;
  }
  const apres = await withTenant(sql, tenantId, async (tx) => {
    await journaliser(tx, actor, "mail.envoyer", d.id, {
      numero: d.numero,
      a: x.destinataires,
      messageId: x.messageId,
      sha256: f.sha256,
    });
    const cur = await lire(tx, d.id);
    return cur?.statut === "emis" ? changerStatut(tx, actor, d.id, "envoye") : null;
  });
  if (apres) await withTenant(sql, tenantId, (tx) => publier(tx, "document.statut", apres));
  return { messageId: x.messageId, destinataires: x.destinataires, statut: apres?.statut ?? d.statut };
}

/** Mail texte depuis la boîte du tenant (nœud « Envoyer un mail » des automatisations). */
export async function envoyerTexte(
  sql: Sql,
  tenantId: string,
  actor: string | null,
  m: { a: string; sujet: string; texte: string; pieces?: { nom: string; type: string; base64: string }[] },
) {
  if (!adresseValide(m.a)) throw new ErreurMetier("adresse invalide", [m.a]);
  const e = await entreprise(sql, tenantId);
  const b = await withTenant(sql, tenantId, (tx) => lireBoite(tx));
  if (!b) throw new ErreurMetier("aucune boîte mail connectée", [], 409);
  const html = m.texte
    .split(/\n{2,}/)
    .map((p) => `<p>${echapper(p).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
  const x = construire({
    de: { nom: b.nom ?? e.nom, adresse: b.adresse },
    a: [m.a],
    cc: [],
    sujet: m.sujet,
    texte: m.texte,
    html: `<!doctype html><html lang="fr"><body>${html}</body></html>`,
    pieces: (m.pieces ?? []).map((p) => ({ nom: p.nom, type: p.type, octets: Uint8Array.fromBase64(p.base64) })),
  });
  const conn = await ouvrir(tenantId, b);
  await envoyerSmtp(conn.smtp, x.expediteur, x.destinataires, x.octets);
  await withTenant(sql, tenantId, (tx) =>
    journaliser(tx, actor, "mail.envoyer", null, { a: x.destinataires, sujet: m.sujet, messageId: x.messageId }),
  );
}

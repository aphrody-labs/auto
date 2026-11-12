// Lot conformité : export complet d'un tenant, suppression avec délai de grâce et conservation légale,
// archivage des exemplaires figés en stockage objet (voir docs/conformite/ et migration 012).
import type { S3Client } from "bun";
import { withTenant, type Sql, type Tx } from "./db";
import { ErreurMetier, journaliser } from "./index";

/** Délai de grâce entre la demande de suppression et son exécution (annulable pendant ce délai). */
export const DELAI_GRACE_JOURS = 30;
/** Conservation des pièces comptables : 10 ans après la clôture de l'exercice (C. com. art. L123-22). */
export const CONSERVATION_ANS = 10;

/**
 * Règle de conservation à la suppression d'un tenant.
 *
 * - `conserver` : pièces comptables et leur preuve (facture émise, exemplaire figé, paiements, relances,
 *   piste d'audit, compteurs, archives). Conservées intactes : une facture doit rester lisible avec
 *   toutes ses mentions, y compris le nom du client (exception de l'art. 17.3.b du RGPD : obligation
 *   légale). Elles ne sont plus rattachées à aucun compte : les comptes utilisateurs sont supprimés et
 *   les identifiants d'acteurs de l'audit ne renvoient plus à personne (pseudonymisation).
 * - `pseudonymiser` : fiche client encore référencée par une facture ; les champs hors facture
 *   (email, adresse de la fiche, SIRET, TVA) sont effacés, le nom remplacé par un alias.
 * - `supprimer` : tout le reste, dont les tables ajoutées par d'autres lots qui ne se déclarent pas
 *   ici. Un lot dont une table relève d'une obligation de conservation doit l'ajouter à `conserver`.
 */
export const CONSERVATION = {
  conserver: [
    "document",
    "fichier",
    "paiement",
    "relance",
    "audit",
    "compteur",
    "archive_objet",
    "fournisseur",
    "chantier",
    "chantier_document",
    "achat_affectation",
    "piece_chantier",
    "facture_recue",
    "fichier_recu",
    "devis_recu",
    "source_fichiers",
    "fichier_indexe",
  ],
  pseudonymiser: ["client"],
} as const;

/** Colonnes jamais exportées (secrets) ; les colonnes bytea sont exportées en fichiers. */
const COLONNES_SECRETES = new Set(["token_hash", "password_hash", "totp_secret", "secret", "backup_codes", "key"]);

const ident = (n: string) => `"${n.replaceAll('"', '""')}"`;

async function tablesDuTenant(tx: Tx): Promise<{ table: string; colonnes: { nom: string; type: string }[] }[]> {
  const rows = await tx<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.table_name IN (SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id')
    ORDER BY c.table_name, c.ordinal_position`;
  const parTable = new Map<string, { nom: string; type: string }[]>();
  for (const r of rows) {
    if (!parTable.has(r.table_name)) parTable.set(r.table_name, []);
    parTable.get(r.table_name)!.push({ nom: r.column_name, type: r.data_type });
  }
  return [...parTable].map(([table, colonnes]) => ({ table, colonnes }));
}

/**
 * Export complet (portabilité, art. 20 RGPD) : archive tar.gz avec un JSON par table, les fichiers
 * (exemplaires figés), l'entreprise, les membres et un manifeste (nombre de lignes, SHA-256 des fichiers).
 * Les tables métier sont lues sous RLS (withTenant) et filtrées sur le tenant ; les secrets sont exclus.
 */
export async function exporterTenant(sql: Sql, tenantId: string): Promise<Uint8Array<ArrayBuffer>> {
  const contenu: Record<string, string | Uint8Array> = {};
  const manifeste: {
    genere: string;
    tenant: string;
    tables: Record<string, number>;
    fichiers: Record<string, string>;
  } = { genere: new Date().toISOString(), tenant: tenantId, tables: {}, fichiers: {} };
  const ajouterFichier = (chemin: string, octets: Uint8Array) => {
    contenu[chemin] = octets;
    manifeste.fichiers[chemin] = new Bun.CryptoHasher("sha256").update(octets).digest("hex");
  };

  // Couche comptes (hors RLS, lue par le propriétaire du schéma) : entreprise et membres, sans secret.
  const [t] = await sql`SELECT id, nom, siren, siret, adresse, tva_intracom, franchise_tva, created_at,
    suppression_effective_at FROM tenant WHERE id = ${tenantId}`;
  if (!t) throw new ErreurMetier("entreprise introuvable", [], 404);
  contenu["entreprise.json"] = JSON.stringify(t, null, 2);
  const membres =
    await sql`SELECT u.email, m.role, u.created_at, coalesce(u.two_factor_enabled, false) AS totp_actif FROM membership m
    JOIN app_user u ON u.id = m.user_id WHERE m.tenant_id = ${tenantId} ORDER BY u.email`;
  contenu["membres.json"] = JSON.stringify(membres, null, 2);

  await withTenant(sql, tenantId, async (tx) => {
    for (const { table, colonnes } of await tablesDuTenant(tx)) {
      const [{ ok }] = (await tx`SELECT has_table_privilege('auto_app', ${table}, 'SELECT') AS ok`) as unknown as [
        { ok: boolean },
      ];
      if (!ok) continue;
      const lisibles = colonnes.filter((c) => !COLONNES_SECRETES.has(c.nom));
      const select = lisibles.map((c) => ident(c.nom)).join(", ");
      const rows = (await tx.unsafe(
        `SELECT ${select} FROM ${ident(table)} WHERE tenant_id = app_tenant() ORDER BY 1`,
      )) as Record<string, unknown>[];
      const binaires = lisibles.filter((c) => c.type === "bytea").map((c) => c.nom);
      rows.forEach((r, i) => {
        for (const col of binaires) {
          if (r[col] == null) continue;
          const ext = table === "fichier" ? ".pdf" : ".bin";
          const nom = `fichiers/${table}/${String(r.document_id ?? r.id ?? i)}-${String(r.kind ?? col)}${ext}`;
          ajouterFichier(nom, new Uint8Array(r[col] as Uint8Array));
          r[col] = { fichier: nom };
        }
      });
      manifeste.tables[table] = rows.length;
      contenu[`tables/${table}.json`] = JSON.stringify(rows, null, 2);
    }
  });
  contenu["manifeste.json"] = JSON.stringify(manifeste, null, 2);
  return (await new Bun.Archive(contenu, { compress: "gzip" }).bytes()) as Uint8Array<ArrayBuffer>;
}

export interface EtatSuppression {
  demandeeAt: string | null;
  effectiveAt: string | null;
  supprimeAt: string | null;
  conservationJusqua: string | null;
}

export async function etatSuppression(sql: Sql, tenantId: string): Promise<EtatSuppression> {
  const [t] = await sql<
    {
      suppression_demandee_at: Date | null;
      suppression_effective_at: Date | null;
      supprime_at: Date | null;
      conservation_jusqua: Date | null;
    }[]
  >`SELECT suppression_demandee_at, suppression_effective_at, supprime_at, conservation_jusqua
    FROM tenant WHERE id = ${tenantId}`;
  if (!t) throw new ErreurMetier("entreprise introuvable", [], 404);
  return {
    demandeeAt: t.suppression_demandee_at?.toISOString() ?? null,
    effectiveAt: t.suppression_effective_at?.toISOString() ?? null,
    supprimeAt: t.supprime_at?.toISOString() ?? null,
    conservationJusqua: t.conservation_jusqua?.toISOString().slice(0, 10) ?? null,
  };
}

/** Demande de suppression (droit owner et confirmation vérifiés par l'appelant) : exécution à J+30. */
export async function demanderSuppression(sql: Sql, tenantId: string, userId: string, delaiJours = DELAI_GRACE_JOURS) {
  await sql.begin(async (tx) => {
    const r = await tx`UPDATE tenant SET suppression_demandee_at = now(), suppression_demandee_par = ${userId},
        suppression_effective_at = now() + ${`${delaiJours} days`}::interval
      WHERE id = ${tenantId} AND suppression_demandee_at IS NULL AND supprime_at IS NULL RETURNING id`;
    if (!r.length) throw new ErreurMetier("suppression déjà demandée", [], 409);
    await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
    await journaliser(tx, userId, "tenant.suppression.demander", tenantId, { delaiJours });
  });
  return etatSuppression(sql, tenantId);
}

export async function annulerSuppression(sql: Sql, tenantId: string, userId: string) {
  await sql.begin(async (tx) => {
    const r = await tx`UPDATE tenant SET suppression_demandee_at = NULL, suppression_demandee_par = NULL,
        suppression_effective_at = NULL
      WHERE id = ${tenantId} AND suppression_demandee_at IS NOT NULL AND supprime_at IS NULL RETURNING id`;
    if (!r.length) throw new ErreurMetier("aucune suppression en attente", [], 409);
    await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
    await journaliser(tx, userId, "tenant.suppression.annuler", tenantId);
  });
  return etatSuppression(sql, tenantId);
}

/**
 * Exécute une suppression : comptes, membres, invitations et données non comptables effacés, fiches
 * clients facturés pseudonymisées, pièces comptables conservées jusqu'au 31 décembre de l'année de la
 * dernière émission + 10 ans. Sans pièce à conserver, le tenant est purgé immédiatement.
 */
export async function executerSuppression(sql: Sql, tenantId: string) {
  const conservation = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
    const [t] = await tx`SELECT id FROM tenant WHERE id = ${tenantId} AND supprime_at IS NULL FOR UPDATE`;
    if (!t) throw new ErreurMetier("entreprise introuvable ou déjà supprimée", [], 404);

    // Comptes : clés d'API, invitations, adhésions ; utilisateurs sans autre entreprise (leurs sessions,
    // comptes de connexion, passkeys et 2FA suivent par ON DELETE CASCADE).
    const membres = await tx<{ user_id: string }[]>`SELECT user_id FROM membership WHERE tenant_id = ${tenantId}`;
    await tx`DELETE FROM apikey WHERE reference_id = ${tenantId}`;
    await tx`UPDATE session SET active_organization_id = NULL WHERE active_organization_id = ${tenantId}`;
    await tx`DELETE FROM invitation WHERE tenant_id = ${tenantId}`;
    await tx`DELETE FROM membership WHERE tenant_id = ${tenantId}`;
    for (const { user_id } of membres)
      await tx`DELETE FROM app_user WHERE id = ${user_id}
        AND NOT EXISTS (SELECT 1 FROM membership WHERE user_id = ${user_id})`;

    // Données sans obligation de conservation (ordre imposé par les clés étrangères).
    await tx`DELETE FROM absence WHERE tenant_id = ${tenantId}`;
    await tx`DELETE FROM employe WHERE tenant_id = ${tenantId}`;
    await tx`DELETE FROM produit WHERE tenant_id = ${tenantId}`;
    await tx`DELETE FROM document WHERE tenant_id = ${tenantId} AND statut = 'brouillon'`;
    await tx`DELETE FROM client c WHERE tenant_id = ${tenantId}
      AND NOT EXISTS (SELECT 1 FROM document d WHERE d.tenant_id = c.tenant_id AND d.client_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM chantier h WHERE h.tenant_id = c.tenant_id AND h.client_id = c.id)`;
    await tx`UPDATE client SET nom = 'client ' || left(id::text, 8), email = NULL, siret = NULL,
      tva_intracom = NULL, adresse = '' WHERE tenant_id = ${tenantId}`;

    // Tables des autres lots non déclarées : supprimées (plusieurs passes si elles se référencent).
    const traitees = new Set<string>([
      ...CONSERVATION.conserver,
      ...CONSERVATION.pseudonymiser,
      "absence",
      "employe",
      "produit",
      "invitation",
      "membership",
    ]);
    let restantes = (await tablesDuTenant(tx)).map((x) => x.table).filter((x) => !traitees.has(x));
    while (restantes.length) {
      const echecs: string[] = [];
      for (const table of restantes) {
        try {
          await tx.savepoint((sp) => sp.unsafe(`DELETE FROM ${ident(table)} WHERE tenant_id = $1`, [tenantId]));
        } catch {
          echecs.push(table);
        }
      }
      if (echecs.length === restantes.length) throw new Error(`suppression impossible : ${echecs.join(", ")}`);
      restantes = echecs;
    }

    const [{ fin }] = (await tx<{ fin: string | null }[]>`
      SELECT (make_date(max(annee), 12, 31) + ${`${CONSERVATION_ANS} years`}::interval)::date::text AS fin
      FROM (
        SELECT annee FROM document WHERE tenant_id = ${tenantId} AND statut <> 'brouillon'
        UNION ALL SELECT extract(year FROM coalesce(date_facture,created_at::date))::integer FROM facture_recue WHERE tenant_id=${tenantId}
        UNION ALL SELECT extract(year FROM date)::integer FROM piece_chantier WHERE tenant_id=${tenantId}
        UNION ALL SELECT extract(year FROM created_at)::integer FROM devis_recu WHERE tenant_id=${tenantId}
        UNION ALL SELECT extract(year FROM created_at)::integer FROM fichier_indexe WHERE tenant_id=${tenantId}
      ) pieces`) as unknown as [{ fin: string | null }];
    await tx`UPDATE tenant SET supprime_at = now(), conservation_jusqua = ${fin ?? "-infinity"}::date
      WHERE id = ${tenantId}`;
    await journaliser(tx, null, "tenant.supprimer", tenantId, { conservationJusqua: fin });
    return fin;
  });
  if (!conservation) await purgerTenant(sql, tenantId);
  return { conservationJusqua: conservation };
}

/** Suppressions dont le délai de grâce est écoulé (tâche planifiée quotidienne). */
export async function executerSuppressionsEchues(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM tenant
    WHERE supprime_at IS NULL AND suppression_effective_at <= now() ORDER BY suppression_effective_at`;
  for (const r of rows) await executerSuppression(sql, r.id);
  return rows.map((r) => r.id);
}

/**
 * Purge définitive après la conservation légale : seule exception à l'immuabilité (fonction SQL
 * `purge_autorisee`, migration 012). Les objets archivés expirent d'eux-mêmes (rétention S3).
 */
export async function purgerTenant(sql: Sql, tenantId: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant', ${tenantId}, true)`;
    await tx`SELECT set_config('app.purge', ${tenantId}, true)`;
    const [t] = await tx`SELECT 1 FROM tenant WHERE id = ${tenantId} AND supprime_at IS NOT NULL
      AND conservation_jusqua < current_date FOR UPDATE`;
    if (!t) throw new ErreurMetier("conservation légale en cours", [], 409);
    for (const table of [
      "fichier_indexe",
      "devis_recu",
      "source_fichiers",
      "piece_chantier",
      "achat_affectation",
      "chantier_document",
      "chantier",
      "fournisseur",
      "facture_recue",
      "fichier_recu",
      "archive_objet",
      "fichier",
      "paiement",
      "relance",
      "document",
      "client",
      "audit",
    ])
      await tx.unsafe(`DELETE FROM ${ident(table)} WHERE tenant_id = $1`, [tenantId]);
    await tx`DELETE FROM tenant WHERE id = ${tenantId}`;
  });
}

export async function purgerConservationsEchues(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM tenant
    WHERE supprime_at IS NOT NULL AND conservation_jusqua < current_date`;
  for (const r of rows) await purgerTenant(sql, r.id);
  return rows.map((r) => r.id);
}

/** Configuration S3 depuis l'environnement (MinIO en dev : voir compose.yaml) ; null si absente. */
export function s3DepuisEnv(env = Bun.env): S3Client | null {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET) return null;
  return new Bun.S3Client({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION ?? "eu-west-3",
  });
}

/**
 * Copie en stockage objet les exemplaires figés pas encore archivés. Le seau doit avoir le verrou d'objet
 * activé avec une rétention couvrant la conservation légale (11 ans : 10 ans après la
 * clôture d'un exercice d'au plus 12 mois) ; l'objet relu doit avoir le même SHA-256.
 */
export async function archiverFichiers(sql: Sql, tenantId: string, s3: S3Client, actor: string | null = null) {
  return withTenant(sql, tenantId, async (tx) => {
    const aFaire = await tx<{ id: string; document_id: string; kind: string; sha256: string; annee: number }[]>`
      SELECT f.id, f.document_id, f.kind, f.sha256, d.annee FROM fichier f
      JOIN document d ON d.tenant_id = f.tenant_id AND d.id = f.document_id
      WHERE NOT EXISTS (SELECT 1 FROM archive_objet a WHERE a.tenant_id = f.tenant_id AND a.fichier_id = f.id)
      ORDER BY f.created_at`;
    const archives: { fichierId: string; cle: string; sha256: string }[] = [];
    for (const f of aFaire) {
      const [{ contenu }] = (await tx`SELECT contenu FROM fichier WHERE id = ${f.id}`) as unknown as [
        { contenu: Uint8Array },
      ];
      const cle = `tenants/${tenantId}/${f.annee}/${f.document_id}-${f.kind}.pdf`;
      await s3.write(cle, new Uint8Array(contenu), { type: "application/pdf" });
      const relu = new Bun.CryptoHasher("sha256").update(await s3.file(cle).bytes()).digest("hex");
      if (relu !== f.sha256) throw new ErreurMetier("archive : empreinte relue différente", [cle], 502);
      await tx`INSERT INTO archive_objet (fichier_id, cle, sha256, conserver_jusqua)
        VALUES (${f.id}, ${cle}, ${f.sha256}, make_date(${f.annee}, 12, 31) + ${`${CONSERVATION_ANS} years`}::interval)`;
      await journaliser(tx, actor, "fichier.archiver", f.document_id, { cle, sha256: f.sha256 });
      archives.push({ fichierId: f.id, cle, sha256: f.sha256 });
    }
    return archives;
  });
}

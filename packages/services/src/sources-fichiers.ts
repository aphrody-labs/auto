import { isAbsolute, relative, resolve, extname, basename } from "node:path";
import { realpath, opendir, lstat, mkdir, chmod } from "node:fs/promises";
import {
  conserverFichier,
  sourceFichiers,
  withTenant,
  empreinteSha256,
  ErreurMetier,
  journaliser,
  type Sql,
  type SourceFichiers,
} from "@auto/store";
import { lireTableur, texteDocx } from "@auto/native";
import { ocrParDefaut } from "@auto/ingest";
import { deposer } from "./ingest";
import { deposerDevis } from "./devis-recus";
/** Racines accordées par l'opérateur à une entreprise précise ; UNC/SMB et NFS passent par les montages du serveur. */
export function racinesFichiers(tenantId: string, env = Bun.env): Record<string, string> {
  let conf: Record<string, { tenantId: string; chemin: string }>;
  try {
    conf = JSON.parse(env.AUTO_DOSSIERS_RACINES || "{}");
  } catch {
    throw new ErreurMetier("AUTO_DOSSIERS_RACINES invalide");
  }
  const racines = Object.fromEntries(
    Object.entries(conf)
      .filter(([, c]) => c && c.tenantId === tenantId && typeof c.chemin === "string" && isAbsolute(c.chemin))
      .map(([alias, c]) => [alias, c.chemin]),
  );
  if (env.AUTO_DOSSIERS_PARENT) {
    if (!isAbsolute(env.AUTO_DOSSIERS_PARENT) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(tenantId))
      throw new ErreurMetier("racine d’arrivages invalide");
    if (racines.arrivages) throw new ErreurMetier("alias arrivages réservé au dossier par entreprise");
    racines.arrivages = resolve(env.AUTO_DOSSIERS_PARENT, tenantId);
  }
  return racines;
}
/** Installation opt-in : seul le worker écrit les répertoires vides, l’API monte le parent en lecture seule. */
export async function preparerArrivages(sql: Sql, env = Bun.env) {
  const parent = env.AUTO_DOSSIERS_PARENT;
  if (!parent) return { entreprises: 0, sources: 0 };
  if (!isAbsolute(parent)) throw new ErreurMetier("AUTO_DOSSIERS_PARENT doit être absolu");
  const base = await realpath(parent);
  const tenants = await sql<
    { id: string }[]
  >`SELECT id FROM tenant WHERE supprime_at IS NULL AND suspendu_at IS NULL ORDER BY id`;
  let entreprises = 0,
    sources = 0;
  const dossiers = [
    ["clients", "clients", "index"],
    ["fournisseurs/documents", "fournisseurs", "index"],
    ["fournisseurs/devis", "fournisseurs", "devis"],
    ["fournisseurs/factures", "fournisseurs", "facture"],
    ["chantiers", "chantiers", "index"],
    ["livraisons", "livraisons", "index"],
    ["commandes", "commandes", "index"],
  ] as const;
  for (const { id } of tenants) {
    const racine = racinesFichiers(id, env).arrivages!;
    const cree = await mkdir(racine, { recursive: true, mode: 0o2770 });
    const canonique = await realpath(racine);
    if (!dedans(base, canonique)) throw new ErreurMetier("dossier d’entreprise hors périmètre");
    if (cree) await chmod(canonique, 0o2770);
    const deja = await withTenant(sql, id, (tx) => tx`SELECT id FROM source_fichiers WHERE racine='arrivages' LIMIT 1`);
    if (deja.length) continue;
    for (const [chemin] of dossiers) {
      let courant = canonique;
      for (const partie of chemin.split("/")) {
        courant = resolve(courant, partie);
        const nouveau = await mkdir(courant, { recursive: true, mode: 0o2770 });
        if (!dedans(canonique, await realpath(courant))) throw new ErreurMetier("sous-dossier hors périmètre");
        if (nouveau) await chmod(courant, 0o2770);
      }
    }
    await withTenant(sql, id, async (tx) => {
      for (const [chemin, segment, traitement] of dossiers) {
        const r =
          await tx`INSERT INTO source_fichiers(nom,racine,sous_dossier,segment,traitement) VALUES (${chemin},'arrivages',${chemin},${segment},${traitement}) ON CONFLICT (tenant_id,racine,sous_dossier) DO NOTHING RETURNING id`;
        sources += r.length;
      }
      await journaliser(tx, null, "arrivages.preparer", id);
    });
    entreprises++;
  }
  return { entreprises, sources };
}
const dedans = (racine: string, cible: string) => {
  const r = relative(racine, cible);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
export async function dossierSource(tenantId: string, s: Pick<SourceFichiers, "racine" | "sousDossier">) {
  if (!s || typeof s.racine !== "string" || typeof s.sousDossier !== "string")
    throw new ErreurMetier("configuration de dossier invalide");
  const autorisee = racinesFichiers(tenantId)[s.racine];
  if (!autorisee) throw new ErreurMetier("racine non autorisée pour cette entreprise");
  if (s.sousDossier.includes("\0") || s.sousDossier.split(/[\\/]/).some((p) => p === "..") || isAbsolute(s.sousDossier))
    throw new ErreurMetier("sous-dossier invalide");
  let racine: string, cible: string;
  try {
    racine = await realpath(autorisee);
    cible = await realpath(resolve(racine, s.sousDossier));
  } catch {
    throw new ErreurMetier("dossier inaccessible : vérifiez le montage et les droits du service");
  }
  if (!dedans(racine, cible)) throw new ErreurMetier("dossier hors de la racine autorisée");
  if (!(await lstat(cible)).isDirectory()) throw new ErreurMetier("dossier attendu");
  return { racine, cible };
}
export const MIMES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".txt": "text/plain",
};
export async function texteDocument(octets: Uint8Array<ArrayBuffer>, ext: string) {
  if ([".pdf", ".png", ".jpg", ".jpeg"].includes(ext)) return ocrParDefaut(octets);
  if (ext === ".docx") return texteDocx(octets);
  if ([".xlsx", ".csv"].includes(ext))
    return lireTableur(octets)
      .feuilles.map((f) => f.nom + "\n" + f.lignes.map((r) => r.join("\t")).join("\n"))
      .join("\n");
  return new TextDecoder().decode(octets);
}
type EntreeParcours = { entree: import("node:fs").Dirent | null; chemin: string; relatif: string };
function comparerChemins(a: string, b: string) {
  const x = a.split("/"),
    y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length - y.length;
}
async function* parcourir(
  cible: string,
  apres: string | null,
  dir = cible,
  niveau = 0,
): AsyncGenerator<EntreeParcours> {
  let entrees: import("node:fs").Dirent[] = [];
  try {
    if (!dedans(cible, await realpath(dir))) return;
    for await (const e of await opendir(dir)) {
      if (entrees.length >= 50000) throw new Error("trop d’entrées");
      entrees.push(e);
    }
  } catch (e) {
    if (niveau === 0) throw e;
    yield { entree: null, chemin: dir, relatif: relative(cible, dir).replaceAll("\\", "/") };
    return;
  }
  entrees.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entree of entrees) {
    if (entree.isSymbolicLink()) continue;
    const chemin = resolve(dir, entree.name),
      relatif = relative(cible, chemin).replaceAll("\\", "/");
    const comparaison = apres ? comparerChemins(relatif, apres) : 1;
    if (comparaison > 0) yield { entree, chemin, relatif };
    if (entree.isDirectory() && (!apres || comparaison > 0 || relatif === apres || apres.startsWith(relatif + "/"))) {
      if (niveau >= 64) yield { entree: null, chemin, relatif };
      else yield* parcourir(cible, apres, chemin, niveau + 1);
    }
  }
}
export async function synchroniserSource(
  sql: Sql,
  tenantId: string,
  id: string,
  actor: string | null = null,
  signal?: AbortSignal,
  options: { limite?: number } = {},
) {
  const limite = options.limite ?? 2000;
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > 2000) throw new ErreurMetier("limite de relève invalide");
  const [tenant] =
    await sql`SELECT id FROM tenant WHERE id=${tenantId} AND supprime_at IS NULL AND suspendu_at IS NULL`;
  if (!tenant) throw new ErreurMetier("entreprise inactive", [], 409);
  let s = await withTenant(sql, tenantId, (tx) => sourceFichiers(tx, id));
  if (!s.actif) throw new ErreurMetier("source désactivée", [], 409);
  const token = crypto.randomUUID();
  const pris = await withTenant(
    sql,
    tenantId,
    (tx) =>
      tx`UPDATE source_fichiers SET sync_token=${token},bail_jusqua=now()+interval '15 minutes',erreur=NULL WHERE id=${id} AND actif AND (bail_jusqua IS NULL OR bail_jusqua<now()) RETURNING id`,
  );
  if (!pris.length) throw new ErreurMetier("synchronisation déjà en cours", [], 409);
  const bilan = {
    nouveaux: 0,
    inchanges: 0,
    erreurs: [] as { chemin: string; message: string }[],
    limiteAtteinte: false,
    curseur: null as string | null,
  };
  let dernier = s.curseur ?? null;
  try {
    s = await withTenant(sql, tenantId, (tx) => sourceFichiers(tx, id));
    dernier = s.curseur ?? null;
    const { cible } = await dossierSource(tenantId, s);
    const debut = performance.now();
    let vus = 0;
    for await (const { entree, chemin, relatif } of parcourir(cible, dernier)) {
      signal?.throwIfAborted();
      if (++vus > limite || (vus > 1 && performance.now() - debut > 75000)) {
        bilan.limiteAtteinte = true;
        break;
      }
      const precedent = dernier;
      dernier = relatif;
      if (!entree) {
        bilan.erreurs.push({
          chemin: relatif,
          message: "dossier inaccessible, trop profond ou supérieur à 50 000 entrées",
        });
        continue;
      }
      if (entree.isDirectory()) continue;
      const ext = extname(entree.name).toLowerCase();
      if (!entree.isFile() || !MIMES[ext]) continue;
      try {
        const canonique = await realpath(chemin);
        if (!dedans(cible, canonique)) throw new Error("hors périmètre");
        const stat = await lstat(canonique);
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("taille ou type invalide");
        const octets = await Bun.file(canonique).bytes();
        if (octets.length > 20 * 1024 * 1024) throw new Error("fichier trop volumineux");
        const empreinte = empreinteSha256(octets);
        const existant = await withTenant(
          sql,
          tenantId,
          (tx) =>
            tx`SELECT id FROM fichier_indexe WHERE source_id=${id} AND chemin=${relatif} AND empreinte=${empreinte} AND (${s.traitement}='index' OR (${s.traitement}='devis' AND devis_id IS NOT NULL) OR (${s.traitement}='facture' AND recue_id IS NOT NULL))`,
        );
        if (existant.length) {
          bilan.inchanges++;
          continue;
        }
        const vivant = await withTenant(
          sql,
          tenantId,
          (tx) =>
            tx`UPDATE source_fichiers SET bail_jusqua=now()+interval '15 minutes' WHERE id=${id} AND sync_token=${token} RETURNING id`,
        );
        if (!vivant.length) throw new ErreurMetier("synchronisation interrompue", [], 409);
        const e = { contenu: octets, nom: basename(chemin), typeMime: MIMES[ext]!, canal: "api" as const };
        let recueId: string | null = null,
          devisId: string | null = null,
          texte = "";
        if (s.traitement === "devis") {
          if (![".pdf", ".png", ".jpg", ".jpeg", ".docx"].includes(ext)) continue;
          const r = await deposerDevis(sql, tenantId, actor, e, signal);
          devisId = r.devis.id;
          texte = r.devis.texte;
        } else if (s.traitement === "facture") {
          if (![".pdf", ".xml"].includes(ext)) continue;
          const r = await deposer(sql, tenantId, actor, e, signal);
          recueId = r.recue.id;
          texte = JSON.stringify(r.recue.facture ?? {});
        } else texte = await texteDocument(octets, ext);
        signal?.throwIfAborted();
        await withTenant(sql, tenantId, async (tx) => {
          const fichierId = await conserverFichier(tx, e);
          await tx`INSERT INTO fichier_indexe (source_id,fichier_id,chemin,nom,segment,texte,empreinte,recue_id,devis_id) VALUES (${id},${fichierId},${relatif},${e.nom},${s.segment},${texte.slice(0, 100000)},${empreinte},${recueId},${devisId}) ON CONFLICT (tenant_id,source_id,chemin,empreinte) DO UPDATE SET recue_id=coalesce(excluded.recue_id,fichier_indexe.recue_id),devis_id=coalesce(excluded.devis_id,fichier_indexe.devis_id),texte=excluded.texte`;
          await journaliser(tx, actor, "fichier.indexer", id, { chemin: relatif });
        });
        bilan.nouveaux++;
      } catch {
        if (signal?.aborted) {
          dernier = precedent;
          signal.throwIfAborted();
        }
        bilan.erreurs.push({ chemin: relatif, message: "lecture ou extraction impossible" });
      }
    }
    bilan.curseur = bilan.limiteAtteinte ? dernier : null;
    await withTenant(
      sql,
      tenantId,
      (tx) =>
        tx`UPDATE source_fichiers SET curseur=${bilan.curseur},synchronise_at=now(),erreur=${bilan.erreurs.length ? `${bilan.erreurs.length} fichier(s) en échec` : bilan.limiteAtteinte ? "relève partielle : continuer le parcours" : null} WHERE id=${id} AND sync_token=${token}`,
    );
    return bilan;
  } catch {
    await withTenant(
      sql,
      tenantId,
      (tx) =>
        tx`UPDATE source_fichiers SET curseur=${dernier},erreur='connexion au dossier impossible' WHERE id=${id} AND sync_token=${token}`,
    );
    throw new ErreurMetier("connexion au dossier impossible", [], 422);
  } finally {
    await withTenant(
      sql,
      tenantId,
      (tx) => tx`UPDATE source_fichiers SET sync_token=NULL,bail_jusqua=NULL WHERE id=${id} AND sync_token=${token}`,
    );
  }
}

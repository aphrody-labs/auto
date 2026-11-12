// Automatisations d'une entreprise : validation des définitions, exécution (API pour les essais et les
// webhooks synchrones, worker pour les événements et les crons), secrets chiffrés et URL de webhook signée.
// Le moteur (`@auto/automate`) ne fait aucun accès extérieur lui-même : les services ci-dessous les portent,
// avec la garde réseau, la boîte mail du tenant et l'API d'auto aux droits de l'auteur du workflow.
import {
  declencheurDe,
  ErreurDefinition,
  executer,
  secretsCites,
  valider,
  type Definition,
  type Element,
  type Resultat,
  type Services,
} from "@auto/automate";
import {
  debuterExecution,
  ecrireMemoire,
  lireMemoire,
  ErreurMetier,
  lireAutomatisation,
  secretsChiffres,
  terminerExecution,
  withTenant,
  type Ecriture,
  type Execution,
  type Sql,
  type Tx,
} from "@auto/store";
import { chiffrer, cleMaitre, cleTemporaire, dechiffrer } from "@auto/tenancy";
import {
  caviarderPdf,
  champsDocx,
  creerDocx,
  creerPptx,
  docxEnPdf,
  ecrireXlsx,
  extrairePagesPdf,
  fusionnerPdf,
  lireTableur,
  nombrePagesPdf,
  pptxEnPdf,
  remplirDocx,
  signerPdf,
  textePdf,
  texteDocx,
  verifierSignaturesPdf,
} from "@auto/native";
import { servicesConnaissance } from "./connaissance";
import { envoyerTexte } from "./mail";
import { servicesMedia } from "./media";
import { executerScript } from "./script";
import { PRIVE } from "./webhooks";

/** Info de dérivation de la clé des secrets d'automatisation : propre au tenant. */
export const infoSecretAutomatisation = (tenantId: string) => `automatisation:${tenantId}`;

export const chiffrerSecret = (tenantId: string, valeur: string) =>
  chiffrer(infoSecretAutomatisation(tenantId), new TextEncoder().encode(valeur));

/** Corps de création ou de modification, validé et complété par le déclencheur extrait de la définition. */
export async function ecriture(
  tx: Tx,
  b: { nom?: unknown; description?: unknown; actif?: unknown; definition?: unknown },
  avant?: { nom: string; description: string; actif: boolean; definition: unknown },
): Promise<Ecriture> {
  const nom = String(b.nom ?? avant?.nom ?? "").trim();
  if (!nom || nom.length > 120) throw new ErreurMetier("nom : 1 à 120 caractères");
  let def: Definition;
  try {
    def = valider(b.definition ?? avant?.definition);
  } catch (e) {
    if (e instanceof ErreurDefinition) throw new ErreurMetier(e.message, e.details);
    throw e;
  }
  const cites = secretsCites(def);
  const connus = new Set((await secretsChiffres(tx, cites)).map((s) => s.nom));
  const manquants = cites.filter((c) => !connus.has(c));
  const actif = Boolean(b.actif ?? avant?.actif ?? false);
  if (actif && manquants.length)
    throw new ErreurMetier(
      "secrets inconnus",
      manquants.map((m) => `$secret.${m}`),
    );
  const d = declencheurDe(def);
  const p = d.parametres as { types?: string[]; cron?: string; fuseau?: string };
  const declencheur = d.type.slice("declencheur.".length) as Ecriture["declencheur"];
  return {
    nom,
    description: String(b.description ?? avant?.description ?? "").slice(0, 2000),
    actif,
    definition: def,
    declencheur,
    evenements: declencheur === "evenement" ? (p.types ?? []) : [],
    cron: declencheur === "planifie" ? (p.cron ?? null) : null,
    fuseau: declencheur === "planifie" ? (p.fuseau ?? "Europe/Paris") : null,
  };
}

/**
 * Garde réseau des nœuds HTTP : http(s) seulement, aucun identifiant dans l'URL et, en production, aucune
 * adresse interne (réseau de l'opérateur, métadonnées du cloud). Pas de suivi de redirection automatique : une
 * redirection vers une adresse interne contournerait la garde.
 */
export function gardeUrl(
  brute: string,
  production = Bun.env.NODE_ENV === "production",
  permis = Bun.env.AUTO_HOTES_PERMIS ?? "",
): URL {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    throw new Error(`URL invalide : ${brute}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL http ou https exigée");
  if (u.username || u.password) throw new Error("identifiants interdits dans l'URL");
  const hote = u.hostname.toLowerCase();
  // Un nom sans point (« auto-api », « postgres ») désigne un conteneur ou une machine du réseau local.
  const interne =
    hote === "localhost" ||
    hote.endsWith(".localhost") ||
    hote.endsWith(".internal") ||
    hote.endsWith(".local") ||
    (!hote.includes(".") && !hote.includes(":")) ||
    PRIVE.some((r) => r.test(hote));
  if (production && interne && !reseauLocal() && !hotesPermis(permis).includes(hote))
    throw new Error("adresse interne refusée");
  return u;
}

/**
 * Réseau local entièrement joignable (`AUTO_RESEAU_LOCAL=permis`) : réservé à une installation dont on contrôle tous
 * les comptes (Aphrody Box chez soi), pour atteindre Home Assistant, Nextcloud ou une imprimante du réseau.
 */
const reseauLocal = () => Bun.env.AUTO_RESEAU_LOCAL === "permis";

/** Hôtes internes joignables malgré tout (`AUTO_HOTES_PERMIS`, séparés par des virgules ; ex. `ollama`). */
const hotesPermis = (liste = Bun.env.AUTO_HOTES_PERMIS ?? "") =>
  liste
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

const fetchGarde: Services["fetch"] = (url, init) =>
  fetch(gardeUrl(url), { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });

/** API d'auto vue du worker et de l'API elle-même. */
const urlApi = () => (Bun.env.AUTO_API_URL ?? `http://localhost:${Bun.env.PORT ?? 3000}`).replace(/\/+$/, "");

/**
 * Clé d'API temporaire de l'auteur du workflow pour les nœuds « Action auto » : une clé Better Auth
 * ordinaire qui expire seule et que l'exécution supprime à la fin. Droits = rôle actuel de l'auteur.
 */
const jetonTemporaire = (sql: Sql, tenantId: string, userId: string, nom: string) =>
  cleTemporaire(sql, tenantId, userId, nom);

export interface Lancement {
  tenantId: string;
  automatisationId: string;
  origine: string;
  entree: Element[];
  signal?: AbortSignal;
  /** Niveau d'imbrication : 0 pour un workflow lancé directement, +1 par sous-workflow. */
  profondeur?: number;
}

/** Sous-workflows imbriqués au plus : un appel en boucle s'arrête vite et clairement. */
export const PROFONDEUR_MAX = 3;

/** Services réels d'une exécution ; `fermer` révoque le jeton temporaire. */
async function servicesPour(
  sql: Sql,
  tenantId: string,
  auteur: string | null,
  nom: string,
  automatisationId?: string,
  profondeur = 0,
) {
  let temporaire: Awaited<ReturnType<typeof jetonTemporaire>> | null = null;
  // Essai : mémoire éphémère, l'état d'un workflow enregistré n'est pas modifié par un essai.
  const ephemere = new Map<string, unknown>();
  const services: Services = {
    memoire: automatisationId
      ? {
          lire: (cle) => withTenant(sql, tenantId, (tx) => lireMemoire(tx, automatisationId, cle)),
          ecrire: (cle, v) => withTenant(sql, tenantId, (tx) => ecrireMemoire(tx, automatisationId, cle, v)),
        }
      : { lire: async (cle) => ephemere.get(cle), ecrire: async (cle, v) => void ephemere.set(cle, v) },
    fetch: fetchGarde,
    envoyerMail: (m) => envoyerTexte(sql, tenantId, auteur, m),
    script: executerScript,
    ...servicesMedia((u) => gardeUrl(u)),
    tableur: { ecrire: (feuille) => ecrireXlsx({ feuilles: [feuille] }), lire: (octets) => lireTableur(octets) },
    pdf: { fusionner: fusionnerPdf, pages: extrairePagesPdf, nombrePages: nombrePagesPdf, texte: textePdf },
    word: { creer: creerDocx, champs: champsDocx, remplir: remplirDocx, enPdf: docxEnPdf, texte: texteDocx },
    documents: {
      caviarder: caviarderPdf,
      signer: signerPdf,
      signatures: verifierSignaturesPdf,
      presentation: creerPptx,
      presentationEnPdf: pptxEnPdf,
    },
    connaissance: servicesConnaissance(sql, tenantId, auteur, fetchGarde),
    async sousWorkflow(id, entree, signal) {
      if (id === automatisationId) throw new Error("un workflow ne peut pas s'exécuter lui-même");
      if (profondeur >= PROFONDEUR_MAX) throw new Error(`plus de ${PROFONDEUR_MAX} niveaux de sous-workflows`);
      const { resultat } = await lancer(sql, {
        tenantId,
        automatisationId: id,
        origine: `workflow:${automatisationId ?? "essai"}`,
        entree,
        signal,
        profondeur: profondeur + 1,
      });
      if (resultat.statut === "erreur") throw new Error(`sous-workflow en échec : ${resultat.erreur?.message ?? "?"}`);
      return resultat.sortie;
    },
    async appelerAuto(methode, chemin, corps) {
      if (!auteur) throw new Error("auteur du workflow inconnu : actions auto impossibles");
      temporaire ??= await jetonTemporaire(sql, tenantId, auteur, `automatisation:${nom}`.slice(0, 100));
      const init: RequestInit = {
        method: methode,
        headers: { authorization: `Bearer ${temporaire.jeton}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(30_000),
      };
      if (corps !== undefined && methode !== "GET") init.body = JSON.stringify(corps);
      const r = await fetch(`${urlApi()}${chemin}`, init);
      const texte = await r.text();
      let valeur: unknown = texte;
      try {
        valeur = texte ? JSON.parse(texte) : null;
      } catch {}
      return { statut: r.status, corps: valeur };
    },
  };
  return { services, fermer: async () => temporaire?.revoquer() };
}

async function secretsClairs(sql: Sql, tenantId: string, def: Definition) {
  const chiffres = await withTenant(sql, tenantId, (tx) => secretsChiffres(tx, secretsCites(def)));
  const clairs: Record<string, string> = {};
  for (const s of chiffres)
    clairs[s.nom] = new TextDecoder().decode(await dechiffrer(infoSecretAutomatisation(tenantId), s.valeur));
  return clairs;
}

/** Retire les secrets des étapes conservées (un nœud peut recopier une valeur résolue dans sa sortie). */
function masquer(r: Resultat, secrets: Record<string, string>): Resultat {
  const valeurs = Object.values(secrets).filter((v) => v.length >= 6);
  if (!valeurs.length) return r;
  const s = valeurs.reduce((t, v) => t.replaceAll(JSON.stringify(v).slice(1, -1), "••••••"), JSON.stringify(r));
  return JSON.parse(s) as Resultat;
}

/** Exécute un workflow enregistré et consigne l'exécution ; renvoie l'exécution et la sortie. */
export async function lancer(sql: Sql, l: Lancement): Promise<{ execution: Execution; resultat: Resultat }> {
  const a = await withTenant(sql, l.tenantId, (tx) => lireAutomatisation(tx, l.automatisationId));
  if (!a) throw new ErreurMetier("automatisation introuvable", [], 404);
  const def = valider(a.definition);
  const executionId = await withTenant(sql, l.tenantId, (tx) => debuterExecution(tx, a.id, l.origine));
  const secrets = await secretsClairs(sql, l.tenantId, def);
  const { services, fermer } = await servicesPour(sql, l.tenantId, a.createdBy, a.nom, a.id, l.profondeur ?? 0);
  let resultat: Resultat;
  try {
    resultat = masquer(
      await executer(def, l.entree, {
        services,
        workflow: { id: a.id, nom: a.nom },
        executionId,
        secrets,
        signal: l.signal,
      }),
      secrets,
    );
  } catch (e) {
    resultat = { statut: "erreur", etapes: [], erreur: { noeud: "", message: String(e) }, sortie: [] };
  } finally {
    await fermer();
  }
  const execution = await withTenant(sql, l.tenantId, (tx) =>
    terminerExecution(tx, executionId, {
      statut: resultat.statut,
      etapes: resultat.etapes,
      erreur: resultat.erreur
        ? `${resultat.erreur.noeud ? `${resultat.erreur.noeud} : ` : ""}${resultat.erreur.message}`
        : null,
    }),
  );
  return { execution: { ...execution, etapes: resultat.etapes }, resultat };
}

/** Essai d'une définition non enregistrée (bouton « Tester » de l'éditeur) : rien n'est consigné. */
export async function essayer(
  sql: Sql,
  tenantId: string,
  userId: string,
  definition: unknown,
  entree: Element[],
): Promise<Execution & { sortie: Element[] }> {
  let def: Definition;
  try {
    def = valider(definition);
  } catch (e) {
    if (e instanceof ErreurDefinition) throw new ErreurMetier(e.message, e.details);
    throw e;
  }
  const secrets = await secretsClairs(sql, tenantId, def);
  const { services, fermer } = await servicesPour(sql, tenantId, userId, "essai");
  const debut = new Date().toISOString();
  try {
    const r = masquer(
      await executer(def, entree, {
        services,
        workflow: { id: "essai", nom: "Essai" },
        executionId: "essai",
        secrets,
        dureeMaxMs: 60_000,
      }),
      secrets,
    );
    return {
      id: "essai",
      automatisationId: "essai",
      origine: "essai",
      statut: r.statut,
      erreur: r.erreur ? `${r.erreur.noeud} : ${r.erreur.message}` : null,
      debut,
      fin: new Date().toISOString(),
      etapes: r.etapes,
      sortie: r.sortie,
    };
  } finally {
    await fermer();
  }
}

// ── URL secrète des webhooks entrants ──────────────────────────────────────
// Jeton sans état `<charge>.<HMAC>` (clé dérivée de la clé maître, usage propre) portant le tenant et le
// workflow : rien à stocker, et l'URL d'un workflow ne déclenche jamais celui d'une autre entreprise.

const b64 = (o: Uint8Array) => o.toBase64({ alphabet: "base64url", omitPadding: true });

async function cleCrochet(maitre: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey("raw", maitre, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("auto/crochet/v1"),
      info: new TextEncoder().encode("crochet"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signerCrochet(c: { t: string; a: string }, maitre = cleMaitre()): Promise<string> {
  const charge = b64(new TextEncoder().encode(JSON.stringify(c)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await cleCrochet(maitre), new TextEncoder().encode(charge)),
  );
  return `${charge}.${b64(sig)}`;
}

export async function verifierCrochet(jeton: string, maitre = cleMaitre()): Promise<{ t: string; a: string } | null> {
  const [charge, sig] = jeton.split(".");
  if (!charge || !sig || jeton.length > 400) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await cleCrochet(maitre),
      Uint8Array.fromBase64(sig, { alphabet: "base64url" }),
      new TextEncoder().encode(charge),
    );
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(charge, { alphabet: "base64url" })));
    return typeof c?.t === "string" && typeof c?.a === "string" ? c : null;
  } catch {
    return null;
  }
}

/** Élément d'entrée d'un webhook reçu : méthode, requête, en-têtes (sans cookies ni autorisation), corps. */
export async function elementWebhook(req: Request): Promise<Element> {
  const u = new URL(req.url);
  const entetes = Object.fromEntries(
    [...req.headers].filter(([k]) => !["cookie", "authorization", "x-forwarded-for"].includes(k.toLowerCase())),
  );
  const brut = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  if (brut.length > 1_000_000) throw new ErreurMetier("corps trop volumineux (1 Mo au plus)", [], 413);
  let corps: unknown = brut;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("json") && brut) {
    try {
      corps = JSON.parse(brut);
    } catch {
      throw new ErreurMetier("JSON invalide", [], 400);
    }
  } else if (type.includes("application/x-www-form-urlencoded")) corps = Object.fromEntries(new URLSearchParams(brut));
  return { json: { methode: req.method, requete: Object.fromEntries(u.searchParams), entetes, corps } };
}

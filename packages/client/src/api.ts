// Client typé de l'API `/v1`. Dans le navigateur : même origine, cookie de session HttpOnly envoyé par le
// navigateur ; toute mutation part en `application/json` (exigé par l'anti-CSRF de l'API).
import type { Categorie, Declencheur, Definition, Etape, Modele } from "@auto/automate";
import type { Document, Employe, Ligne, Partie, Statut, Totaux, Type, TypeAbsence } from "@auto/domain";
import type {
  Absence,
  ARelancer,
  Cellule,
  ChampClient,
  ChampProduit,
  Client,
  FicheEmploye,
  Ligne as LigneDocument,
  ModePaiement,
  Paiement,
  Produit,
  Recue,
  ResultatImport,
  SoldeConges,
  Fournisseur,
  Chantier,
  PieceChantier,
  DossierChantier,
  DossierFournisseur,
  ResultatGestion,
  AffectationAchat,
  DevisRecu,
  SourceFichiers,
  FichierIndexe,
  DocumentAtelier,
  FormatAtelier,
  OperationAtelier,
} from "@auto/store";

export type { Absence, ARelancer, Client, FicheEmploye, Paiement, Produit, Recue, ResultatImport, SoldeConges };
export type { Fournisseur, Chantier, PieceChantier, DossierChantier, DossierFournisseur, AffectationAchat };
export type { DevisRecu, SourceFichiers, FichierIndexe };
export type { DocumentAtelier, FormatAtelier };
export interface ApercuAtelier {
  format: FormatAtelier;
  champs?: string[];
  extrait?: string;
  pages?: number;
  feuilles?: { nom: string; lignes: number; apercu: unknown[][] }[];
  avertissements?: string[];
}

export type Role = "owner" | "admin" | "comptable" | "lecture" | "rh";

export interface EntrepriseMembre {
  id: string;
  nom: string;
  siren: string;
  role: Role;
  suspendue: boolean;
}

export interface Membre {
  id: string;
  userId: string;
  email: string;
  nom: string;
  role: Role;
  depuis: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  statut: "en_attente" | "acceptee" | "revoquee" | "expiree";
  createdAt: string;
}

export interface CleApi {
  id: string;
  nom: string | null;
  debut: string | null;
  email: string | null;
  creeLe: string;
  expireLe: string | null;
  dernierUsage: string | null;
}

export interface Moi {
  segments?: ("clients" | "fournisseurs" | "chantiers" | "livraisons" | "commandes")[];
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  nom: string;
  deuxFacteurs: boolean;
  entreprises: EntrepriseMembre[];
  entreprise: {
    id: string;
    nom: string;
    siren: string;
    siret: string;
    adresse: string;
    tvaIntracom: string | null;
    franchiseTva: boolean;
  };
}

export type DocumentApi = LigneDocument & { totaux: Totaux };

/** Brouillon envoyé à l'API : l'émetteur et la franchise sont imposés par le serveur. */
export type BrouillonApi = Omit<Document, "emetteur" | "client"> & {
  client?: Partie;
  clientId?: string | null;
  chantierId?: string | null;
};

export interface Apercu {
  format: string;
  feuilles: { nom: string; lignes: number }[];
  entete: Cellule[];
  apercu: Cellule[][];
  lignes: number;
  avertissements: string[];
  nomFeuille: string;
  correspondance: {
    clients: Partial<Record<ChampClient, number>>;
    produits: Partial<Record<ChampProduit, number>>;
  };
}

export interface GabaritApi {
  couleur: string | null;
  piedDePage: string | null;
  logo: { largeur: number; hauteur: number } | null;
}

export type PlanId = "gratuit" | "pro" | "business";

export interface PlanApi {
  id: PlanId;
  nom: string;
  prixHtCents: { mensuel: number; annuel: number };
  essaiJours: number;
  quotas: Record<string, number | null>;
}

export interface AbonnementApi {
  plan: PlanId;
  statut: string;
  planEffectif: PlanId;
  periode: string;
  consommation: { ressource: string; utilise: number; limite: number | null }[];
  [cle: string]: unknown;
}

export type { Definition, Etape, Modele };

export type StatutExecution = "en_cours" | "succes" | "erreur";

/** Workflow tel que listé : sans sa définition. */
export interface ResumeAutomatisation {
  id: string;
  nom: string;
  description: string | null;
  actif: boolean;
  declencheur: Declencheur;
  createdAt: string;
  updatedAt: string;
  derniereExecution: { id: string; statut: StatutExecution; debut: string } | null;
}

export interface Automatisation extends ResumeAutomatisation {
  definition: Definition;
}

export interface Execution {
  id: string;
  automatisationId: string | null;
  origine: string;
  statut: StatutExecution;
  erreur: string | null;
  debut: string;
  fin: string | null;
  etapes: Etape[];
}

export type ResumeExecution = Omit<Execution, "etapes">;

/** Version précédente d'un workflow (50 au plus, la plus récente d'abord). */
export interface VersionAutomatisation {
  numero: number;
  nom: string;
  description: string;
  definition: Definition;
  auteur: string | null;
  createdAt: string;
}

/** Schéma JSON (draft 2020-12) des paramètres d'un type de nœud, tel que le produit Zod. */
export interface SchemaJson {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaJson;
  properties?: Record<string, SchemaJson>;
  required?: string[];
  additionalProperties?: unknown;
  description?: string;
}

/** Entrée du catalogue des nœuds (`catalogueJson()` du moteur). */
export interface TypeNoeudApi {
  type: string;
  libelle: string;
  description: string;
  categorie: Categorie;
  /** Nom Material Symbols. */
  icone: string;
  sorties: string[] | "dynamiques";
  parametres: SchemaJson;
}

export interface Secret {
  id: string;
  nom: string;
  createdAt: string;
}

export class ErreurApi extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

export interface OptionsClient {
  /** Origine de l'API (vide dans le navigateur : même origine). */
  base?: string;
  fetch?: typeof fetch;
  /** Jeton Bearer (tests, intégrations) ; le navigateur utilise le cookie. */
  jeton?: string;
}
export interface ConnexionPa {
  plateforme: string;
  mandatReference: string;
  connecteLe: string;
  webhook: string;
}
export interface ConfigurationPa {
  plateforme: "b2brouter";
  identifiants: { cleApi: string; compte: string; secretWebhook: string };
  mandat: { signataire: string; qualite: string; date: string; perimetre: ("emission" | "reception" | "ereporting")[] };
}
export interface ResultatImportFichier {
  id: string;
  fichierId: string;
  nom: string;
  cheminRelatif: string;
  segment: string;
  doublon: boolean;
  devisId?: string | null;
  recueId?: string | null;
}

export function clientApi(o: OptionsClient = {}) {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.base ?? "";

  async function appel<T>(methode: string, chemin: string, corps?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (methode !== "GET") headers["content-type"] = "application/json";
    if (o.jeton) headers.authorization = `Bearer ${o.jeton}`;
    let res: Response;
    try {
      res = await f(`${base}${chemin}`, {
        method: methode,
        headers,
        credentials: "same-origin",
        body: methode === "GET" ? undefined : JSON.stringify(corps ?? {}),
      });
    } catch {
      throw new ErreurApi("Serveur injoignable : vérifiez votre connexion.", 0);
    }
    const texte = await res.text();
    let json: unknown = null;
    try {
      json = texte ? JSON.parse(texte) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json ?? {}) as { erreur?: string; details?: string[] };
      throw new ErreurApi(e.erreur ?? `Erreur ${res.status}`, res.status, e.details ?? []);
    }
    return json as T;
  }

  const get = <T>(c: string) => appel<T>("GET", c);
  const post = <T>(c: string, b?: unknown) => appel<T>("POST", c, b);
  const put = <T>(c: string, b?: unknown) => appel<T>("PUT", c, b);
  const del = (c: string) => appel<null>("DELETE", c);
  const qs = (p: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => !!e[1])).toString();
    return s ? `?${s}` : "";
  };

  return {
    /** URL d'un fichier servi par l'API (PDF, XML, exports) : ouverte ou téléchargée par le navigateur. */
    url: (chemin: string) => `${base}${chemin}`,
    connexionPa: async () => {
      try {
        return await get<ConnexionPa>("/v1/pa");
      } catch (e) {
        if (e instanceof ErreurApi && e.status === 404) return null;
        throw e;
      }
    },
    connecterPa: (configuration: ConfigurationPa) => put<ConnexionPa>("/v1/pa", configuration),
    deconnecterPa: () => del("/v1/pa"),

    inscrire: (i: {
      email: string;
      motDePasse: string;
      entreprise: { nom: string; siret: string; adresse: string; franchiseTva?: boolean };
    }) => post<{ userId: string; tenantId: string }>("/v1/auth/inscription", i),
    connecter: (email: string, motDePasse: string) =>
      post<{ userId: string; tenantId: string }>("/v1/auth/connexion", { email, motDePasse }),
    deconnecter: () => post<null>("/v1/auth/deconnexion"),
    moi: () => get<Moi>("/v1/moi"),
    siren: (siren: string) =>
      get<{ siren: string; nom: string; siretSiege: string; adresse: string }>(`/v1/siren/${siren}`),

    documents: (type?: Type) => get<DocumentApi[]>(`/v1/documents${qs({ type })}`),
    document: (id: string) => get<DocumentApi>(`/v1/documents/${id}`),
    creerDocument: (d: BrouillonApi) => post<DocumentApi>("/v1/documents", d),
    modifierDocument: (id: string, d: BrouillonApi) => put<DocumentApi>(`/v1/documents/${id}`, d),
    supprimerDocument: (id: string) => appel<null>("DELETE", `/v1/documents/${id}`),
    emettre: (id: string) => post<DocumentApi>(`/v1/documents/${id}/emettre`),
    /** Lien public d'un devis émis : le client l'accepte ou le refuse sans compte (30 jours). */
    /** Lien de paiement en ligne d'une facture émise (paiement par carte sur le compte Stripe de l'entreprise). */
    lienPaiement: (id: string) => post<{ url: string; expire: string }>(`/v1/documents/${id}/lien-paiement`, {}),
    encaissement: () =>
      get<{ actif: boolean; fournisseur: string | null; apercu: string | null }>("/v1/parametres/encaissement"),
    enregistrerEncaissement: (cle: string) => put<null>("/v1/parametres/encaissement", { cle }),
    supprimerEncaissement: () => appel<null>("DELETE", "/v1/parametres/encaissement"),
    lienPublic: (id: string) => post<{ url: string; expire: string }>(`/v1/documents/${id}/lien-public`, {}),
    changerStatut: (id: string, statut: Statut) => post<DocumentApi>(`/v1/documents/${id}/statut`, { statut }),
    paiements: (id: string) =>
      get<{ ttcCents: number; resteCents: number; paiements: Paiement[] }>(`/v1/documents/${id}/paiements`),
    payer: (id: string, p: { date: string; montantCents: number; mode: ModePaiement; reference?: string }) =>
      post<{ paiement: Paiement; resteCents: number }>(`/v1/documents/${id}/paiements`, p),
    relancer: (id: string, niveau: 1 | 2 | 3, canal: "mail" | "courrier" | "telephone") =>
      post<null>(`/v1/documents/${id}/relances`, { niveau, canal }),
    aRelancer: (date?: string) => get<ARelancer[]>(`/v1/relances${qs({ date })}`),

    clients: (q?: string) => get<Client[]>(`/v1/clients${qs({ q })}`),
    fournisseurs: () => get<Fournisseur[]>("/v1/fournisseurs"),
    segmentsMembres: () => get<{ userId: string; segments: NonNullable<Moi["segments"]> }[]>("/v1/membres/segments"),
    modifierSegments: (id: string, segments: NonNullable<Moi["segments"]>) =>
      put(`/v1/membres/${id}/segments`, { segments }),
    racinesFichiers: () => get<string[]>("/v1/sources-fichiers/racines"),
    sourcesFichiers: () => get<SourceFichiers[]>("/v1/sources-fichiers"),
    atelier: () => get<DocumentAtelier[]>("/v1/atelier"),
    documentAtelier: (id: string) => get<{ document: DocumentAtelier; inspection: ApercuAtelier }>(`/v1/atelier/${id}`),
    creerAtelier: (format: "word" | "excel", nom: string, segment: string) =>
      post<DocumentAtelier>("/v1/atelier", { format, nom, segment }),
    importerAtelier: (p: { nom?: string; fichier?: string; indexId?: string; segment: string }) =>
      post<DocumentAtelier>("/v1/atelier/importer", p),
    sauverAtelier: (id: string, revision: number, fichier: string) =>
      put<DocumentAtelier>(`/v1/atelier/${id}/fichier`, { revision, fichier }),
    versionsAtelier: (id: string) => get<{ revision: number; createdAt: string }[]>(`/v1/atelier/${id}/versions`),
    extraireDevisAtelier: (id: string, revision: number) =>
      post<{ devis: DevisRecu; doublon: boolean }>(`/v1/atelier/${id}/extraire-devis`, { revision }),
    restaurerAtelier: (id: string, revision: number, version: number) =>
      post<DocumentAtelier>(`/v1/atelier/${id}/restaurer`, { revision, version }),
    operationAtelier: (id: string, revision: number, operation: OperationAtelier) =>
      post<DocumentAtelier>(`/v1/atelier/${id}/operations`, { revision, operation }),
    archiverAtelier: (id: string, archive: boolean) =>
      appel<DocumentAtelier>("PATCH", `/v1/atelier/${id}`, { archive }),
    sauverSource: (p: Omit<SourceFichiers, "id" | "synchroniseAt" | "erreur">, id?: string) =>
      id ? put<SourceFichiers>(`/v1/sources-fichiers/${id}`, p) : post<SourceFichiers>("/v1/sources-fichiers", p),
    synchroniserSource: (id: string) =>
      post<{
        nouveaux: number;
        inchanges: number;
        erreurs: { chemin: string; message: string }[];
        limiteAtteinte: boolean;
      }>(`/v1/sources-fichiers/${id}/synchroniser`),
    fichiersIndexes: () => get<FichierIndexe[]>("/v1/fichiers-indexes"),
    rechercherFichiersIndexes: (q = "", page = 0) =>
      get<{ fichiers: FichierIndexe[]; suite: boolean }>(
        `/v1/fichiers-indexes/recherche${qs({ q, page: String(page + 1) })}`,
      ),
    importerFichierLocal: async (
      fichier: File,
      cheminRelatif: string,
      segment: string,
      cible: "index" | "devis" | "facture" = "index",
      signal?: AbortSignal,
    ): Promise<ResultatImportFichier> => {
      const body = new FormData();
      body.set("fichier", fichier, fichier.name);
      body.set("cheminRelatif", cheminRelatif);
      body.set("segment", segment);
      body.set("cible", cible);
      let res: Response;
      try {
        res = await f(`${base}/v1/imports-fichiers`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "x-auto-import": "1",
            ...(o.jeton ? { authorization: `Bearer ${o.jeton}` } : {}),
          },
          body,
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new ErreurApi("Serveur injoignable : vérifiez votre connexion puis reprenez l’import.", 0);
      }
      const resultat = await res.json().catch(() => null);
      if (!res.ok) throw new ErreurApi(resultat?.erreur ?? `Import refusé (${res.status})`, res.status);
      if (!resultat?.id) throw new ErreurApi("Réponse d’import incomplète. Réessayez le fichier.", 502);
      return resultat;
    },
    devisRecus: () => get<DevisRecu[]>("/v1/devis-recus"),
    deposerDevis: (fichier: string, nom: string, typeMime: string) =>
      post<{ devis: DevisRecu; doublon: boolean }>("/v1/devis-recus", { fichier, nom, typeMime }),
    deciderDevis: (id: string, statut: "valide" | "rejete", data?: DevisRecu["data"]) =>
      post<DevisRecu>(`/v1/devis-recus/${id}/decision`, { statut, data }),
    reextraireDevis: (id: string) => post<DevisRecu>(`/v1/devis-recus/${id}/reextraire`, {}),
    brouillonDevisRecu: (id: string, clientId: string, chantierId?: string, type: "devis" | "facture" = "devis") =>
      post<DocumentApi>(`/v1/devis-recus/${id}/brouillon`, { clientId, chantierId, type }),
    rechercherGestion: (q: string) =>
      get<{ resultats: Omit<ResultatGestion, "total">[]; total: number }>(`/v1/recherche-gestion${qs({ q })}`),
    dossierFournisseur: (id: string) => get<DossierFournisseur>(`/v1/fournisseurs/${id}/dossier`),
    creerFournisseur: (p: Omit<Fournisseur, "id">) => post<Fournisseur>("/v1/fournisseurs", p),
    modifierFournisseur: (id: string, p: Omit<Fournisseur, "id">) => put<Fournisseur>(`/v1/fournisseurs/${id}`, p),
    chantiers: () => get<Chantier[]>("/v1/chantiers"),
    chantier: (id: string) => get<DossierChantier>(`/v1/chantiers/${id}`),
    creerChantier: (c: Omit<Chantier, "id">) => post<Chantier>("/v1/chantiers", c),
    modifierChantier: (id: string, c: Omit<Chantier, "id">) => put<Chantier>(`/v1/chantiers/${id}`, c),
    affectationDocument: (id: string) => get<{ chantierId: string | null }>(`/v1/documents/${id}/chantier`),
    affecterDocument: (id: string, chantierId: string | null) =>
      put<{ chantierId: string | null }>(`/v1/documents/${id}/chantier`, { chantierId }),
    affectationAchat: (id: string) => get<AffectationAchat | null>(`/v1/factures-recues/${id}/affectation`),
    affecterAchat: (id: string, fournisseurId: string, chantierId: string | null) =>
      put<AffectationAchat>(`/v1/factures-recues/${id}/affectation`, { fournisseurId, chantierId }),
    piecesChantier: () => get<PieceChantier[]>("/v1/pieces-chantier"),
    creerPieceChantier: (p: Omit<PieceChantier, "id">) => post<PieceChantier>("/v1/pieces-chantier", p),
    modifierPieceChantier: (id: string, p: Omit<PieceChantier, "id">) =>
      put<PieceChantier>(`/v1/pieces-chantier/${id}`, p),
    client: (id: string) => get<Client>(`/v1/clients/${id}`),
    creerClient: (p: Partie) => post<Client>("/v1/clients", p),
    modifierClient: (id: string, p: Partie) => put<Client>(`/v1/clients/${id}`, p),
    produits: () => get<Produit[]>("/v1/produits"),
    creerProduit: (p: Omit<Produit, "id">) => post<Produit>("/v1/produits", p),

    employes: (tous = false) => get<FicheEmploye[]>(`/v1/employes${tous ? "?tous" : ""}`),
    employe: (id: string) => get<FicheEmploye>(`/v1/employes/${id}`),
    creerEmploye: (e: Employe) => post<FicheEmploye>("/v1/employes", e),
    modifierEmploye: (id: string, e: Employe) => put<FicheEmploye>(`/v1/employes/${id}`, e),
    conges: (id: string, au?: string) => get<SoldeConges>(`/v1/employes/${id}/conges${qs({ au })}`),
    absencesEmploye: (id: string) => get<Absence[]>(`/v1/employes/${id}/absences`),
    demanderAbsence: (id: string, a: { type: TypeAbsence; debut: string; fin: string; motif?: string }) =>
      post<Absence>(`/v1/employes/${id}/absences`, a),
    absences: (statut?: Absence["statut"]) => get<Absence[]>(`/v1/absences${qs({ statut })}`),
    deciderAbsence: (id: string, statut: "validee" | "refusee" | "annulee") =>
      post<Absence>(`/v1/absences/${id}/decision`, { statut }),

    apercuImport: (fichier: string, entete = 0) => post<Apercu>("/v1/imports/apercu", { fichier, entete }),
    importer: (cible: "clients" | "produits", fichier: string, correspondance: Record<string, number>, entete = 0) =>
      post<ResultatImport>(`/v1/imports/${cible}`, { fichier, correspondance, entete }),

    /** URL d'un export comptable (journal des ventes, créances, FEC), téléchargé par le navigateur. */
    urlExport: (e: "ventes.xlsx" | "creances.xlsx" | "fec", p: { du?: string; au?: string } = {}) =>
      `${base}/v1/exports/${e}${qs(e === "creances.xlsx" ? { au: p.au } : p)}`,

    gabarit: () => get<GabaritApi>("/v1/parametres/gabarit"),
    enregistrerGabarit: (g: { couleur?: string | null; piedDePage?: string | null }) =>
      put<null>("/v1/parametres/gabarit", g),
    envoyerLogo: (image: string) => put<{ largeur: number; hauteur: number }>("/v1/parametres/gabarit/logo", { image }),
    supprimerLogo: () => appel<null>("DELETE", "/v1/parametres/gabarit/logo"),
    urlLogo: () => `${base}/v1/parametres/gabarit/logo`,

    plans: () => get<PlanApi[]>("/v1/abonnement/plans"),
    abonnement: () => get<AbonnementApi>("/v1/abonnement"),
    checkout: (plan: "pro" | "business", periodicite: "mensuel" | "annuel" = "mensuel") =>
      post<{ url: string }>("/v1/abonnement/checkout", { plan, periodicite }),
    portail: () => post<{ url: string }>("/v1/abonnement/portail", {}),

    creerJeton: (nom: string, expireEnJours?: number) => post<{ jeton: string }>("/v1/jetons", { nom, expireEnJours }),
    jetons: () => get<CleApi[]>("/v1/jetons"),
    revoquerJeton: (id: string) => del(`/v1/jetons/${id}`),
    ajouterMembre: (email: string, role: Role) => post<null>("/v1/membres", { email, role }),
    membres: () => get<Membre[]>("/v1/membres"),
    retirerMembre: (id: string) => del(`/v1/membres/${id}`),
    invitations: () => get<Invitation[]>("/v1/invitations"),
    inviter: (email: string, role: Role) => post<Invitation>("/v1/invitations", { email, role }),
    revoquerInvitation: (id: string) => del(`/v1/invitations/${id}`),
    accepterInvitation: (c: { id?: string; jeton?: string; motDePasse: string }) =>
      post<{ deuxFacteurs?: boolean }>("/v1/invitations/acceptation", c),
    creerEntreprise: (e: { nom: string; siret: string; adresse: string; franchiseTva?: boolean }) =>
      post<{ id: string }>("/v1/entreprises", e),
    verifierAudit: () => get<{ ok: boolean; entrees: number }>("/v1/audit/verification"),

    recues: (statut?: Recue["statut"]) => get<Recue[]>(`/v1/factures-recues${qs({ statut })}`),
    deciderRecue: (id: string, statut: "validee" | "rejetee", motif?: string) =>
      post<Recue>(`/v1/factures-recues/${id}/decision`, { statut, motif }),
    /** URL du fichier d'origine (PDF, Factur-X ou XML), ouvert dans le navigateur. */
    urlFichierRecu: (id: string) => `${base}/v1/factures-recues/${id}/fichier`,

    automatisations: () => get<ResumeAutomatisation[]>("/v1/automatisations"),
    automatisation: (id: string) => get<Automatisation>(`/v1/automatisations/${id}`),
    creerAutomatisation: (a: { nom: string; description?: string; definition: Definition; actif?: boolean }) =>
      post<Automatisation>("/v1/automatisations", a),
    modifierAutomatisation: (
      id: string,
      a: Partial<{ nom: string; description: string; definition: Definition; actif: boolean }>,
    ) => put<Automatisation>(`/v1/automatisations/${id}`, a),
    supprimerAutomatisation: (id: string) => appel<null>("DELETE", `/v1/automatisations/${id}`),
    /** Exécution synchrone d'un workflow enregistré. */
    executerAutomatisation: (id: string, donnees?: Record<string, unknown>) =>
      post<Execution>(`/v1/automatisations/${id}/executer`, { donnees }),
    /** Essai d'une définition sans l'enregistrer (bouton « Tester » de l'éditeur). */
    essaiAutomatisation: (definition: Definition, donnees?: Record<string, unknown>) =>
      post<Execution>("/v1/automatisations/essai", { definition, donnees }),
    executionsAutomatisation: (id: string) => get<ResumeExecution[]>(`/v1/automatisations/${id}/executions`),
    versionsAutomatisation: (id: string) => get<VersionAutomatisation[]>(`/v1/automatisations/${id}/versions`),
    restaurerVersion: (id: string, numero: number) =>
      post<Automatisation>(`/v1/automatisations/${id}/versions/${numero}/restaurer`, {}),
    execution: (id: string) => get<Execution>(`/v1/executions/${id}`),
    webhookAutomatisation: (id: string) => get<{ url: string }>(`/v1/automatisations/${id}/webhook`),
    catalogueAutomatisations: () => get<TypeNoeudApi[]>("/v1/automatisations/catalogue"),
    modelesAutomatisations: () => get<Modele[]>("/v1/automatisations/modeles"),
    /** Conversion d'un export JSON de n8n en définition auto (rien n'est enregistré). */
    importerN8n: (workflow: unknown) =>
      post<{
        nom: string;
        definition: Definition;
        avertissements: string[];
        /** Un workflow par déclencheur n8n supplémentaire. */
        autres: { nom: string; definition: Definition }[];
      }>("/v1/automatisations/importer-n8n", {
        workflow,
      }),

    secrets: () => get<Secret[]>("/v1/secrets"),
    creerSecret: (nom: string, valeur: string) => post<Secret>("/v1/secrets", { nom, valeur }),
    supprimerSecret: (id: string) => appel<null>("DELETE", `/v1/secrets/${id}`),
  };
}

export type ClientApi = ReturnType<typeof clientApi>;

/** Client du navigateur (même origine). */
export const api = clientApi();

export type { Ligne };

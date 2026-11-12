// Description OpenAPI 3.1 de l'API /v1, servie sur GET /v1/openapi.json et écrite dans docs/openapi.json
// (bun scripts/openapi.ts). Un module de lot documente ses routes par `export const openapi: Chemins`.
// openapi.test.ts échoue si une route de creerApp n'est pas décrite ici.
import { MODULES } from "./app";
import type { Chemins } from "./modules";

import {
  ref,
  liste,
  json,
  str,
  uuid,
  date,
  cents,
  objet,
  enumere,
  tva,
  brut,
  op,
  avecId,
  type Schema,
} from "./openapi-outils";

const SCHEMAS: Record<string, Schema> = {
  Erreur: objet({ erreur: str, details: liste(str) }, ["erreur"]),
  Partie: objet(
    {
      nom: str,
      siret: { type: "string", pattern: "^\\d{14}$" },
      adresse: str,
      adresseLivraison: str,
      tvaIntracom: str,
      email: { type: "string", format: "email" },
    },
    ["nom", "siret", "adresse"],
  ),
  Ligne: objet(
    {
      designation: str,
      quantite: { type: "number" },
      prixUnitaireHtCents: cents,
      remiseBp: { type: "integer", description: "Remise en points de base (1000 = 10 %)" },
      tva,
      unite: str,
    },
    ["designation", "quantite", "prixUnitaireHtCents", "tva"],
  ),
  TypeDocument: enumere("devis", "facture", "acompte", "avoir"),
  Statut: enumere("brouillon", "emis", "envoye", "accepte", "refuse", "depose", "rejete", "paye", "annule"),
  Document: objet(
    {
      type: ref("TypeDocument"),
      date,
      emetteur: ref("Partie"),
      client: ref("Partie"),
      lignes: liste(ref("Ligne")),
      datePrestation: date,
      echeance: date,
      conditionsPaiement: str,
      penalitesRetard: str,
      escompte: str,
      franchiseTva: { type: "boolean" },
      origine: { type: "string", description: "Avoir : numéro de la facture rectifiée" },
      validiteJours: { type: "integer" },
      notes: str,
    },
    ["type", "date", "emetteur", "client", "lignes"],
  ),
  DocumentEntree: {
    description:
      "Émetteur imposé par la fiche entreprise ; `clientId` relit le client enregistré ; `chantierId` affecte le brouillon dans la même transaction, sans figer cette affectation dans son contenu.",
    ...objet(
      {
        type: ref("TypeDocument"),
        date,
        client: ref("Partie"),
        clientId: { type: ["string", "null"], format: "uuid" },
        chantierId: { type: ["string", "null"], format: "uuid" },
        lignes: liste(ref("Ligne")),
        datePrestation: date,
        echeance: date,
        conditionsPaiement: str,
        penalitesRetard: str,
        escompte: str,
        origine: str,
        validiteJours: { type: "integer" },
        notes: str,
      },
      ["type", "lignes"],
    ),
  },
  Totaux: objet(
    {
      htCents: cents,
      tvaParTaux: { type: "object", additionalProperties: cents },
      tvaCents: cents,
      ttcCents: cents,
    },
    ["htCents", "tvaParTaux", "tvaCents", "ttcCents"],
  ),
  DocumentEnregistre: objet(
    {
      id: uuid,
      type: ref("TypeDocument"),
      statut: ref("Statut"),
      numero: { type: ["string", "null"] },
      data: ref("Document"),
      htCents: cents,
      tvaCents: cents,
      ttcCents: cents,
      emisAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      clientId: { type: ["string", "null"], format: "uuid" },
      totaux: ref("Totaux"),
    },
    ["id", "type", "statut", "numero", "data", "htCents", "tvaCents", "ttcCents", "createdAt", "totaux"],
  ),
  Client: { allOf: [ref("Partie"), objet({ id: uuid }, ["id"])] },
  ProduitEntree: objet({ designation: str, prixUnitaireHtCents: cents, tva, unite: str }, [
    "designation",
    "prixUnitaireHtCents",
    "tva",
  ]),
  Produit: { allOf: [ref("ProduitEntree"), objet({ id: uuid }, ["id"])] },
  ModePaiement: enumere("virement", "carte", "cheque", "especes", "prelevement", "autre"),
  PaiementEntree: objet({ date, montantCents: cents, mode: ref("ModePaiement"), reference: str }, [
    "date",
    "montantCents",
    "mode",
  ]),
  Paiement: objet(
    {
      id: uuid,
      documentId: uuid,
      date,
      montantCents: cents,
      mode: ref("ModePaiement"),
      reference: { type: ["string", "null"] },
    },
    ["id", "documentId", "date", "montantCents", "mode", "reference"],
  ),
  ResultatPaiement: objet({ paiement: ref("Paiement"), resteCents: cents }, ["paiement", "resteCents"]),
  Paiements: objet({ ttcCents: cents, resteCents: cents, paiements: liste(ref("Paiement")) }, [
    "ttcCents",
    "resteCents",
    "paiements",
  ]),
  ARelancer: objet(
    {
      documentId: uuid,
      numero: str,
      client: ref("Partie"),
      echeance: date,
      joursRetard: { type: "integer" },
      niveau: { ...enumere(1, 2, 3), description: "Palier atteint : J+7, J+30, J+60 après l'échéance" },
      resteCents: cents,
    },
    ["documentId", "numero", "client", "echeance", "joursRetard", "niveau", "resteCents"],
  ),
  RelanceEntree: objet({ niveau: enumere(1, 2, 3), canal: enumere("mail", "courrier", "telephone") }, ["niveau"]),
  Employe: objet(
    {
      nom: str,
      prenom: str,
      email: { type: "string", format: "email" },
      poste: str,
      contrat: enumere("cdi", "cdd", "apprentissage", "professionnalisation", "stage", "interim"),
      dateEntree: date,
      dateSortie: date,
      tempsTravail: { type: "integer", description: "Pourcentage d'un temps plein" },
      salaireBrutMensuelCents: cents,
    },
    ["nom", "prenom", "poste", "contrat", "dateEntree", "tempsTravail", "salaireBrutMensuelCents"],
  ),
  FicheEmploye: { allOf: [ref("Employe"), objet({ id: uuid }, ["id"])] },
  TypeAbsence: enumere("conges_payes", "rtt", "maladie", "sans_solde", "evenement_familial", "autre"),
  StatutAbsence: enumere("demandee", "validee", "refusee", "annulee"),
  AbsenceEntree: objet({ type: ref("TypeAbsence"), debut: date, fin: date, motif: str }, ["type", "debut", "fin"]),
  Absence: objet(
    {
      id: uuid,
      employeId: uuid,
      type: ref("TypeAbsence"),
      debut: date,
      fin: date,
      joursOuvrables: { type: "number" },
      statut: ref("StatutAbsence"),
      motif: { type: ["string", "null"] },
    },
    ["id", "employeId", "type", "debut", "fin", "joursOuvrables", "statut", "motif"],
  ),
  SoldeConges: objet(
    {
      periode: date,
      acquis: { type: "number" },
      pris: { type: "number" },
      demandes: { type: "number" },
      disponible: { type: "number" },
    },
    ["periode", "acquis", "pris", "demandes", "disponible"],
  ),
  Role: enumere("owner", "admin", "comptable", "lecture", "rh"),
  Inscription: objet(
    {
      email: { type: "string", format: "email" },
      motDePasse: { type: "string", minLength: 12 },
      entreprise: objet({ nom: str, siret: str, adresse: str, franchiseTva: { type: "boolean" } }, [
        "nom",
        "siret",
        "adresse",
      ]),
    },
    ["email", "motDePasse", "entreprise"],
  ),
  Session: objet({ userId: uuid, tenantId: uuid, session: str }, ["userId", "tenantId", "session"]),
  Entreprise: objet(
    {
      id: uuid,
      nom: str,
      siren: str,
      siret: str,
      adresse: str,
      tvaIntracom: { type: ["string", "null"] },
      franchiseTva: { type: "boolean" },
    },
    ["id", "nom", "siren", "siret", "adresse", "tvaIntracom", "franchiseTva"],
  ),
  Moi: objet(
    {
      userId: uuid,
      tenantId: uuid,
      role: ref("Role"),
      email: str,
      nom: str,
      deuxFacteurs: { type: "boolean" },
      entreprise: ref("Entreprise"),
      entreprises: liste(objet({ id: uuid, nom: str, siren: str, role: ref("Role"), suspendue: { type: "boolean" } })),
    },
    ["userId", "tenantId", "role", "entreprise"],
  ),
  Siren: objet({ siren: str, nom: str, siretSiege: str, adresse: str }, ["siren", "nom", "siretSiege", "adresse"]),
  VerificationAudit: objet({ ok: { type: "boolean" }, entrees: { type: "integer" } }, ["ok", "entrees"]),
  Evenement: {
    description:
      "Corps d'un webhook sortant. En-têtes : `x-auto-signature: sha256=<hex>` (HMAC-SHA256 du corps brut) et " +
      "`x-auto-evenement: <id>` (clé d'idempotence, un même événement peut être livré plus d'une fois).",
    ...objet(
      {
        id: { type: "string", format: "uuid", description: "UUID v7" },
        type: str,
        tenantId: uuid,
        date: { type: "string", format: "date-time" },
        data: {},
      },
      ["id", "type", "tenantId", "date", "data"],
    ),
  },
};

const ERREURS: Record<number, string> = {
  400: "JSON invalide",
  401: "Non authentifié",
  403: "Droit insuffisant",
  404: "Introuvable",
  402: "Quota du plan atteint",
  409: "Conflit (état ou unicité)",
  413: "Fichier trop volumineux",
  415: "Content-Type application/json requis (session par cookie)",
  410: "Expiré ou déjà utilisé",
  422: "Règle métier non respectée",
  429: "Trop de tentatives",
  502: "Service tiers indisponible",
  503: "Service non configuré (Stripe, PA)",
};

const D = "Documents";
const doc = ref("DocumentEnregistre");

const CHEMINS: Chemins = {
  "/v1/auth/inscription": {
    post: op({
      resume: "Créer un compte et son entreprise",
      tag: "Comptes",
      corps: ref("Inscription"),
      succes: { 201: ref("Session") },
      erreurs: [409, 422],
    }),
  },
  "/v1/auth/connexion": {
    post: op({
      resume: "Ouvrir une session Better Auth (cookie auto.session_token et jeton Bearer) ou un défi 2FA",
      tag: "Comptes",
      corps: objet({ email: str, motDePasse: str, tenantId: uuid }, ["email", "motDePasse"]),
      succes: { 200: ref("Session") },
      erreurs: [401, 403],
    }),
  },
  "/v1/auth/deconnexion": {
    post: op({ resume: "Fermer la session", tag: "Comptes", succes: { 204: null } }),
  },
  "/v1/siren/{siren}": avecId(
    {
      get: op({
        resume: "Rechercher une entreprise dans l'annuaire",
        tag: "Comptes",
        succes: { 200: ref("Siren") },
        erreurs: [404, 422, 502],
      }),
    },
    "siren",
    { type: "string", pattern: "^\\d{9}$" },
  ),
  "/v1/moi": {
    get: op({ resume: "Appelant et entreprise", tag: "Comptes", droit: "lire", succes: { 200: ref("Moi") } }),
  },
  "/v1/jetons": {
    get: op({
      resume: "Clés d'API de l'entreprise (sans le secret)",
      tag: "Comptes",
      droit: "parametres",
      succes: {
        200: liste(
          objet({ id: uuid, nom: str, debut: str, email: str, creeLe: str, expireLe: str, dernierUsage: str }),
        ),
      },
    }),
    post: op({
      resume: "Créer une clé d'API `auto_…` (renvoyée une seule fois)",
      tag: "Comptes",
      droit: "parametres",
      corps: objet({ nom: str, expireEnJours: { type: "integer", minimum: 1 } }),
      succes: { 201: objet({ jeton: str }, ["jeton"]) },
    }),
  },
  "/v1/membres": {
    get: op({
      resume: "Membres de l'entreprise",
      tag: "Comptes",
      droit: "membres",
      succes: { 200: liste(objet({ id: uuid, userId: uuid, email: str, nom: str, role: ref("Role"), depuis: str })) },
    }),
    post: op({
      resume: "Ajouter un utilisateur existant ou changer son rôle",
      tag: "Comptes",
      droit: "membres",
      corps: objet({ email: str, role: ref("Role") }, ["email", "role"]),
      succes: { 204: null },
      erreurs: [404],
    }),
  },
  "/v1/documents": {
    get: op({
      resume: "Lister les documents",
      tag: D,
      droit: "lire",
      requete: [{ nom: "type", schema: ref("TypeDocument"), description: "Filtre par type" }],
      succes: { 200: liste(doc) },
    }),
    post: op({
      resume: "Créer un brouillon",
      tag: D,
      droit: "ecrire",
      corps: ref("DocumentEntree"),
      succes: { 201: doc },
      erreurs: [404, 422],
    }),
  },
  "/v1/documents/{id}": avecId({
    get: op({ resume: "Lire un document", tag: D, droit: "lire", succes: { 200: doc }, erreurs: [404] }),
    put: op({
      resume: "Modifier un brouillon",
      tag: D,
      droit: "ecrire",
      corps: ref("DocumentEntree"),
      succes: { 200: doc },
      erreurs: [404, 422],
    }),
    delete: op({ resume: "Supprimer un brouillon", tag: D, droit: "ecrire", succes: { 204: null }, erreurs: [404] }),
  }),
  "/v1/documents/{id}/emettre": avecId({
    post: op({
      resume: "Émettre : numéro, exemplaire figé (PDF ou Factur-X), événement document.emis",
      tag: D,
      droit: "ecrire",
      succes: { 200: doc },
      erreurs: [404, 409, 422],
    }),
  }),
  "/v1/documents/{id}/pdf": avecId({
    get: op({
      resume: "PDF (Factur-X PDF/A-3b pour une facture émise) ; ETag = SHA-256",
      tag: D,
      droit: "lire",
      succes: { 200: brut("application/pdf") },
      erreurs: [404],
    }),
  }),
  "/v1/documents/{id}/xml": avecId({
    get: op({
      resume: "XML CII EN 16931 extrait du Factur-X",
      tag: D,
      droit: "lire",
      succes: { 200: brut("application/xml") },
      erreurs: [404],
    }),
  }),
  "/v1/documents/{id}/statut": avecId({
    post: op({
      resume: "Changer le statut d'un document émis (événement document.statut)",
      tag: D,
      droit: "ecrire",
      corps: objet({ statut: ref("Statut") }, ["statut"]),
      succes: { 200: doc },
      erreurs: [404, 409],
    }),
  }),
  "/v1/clients": {
    get: op({
      resume: "Lister ou rechercher les clients",
      tag: "Clients",
      droit: "lire",
      requete: [{ nom: "q", schema: str, description: "Nom (contient) ou début de SIRET" }],
      succes: { 200: liste(ref("Client")) },
    }),
    post: op({
      resume: "Créer un client",
      tag: "Clients",
      droit: "ecrire",
      corps: ref("Partie"),
      succes: { 201: ref("Client") },
      erreurs: [422],
    }),
  },
  "/v1/clients/{id}": avecId({
    get: op({
      resume: "Lire un client",
      tag: "Clients",
      droit: "lire",
      succes: { 200: ref("Client") },
      erreurs: [404],
    }),
    put: op({
      resume: "Modifier un client",
      tag: "Clients",
      droit: "ecrire",
      corps: ref("Partie"),
      succes: { 200: ref("Client") },
      erreurs: [404, 422],
    }),
  }),
  "/v1/produits": {
    get: op({ resume: "Lister les produits", tag: "Produits", droit: "lire", succes: { 200: liste(ref("Produit")) } }),
    post: op({
      resume: "Créer un produit",
      tag: "Produits",
      droit: "ecrire",
      corps: ref("ProduitEntree"),
      succes: { 201: ref("Produit") },
      erreurs: [422],
    }),
  },
  "/v1/documents/{id}/paiements": avecId({
    get: op({
      resume: "Paiements et reste dû",
      tag: "Paiements",
      droit: "lire",
      succes: { 200: ref("Paiements") },
      erreurs: [404],
    }),
    post: op({
      resume: "Enregistrer un paiement (événement paiement.enregistre)",
      tag: "Paiements",
      droit: "ecrire",
      corps: ref("PaiementEntree"),
      succes: { 201: ref("ResultatPaiement") },
      erreurs: [404, 409, 422],
    }),
  }),
  "/v1/relances": {
    get: op({
      resume: "Factures échues à relancer",
      tag: "Paiements",
      droit: "lire",
      requete: [{ nom: "date", schema: date, description: "Jour de référence (défaut : aujourd'hui)" }],
      succes: { 200: liste(ref("ARelancer")) },
    }),
  },
  "/v1/documents/{id}/relances": avecId({
    post: op({
      resume: "Noter une relance envoyée",
      tag: "Paiements",
      droit: "ecrire",
      corps: ref("RelanceEntree"),
      succes: { 204: null },
      erreurs: [404, 409],
    }),
  }),
  "/v1/employes": {
    get: op({
      resume: "Lister les employés",
      tag: "RH",
      droit: "rh",
      requete: [{ nom: "tous", schema: str, description: "Présent : inclure les employés sortis" }],
      succes: { 200: liste(ref("FicheEmploye")) },
    }),
    post: op({
      resume: "Créer un employé",
      tag: "RH",
      droit: "rh",
      corps: ref("Employe"),
      succes: { 201: ref("FicheEmploye") },
      erreurs: [422],
    }),
  },
  "/v1/employes/{id}": avecId({
    get: op({
      resume: "Lire un employé",
      tag: "RH",
      droit: "rh",
      succes: { 200: ref("FicheEmploye") },
      erreurs: [404],
    }),
    put: op({
      resume: "Modifier un employé",
      tag: "RH",
      droit: "rh",
      corps: ref("Employe"),
      succes: { 200: ref("FicheEmploye") },
      erreurs: [404, 422],
    }),
  }),
  "/v1/employes/{id}/conges": avecId({
    get: op({
      resume: "Solde de congés payés",
      tag: "RH",
      droit: "rh",
      requete: [{ nom: "au", schema: date, description: "Jour de référence" }],
      succes: { 200: ref("SoldeConges") },
      erreurs: [404],
    }),
  }),
  "/v1/employes/{id}/absences": avecId({
    get: op({
      resume: "Absences d'un employé",
      tag: "RH",
      droit: "rh",
      succes: { 200: liste(ref("Absence")) },
    }),
    post: op({
      resume: "Demander une absence (événement absence.demandee)",
      tag: "RH",
      droit: "rh",
      corps: ref("AbsenceEntree"),
      succes: { 201: ref("Absence") },
      erreurs: [404, 422],
    }),
  }),
  "/v1/absences": {
    get: op({
      resume: "Lister les absences",
      tag: "RH",
      droit: "rh",
      requete: [{ nom: "statut", schema: ref("StatutAbsence"), description: "Filtre par statut" }],
      succes: { 200: liste(ref("Absence")) },
    }),
  },
  "/v1/absences/{id}/decision": avecId({
    post: op({
      resume: "Valider, refuser ou annuler une absence (événement absence.decidee)",
      tag: "RH",
      droit: "rh",
      corps: objet({ statut: enumere("validee", "refusee", "annulee") }, ["statut"]),
      succes: { 200: ref("Absence") },
      erreurs: [404, 409, 422],
    }),
  }),
  "/v1/audit/verification": {
    get: op({
      resume: "Vérifier la chaîne SHA-256 de la piste d'audit",
      tag: "Audit",
      droit: "lire",
      succes: { 200: ref("VerificationAudit") },
    }),
  },
  "/v1/openapi.json": {
    get: op({ resume: "Cette description OpenAPI 3.1", tag: "Méta", succes: { 200: { type: "object" } } }),
  },
};

const TYPES_EVENEMENTS: [string, string][] = [
  ["document.emis", "Document émis (data : document enregistré avec totaux)"],
  ["document.statut", "Statut d'un document changé (data : document enregistré)"],
  ["paiement.enregistre", "Paiement enregistré (data : documentId, paiement, resteCents)"],
  ["absence.demandee", "Absence demandée (data : absence)"],
  ["absence.decidee", "Absence décidée (data : absence)"],
  ["relance.a_envoyer", "Relance planifiée à envoyer (data : facture à relancer, jour)"],
  ["export.mensuel", "Récapitulatif mensuel des documents émis (data : mois, totaux par type)"],
];

/** Spécification complète : routes du cœur et des modules, schémas, webhooks sortants. */
export function specification() {
  const paths: Chemins = { ...CHEMINS };
  for (const m of MODULES) Object.assign(paths, (m as { openapi?: Chemins }).openapi ?? {});
  return {
    openapi: "3.1.0",
    info: {
      title: "auto",
      version: "1",
      description:
        "API de l'administration d'entreprise auto : facturation Factur-X, clients, paiements, RH. " +
        "Montants entiers en centimes, TVA en dixièmes de pourcent. Chaque route authentifiée exige le droit `x-droit`.",
    },
    servers: [{ url: "/" }],
    security: [{ jeton: [] }, { session: [] }],
    paths,
    webhooks: Object.fromEntries(
      TYPES_EVENEMENTS.map(([type, resume]) => [
        type,
        {
          post: {
            summary: resume,
            requestBody: { required: true, ...json(ref("Evenement")) },
            responses: { 200: { description: "Reçu (tout 2xx) ; sinon nouvel essai exponentiel" } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: {
        jeton: {
          type: "http",
          scheme: "bearer",
          description: "Clé d'API `auto_…`, jeton de session Better Auth ou jeton d'accès OAuth (clients MCP)",
        },
        session: { type: "apiKey", in: "cookie", name: "auto.session_token" },
        oauth: {
          type: "oauth2",
          description:
            "OAuth 2.1 + PKCE (clients MCP) ; métadonnées : /.well-known/oauth-authorization-server/api/auth",
          flows: {
            authorizationCode: {
              authorizationUrl: "/api/auth/oauth2/authorize",
              tokenUrl: "/api/auth/oauth2/token",
              refreshUrl: "/api/auth/oauth2/token",
              scopes: {
                openid: "Identité",
                profile: "Profil",
                email: "Adresse",
                offline_access: "Jeton de rafraîchissement",
              },
            },
          },
        },
      },
      schemas: SCHEMAS,
      responses: Object.fromEntries(
        Object.entries(ERREURS).map(([c, description]) => [`E${c}`, { description, ...json(ref("Erreur")) }]),
      ),
    },
  };
}

interface SpecAuth {
  paths?: Record<string, Record<string, Record<string, unknown>>>;
  components?: { schemas?: Record<string, unknown> };
}

/**
 * Spécification servie : celle de l'API et celle de Better Auth (plugin openAPI), chemins préfixés par
 * /api/auth, étiquette « Authentification », schémas préfixés `Auth` (aucune collision avec ceux d'auto).
 */
export async function specificationComplete(genererAuth: () => Promise<unknown>) {
  const base = specification();
  const texte = JSON.stringify(await genererAuth()).replaceAll('"#/components/schemas/', '"#/components/schemas/Auth');
  const a = JSON.parse(texte) as SpecAuth;
  const paths: Record<string, unknown> = { ...base.paths };
  for (const [chemin, ops] of Object.entries(a.paths ?? {}).sort(([x], [y]) => x.localeCompare(y)))
    paths[`/api/auth${chemin}`] = Object.fromEntries(
      Object.entries(ops).map(([m, o]) => [m, { ...o, tags: ["Authentification"] }]),
    );
  const schemas = Object.fromEntries(Object.entries(a.components?.schemas ?? {}).map(([n, v]) => [`Auth${n}`, v]));
  return { ...base, paths, components: { ...base.components, schemas: { ...base.components.schemas, ...schemas } } };
}

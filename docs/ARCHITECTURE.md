# Architecture

## Couches

| Couche           | Rôle                                                                                                                      | Emplacement                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| API              | `Bun.serve`, routes `/v1`, authentification, transaction par requête                                                      | `apps/api`                                                                                        |
| Worker           | File de jobs Postgres : livraison de l'outbox, tâches `Bun.cron`                                                          | `apps/worker`                                                                                     |
| Règles métier    | Mentions légales, totaux, numérotation, remises, avoirs, RH                                                               | `packages/domain`                                                                                 |
| Comptes          | Better Auth ([AUTH.md](AUTH.md)) : sessions, entreprises, rôles, invitations, 2FA, passkeys, clés d'API, OAuth MCP, SIREN | `packages/tenancy`                                                                                |
| Stockage         | Postgres via `Bun.sql`, migrations, RLS, audit                                                                            | `packages/store`                                                                                  |
| Pont natif       | `bun:ffi` vers `auto-ffi`                                                                                                 | `packages/native`, `crates/auto-ffi`                                                              |
| Conformité       | XML CII EN 16931, PDF/A-3b, rendu PDF                                                                                     | `crates/auto-facturx`, `crates/auto-docs`, `crates/auto-modele`                                   |
| Ingestion, agent | Factures reçues (Factur-X, OCR + LLM), CLI `auto agent` et `auto mcp` ([AGENT.md](AGENT.md))                              | `packages/ingest`, `packages/agent`, `apps/cli`, `apps/plugin`, `packages/services/src/ingest.ts` |
| Automatisation   | n8n : workflows sur événements signés, rappels de l'API par jeton                                                         | `infra/n8n`, `apps/api/src/evenements.ts`                                                         |
| PA               | Contrat `Plateforme`, adaptateurs `mock` et B2Brouter, chiffrement                                                        | `packages/pa`, `apps/api/src/modules/pa.ts`                                                       |
| Suite Aphrody    | pdfcraft (cos, preflight, fonts, model, create)                                                                           | `vendor/suite` (clone partiel)                                                                    |

Le TypeScript porte le SaaS (tenants, droits, état, API). Le Rust porte les formats et la conformité,
sous forme de fonctions pures sans état ni notion de tenant.

## Invariants

- **Isolation des tenants.** Chaque transaction métier passe par `withTenant` : `SET LOCAL ROLE auto_app`
  (rôle soumis à la RLS) et `app.tenant` local à la transaction. RLS forcée sur toutes les tables
  métier ; sans tenant posé, aucune ligne. Les clés étrangères entre tables métier sont composites
  `(tenant_id, id)`, car une clé étrangère ne passe pas par la RLS.
- **Numérotation.** Un brouillon n'a pas de numéro. L'émission prend le compteur `(tenant, série, année)`
  sous verrou dans la transaction : numéros continus, sans trou ni doublon. Séries : `D` devis,
  `F` factures et acomptes, `A` avoirs.
- **Immuabilité.** Un document émis ne change plus que de statut (déclencheur `document_fige`) ;
  les corrections passent par un avoir. `audit`, `fichier`, `paiement` et `relance` sont en ajout seul.
- **Piste d'audit.** Chaque action écrit une entrée chaînée par SHA-256 par tenant (déclencheur
  `audit_chaine`) ; `GET /v1/audit/verification` vérifie la chaîne.
- **Exemplaire figé.** À l'émission, dans la même transaction : rendu PDF (Inter embarquée), Factur-X
  PDF/A-3b, contrôle `pdfcraft-preflight`, puis comparaison du TTC du XML au TTC enregistré. Le moindre
  écart annule l'émission. Le fichier est stocké avec son SHA-256 (ETag de `/pdf`).
- **Montants.** Entiers en centimes ; TVA en dixièmes de pourcent ; remises en points de base. Les
  totaux sont calculés en TS (`@auto/domain`) et en Rust (`auto-modele`) dans le même ordre
  d'opérations, avec l'arrondi de `Math.round`.
- **Avoirs et paiements.** Cumul des avoirs ≤ TTC de la facture ; avoir soldant une facture non payée :
  facture annulée. Reste dû = TTC − avoirs − paiements ; à zéro, la facture passe au statut payé.

## Émission d'une facture

```
POST /v1/documents/:id/emettre
  withTenant
    emettre            verifier() → contrôle avoir → compteur → statut emis
    facturx (ffi)      rendre → convert PDF/A-3b → factur-x.xml /AF Alternative → verify
    contrôle TTC       GrandTotalAmount du XML == ttc_cents
    enregistrerFichier fichier (facturx, sha256) + audit
  COMMIT
```

## Outbox, worker et planification

```
POST /v1/documents/:id/emettre
  withTenant
    emettre … enregistrerFichier
    publier(tx, "document.emis", data)   evenement (corps JSON figé) + job evenement.livrer
  COMMIT                                 l'événement existe si et seulement si l'action est validée
worker (bun run worker)
  prendreJobs                            FOR UPDATE SKIP LOCKED, bail de 60 s, reprise d'un bail expiré
  evenement.livrer                       POST signé → livre | nouvel essai 2 s × 2^(n−1), ≤ 1 h | echec (15 essais)
```

- **Outbox** (table `evenement`, migration 005). Ajout dans la transaction métier par `publier(tx, type, data)`
  (`ajouterEvenement`), sous RLS. Le corps `{ id, type, tenantId, date, data }` est figé à l'insertion : la
  signature est identique d'un essai à l'autre. Statuts `a_livrer`, `livre`, `echec` ; essais et dernière erreur
  conservés. Livraison au moins une fois : le récepteur dédoublonne par `id` (UUID v7, dans le corps signé et
  dans l'en-tête `x-auto-evenement`).
- **Jobs** (table `job`). File Postgres générique : `type`, `payload`, `cle` unique (dédoublonnage), `essais` /
  `max_essais`, `executer_apres`, `bail_jusqua`. Un job dont le worker meurt est repris à l'expiration du bail ;
  un traitement plus long que le bail est abandonné et réessayé. Plusieurs workers se partagent la file.
- **Rôle `auto_worker`.** Le worker lit l'outbox et les jobs de tous les tenants par une politique RLS dédiée
  (`TO auto_worker`) ; la RLS reste forcée et `auto_app` ne voit que son tenant. Les tâches métier du worker
  repassent par `withTenant`.
- **Planification** (`apps/worker/src/planification.ts`, `Bun.cron` en processus, fuseau Europe/Paris). Un
  déclenchement n'ajoute qu'un job système à clé unique (`relances:<jour>`, `export:<mois>`), éclaté en un job
  par tenant (`<clé>:<tenant>`) : plusieurs workers planifiés ne doublent rien, un tenant en erreur est réessayé
  seul.

| Tâche          | Cron (Paris) | Effet                                                                                         |
| -------------- | ------------ | --------------------------------------------------------------------------------------------- |
| relances       | `0 8 * * *`  | par facture de `aRelancer` : `marquerRelance` (mail) et `relance.a_envoyer`, même transaction |
| export-mensuel | `0 6 1 * *`  | récapitulatif par type des documents émis le mois précédent : `export.mensuel`                |

Sans `N8N_WEBHOOK_URL`, le worker ne livre pas : les événements attendent dans l'outbox. `AUTO_PLANIFICATION=0`
désactive les tâches périodiques d'un worker (les autres continuent de consommer la file).

## Décisions

- **Suite Aphrody vendorisée.** Le dépôt amont `bun-distribution` n'existe plus : les crates utilisés
  (pdfcraft, gridcraft, wordcraft, deckcraft, aphrody-rag-core, hayro et lopdf corrigés) et leur fermeture
  `path` sont versionnés dans `vendor/suite`, hors workspace. Un correctif se fait directement là.
- **Rust en conteneur.** `scripts/cargo.sh` compile dans `docker/rust.Dockerfile` (Linux, cible de
  production). La bibliothèque Windows du poste de dev est obtenue par compilation croisée MinGW
  (`bun run build:native`), la chaîne MSVC locale étant incomplète.
- **Formatage.** `cargo fmt` sans `--all` (sinon il reformate les crates de `vendor/`) ;
  `bun fmt` et `bun lint` limités à `apps packages scripts docs`.
- **Automatisation par n8n.** L'API publie `document.emis`, `document.statut`, `paiement.enregistre`,
  `absence.demandee` et `absence.decidee` dans la transaction (outbox), livrés par le worker en webhook
  HMAC-SHA256 (`x-auto-signature`). n8n rappelle l'API avec un jeton stocké chiffré dans ses credentials ; il n'a pas
  accès à la base de l'API (base `n8n` séparée). Image officielle `n8nio/n8n` en compose.
- **Plateforme agréée (L6).** auto est une solution compatible : chaque tenant connecte une PA
  (`PUT /v1/pa`, avec le mandat), choisie parmi `mock` et `b2brouter` (choix et sources : `docs/PA.md`).
  Identifiants chiffrés en AES-256-GCM, clé HKDF-SHA256 de `AUTO_CLE_MAITRE` et du tenant (aussi donnée
  authentifiée). Le dépôt relit l'exemplaire Factur-X figé, sous verrou du document. Les statuts XP Z12-012
  (200 à 214) sont en ajout seul (`pa_statut`, idempotent sur statut et horodatage) et reportés sur le
  document : déposée → `depose`, rejetée → `rejete`, refusée → `refuse`, encaissée → `paye`.
  Le webhook `POST /v1/pa/webhook/:tenant` est public. La signature est vérifiée par l'adaptateur avec le
  secret du tenant, sinon 401. Les factures reçues sont stockées telles quelles (`pa_recue`, ajout seul),
  avec le XML extrait par `extraireXml`. Événements `pa.statut` et `facture.recue`, à ajouter à
  `TypeEvenement` (fichier du lot outbox) lors de la fusion. B2Brouter reste inactif sans `cleApi`,
  `compte` et `secretWebhook`. `AUTO_PA_B2BROUTER_URL` remplace l'URL de l'API (bac à sable, tests).
- **OpenAPI.** `apps/api/src/openapi.ts` décrit chaque route `/v1` (OpenAPI 3.1, webhooks sortants compris),
  servie sur `GET /v1/openapi.json` et écrite dans `docs/openapi.json` par `bun run openapi`. `openapi.test.ts`
  échoue si une route de `creerApp` n'est pas décrite ou si `docs/openapi.json` n'est pas à jour.
- **Validation officielle.** `bun run validate:facturx` passe des échantillons au XSD CII D16B et au
  Schematron EN 16931 (ConnectingEurope 1.3.17).
- **Authentification.** Better Auth 1.7 sur le pool `Bun.SQL` (dialecte Kysely `kysely-bun.ts`), monté sur
  `/api/auth/*` et `/.well-known/*` ; plugins organization (tenant), twoFactor, passkey, apiKey, bearer, admin,
  magicLink, openAPI, jwt, mcp, cimd. `authentifierRequete` résout session, clé d'API ou jeton OAuth en
  `{ userId, tenantId, role }` pour `withTenant`. Détails, flux, MCP distant et migration : [AUTH.md](AUTH.md).
- **Invitations.** Plugin organization : lien `/app/invitation?id=…`, 7 jours, usage unique ; mails par
  `brancherEnvoyeur` (SMTP de l'opérateur au démarrage de l'API, sinon journalisés ; expéditeur
  `AUTO_MAIL_EXPEDITEUR`, défaut contact@aphrody.com) et événement `invitation.creee`.
- **MCP distant.** `POST /mcp` : outils de `packages/agent`, jeton OAuth 2.1 vérifié par `requireMcpAuth`,
  lié à l'entreprise choisie au consentement ; les outils rappellent `/v1` avec ce jeton (mêmes droits et RLS).
- **Chiffrement au repos.** AES-256-GCM, clé HKDF-SHA256 de `AUTO_CLE_MAITRE` avec un `info` par usage
  (`totp:<utilisateur>`, `sauvegarde:<base>`), aussi donnée authentifiée. Sans variable : clé de dev
  `CLE_DEV`, refusée si `NODE_ENV=production`.
- **Conformité.** Export, suppression (délai de grâce 30 jours), conservation 10 ans des pièces
  comptables puis purge : règles dans `packages/store/src/conformite.ts` (`CONSERVATION`) et
  [docs/conformite](conformite/README.md). Un lot dont une table relève d'une conservation légale l'ajoute
  à `CONSERVATION.conserver` ; sinon elle est effacée à la suppression.
- **Archivage objet.** `Bun.s3` vers un S3 à verrou d'objet (MinIO en compose, port 9010, seau
  `auto-archives`, rétention par défaut 11 ans) ; table `archive_objet` en ajout seul.
- **Sauvegardes.** `bun scripts/sauvegarde.ts` (pg_dump dans `AUTO_PG_CONTENEUR`, chiffré, rotation
  `AUTO_SAUVEGARDES_GARDER`) et `bun scripts/restauration.ts` vers une base neuve.
- **Observabilité.** `instrumenter` (`apps/api/src/observabilite.ts`) : un journal JSON par requête
  (route en motif, méthode, statut, durée, tenant), compteurs et histogrammes par route sur `/metrics`.

## API `/v1`

| Route                                                                                                                 | Méthodes                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `/auth/inscription`, `/auth/connexion`, `/auth/deconnexion`, `/entreprises` (façades Better Auth)                     | POST                               |
| `/moi`, `/siren/:siren`, `/auth/methodes`                                                                             | GET                                |
| `/jetons`, `/jetons/:id`, `/membres`, `/membres/:id`                                                                  | GET, POST, DELETE                  |
| `/clients`, `/clients/:id`, `/produits`                                                                               | GET, POST, PUT                     |
| `/documents`, `/documents/:id`                                                                                        | GET, POST, PUT, DELETE (brouillon) |
| `/documents/:id/emettre`, `/documents/:id/statut`                                                                     | POST                               |
| `/documents/:id/pdf`, `/documents/:id/xml`                                                                            | GET                                |
| `/documents/:id/paiements`, `/documents/:id/relances`, `/relances`                                                    | GET, POST                          |
| `/employes`, `/employes/:id`, `/employes/:id/absences`, `/employes/:id/conges`, `/absences`, `/absences/:id/decision` | droit `rh`                         |
| `/audit/verification`, `/openapi.json`                                                                                | GET                                |
| `/pa`                                                                                                                 | GET, PUT, DELETE (`parametres`)    |
| `/pa/depots`, `/pa/depots/:id`, `/pa/depots/:id/statut`, `/pa/synchroniser`                                           | GET, POST                          |
| `/pa/recues`, `/pa/recues/:id`, `/pa/recues/:id/pdf`, `/pa/annuaire/:siren`, `/pa/ereporting`                         | GET, POST                          |
| `/pa/webhook/:tenant`                                                                                                 | POST (public, signé)               |
| `/invitations` (droit `membres`), `/invitations/:id`, `/invitations/acceptation`                                      | GET, POST, DELETE                  |
| `/auth/2fa`, `/2fa/enrolement`, `/2fa/confirmation`, `/2fa/codes-secours`, `/2fa/desactivation`                       | POST                               |
| `/conformite/export`, `/conformite/suppression` (owner), `/conformite/archivage`                                      | GET, POST, DELETE                  |
| `/metrics` (hors `/v1`, Prometheus, jeton `AUTO_METRICS_JETON`)                                                       | GET                                |
| `/api/auth/*`, `/.well-known/*` (hors `/v1`, Better Auth), `/mcp` (hors `/v1`, MCP distant OAuth)                     | GET, POST                          |

## Limites connues

- Les polices Inter sont embarquées complètes (environ 900 Ko par Factur-X) : `pdfcraft-fonts` n'en
  fait pas de sous-ensemble.
- OCR d'image des factures reçues seulement si `aphrody-ocr` ou `tesseract` est installé (voir AGENT.md).
- Connecteur B2Brouter testé sur un serveur simulé seulement : à qualifier en bac à sable (points ouverts
  dans `docs/PA.md`). L'état de la PA `mock` est en mémoire, perdu au redémarrage, et la PA reste
  sélectionnable en production. Le dépôt appelle la PA dans la transaction, sous verrou du document.
  Aucune relève périodique : `POST /v1/pa/synchroniser` reste à brancher sur `Bun.cron` ou n8n.
- Outbox : pas encore de relivraison manuelle d'un événement en échec ni de purge des jobs terminés.
- Un jeton n8n appartient à un tenant : pas encore d'instance n8n multi-tenant ni d'abonnement par tenant.
- Fork n8n : build complet non qualifié sous Windows (addon natif lié à `node.exe`), image Docker du fork
  à construire en CI Linux ; scripts Docker du fork encore sur `pnpm deploy`.

## Lots parallèles

Chaque lot a ses points d'entrée réservés, pour que plusieurs branches avancent sans conflit :

| Lot                                        | Routes API                        | Stockage                       | Migration |
| ------------------------------------------ | --------------------------------- | ------------------------------ | --------- |
| Outbox des événements                      | `apps/api/src/evenements.ts`      | `packages/store/src/outbox.ts` | 005       |
| L1 comptes (invitations, 2FA, Sirene)      | `apps/api/src/modules/comptes.ts` | `comptes.ts`                   | 006       |
| L3 imports, exports, FEC                   | `modules/imports.ts`              | `imports.ts`                   | 007       |
| L6 plateforme agréée                       | `modules/pa.ts`                   | `pa.ts`                        | 008       |
| L7 mail                                    | `modules/mail.ts`                 | `mail.ts`                      | 009       |
| L8 ingestion et agent                      | `modules/ingest.ts`               | `ingest.ts`                    | 010       |
| L10 abonnement                             | `modules/abonnement.ts`           | `abonnement.ts`                | 011       |
| L12 conformité (RGPD, export, suppression) | `modules/conformite.ts`           | `conformite.ts`                | 012       |
| L4 gabarit des documents                   | `modules/gabarit.ts`              | `gabarit.ts`                   | 013       |

Un module exporte `routes: Module` (voir `apps/api/src/modules.ts`) : il reçoit `sql`, `publier`, `pub`
et `auth`, et renvoie des routes au format `Bun.serve`. `publier(tx, type, data)` s'appelle dans la transaction
`withTenant` de l'action. Le module documente ses routes par `export const openapi: Chemins` (fusionné dans
`/v1/openapi.json`) ; un nouveau type de job s'ajoute aux `Traitements` du worker.

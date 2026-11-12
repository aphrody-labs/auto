# auto

Plateforme d'automatisation multi-tenant pour indépendants et TPE : workflows visuels type n8n (déclencheurs sur
événement, cron ou webhook ; HTTP, web, RSS, tableurs, Slack, Discord, Telegram, mail, modèles d'IA, actions sur les
données), avec la gestion de l'entreprise intégrée comme source d'événements : facturation électronique, achats, mail,
employés, documents bureautiques, agents IA. Une seule API `/v1`, plusieurs surfaces : application web, application de bureau,
application mobile, CLI, serveur MCP, plugin Claude Code et extension Chrome.

## Surfaces

Distribution serveur autonome, images Docker et Compose de production : [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).
Production : serveur OVH `vps` (conteneurs Docker derrière Cloudflare Tunnel) et base PostgreSQL **Neon**
(projet `auto`, `aws-eu-central-1`) : [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).

| Surface                | Pour qui, pour quoi                                                         | Dossier                    |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------- |
| Application web (SaaS) | Site public, inscription, application complète sur https://auto.aphrody.com | `apps/web`                 |
| Console opérateur      | Entreprises, suspension, outbox, audit                                      | `apps/admin`               |
| Application de bureau  | Coque native Tauri 2 (Windows, macOS, Linux) sur l'application web          | `apps/desktop`             |
| Application mobile     | APK Android (même coque Tauri) et application web installable (PWA)         | `apps/desktop`, `apps/web` |
| CLI `auto`             | Agent, serveur MCP, workflows en code (`auto flux`, import n8n)             | `apps/cli`                 |
| Plugin Claude Code     | Serveur MCP distant `auto` (OAuth) et compétence d'usage                    | `apps/plugin`              |
| Extension Chrome       | Clic droit sur une facture fournisseur en ligne : envoyée à auto            | `apps/extension`           |
| API et worker          | API HTTP `/v1` documentée en OpenAPI ; file de jobs, relances, relèves      | `apps/api`, `apps/worker`  |

## Périmètre

En ligne : https://auto.aphrody.com (production sur serveur OVH, voir `docs/DEPLOIEMENT.md`). API documentée en OpenAPI
3.1 : `GET /v1/openapi.json` et `docs/openapi.json`.

| Domaine                      | Contenu                                                                                                                                           | Brique                                                       | État                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Automatisations              | Workflows visuels, 27 nœuds, expressions, secrets chiffrés, historique, modèles, import n8n (`docs/AUTOMATISATIONS.md`)                           | `packages/automate`, `/v1/automatisations`                   | en place                                            |
| Facturation                  | Devis, factures, acomptes, avoirs partiels, remises, clients et produits, paiements, relances J+7/J+30, Factur-X EN 16931 figé à l'émission       | `packages/domain`, `crates/auto-facturx`, `crates/auto-docs` | en place                                            |
| Gabarits                     | Couleur d'accent, logo, pied de page par entreprise, PDF/A-3b préservé                                                                            | `/v1/parametres/gabarit`                                     | en place                                            |
| Facturation électronique     | Plateforme agréée : dépôt, statuts du cycle de vie, réception, annuaire, e-reporting ; adaptateurs `mock` et B2Brouter                            | `packages/pa`, `/v1/pa`                                      | en place (à qualifier en bac à sable, `docs/PA.md`) |
| Mail                         | Boîte IMAP/SMTP de l'entreprise (préréglages OVH, Google, Microsoft…), relève classée, envoi des documents, relais transactionnel                 | `packages/mail`, `/v1/mail`                                  | en place                                            |
| Factures fournisseurs        | Factur-X lu directement, sinon OCR + LLM local contraint par schéma, contrôles, file « à vérifier » ; alimentées par l'API, le mail et la PA      | `packages/ingest`, `/v1/factures-recues`                     | en place                                            |
| Excel et comptabilité        | Imports guidés (clients, produits), journal des ventes, créances, FEC                                                                             | `crates/auto-sheets`, `/v1/imports`, `/v1/exports`           | en place                                            |
| Employés                     | Fiches et contrats, absences avec validation, jours fériés, solde de congés payés ; notes de frais et documents RH à venir                        | `rh.ts`, `/v1/employes`, `/v1/absences`                      | en place (partiel)                                  |
| Comptes                      | Better Auth : inscription (Sirene), entreprises, rôles, invitations, 2FA, passkeys, lien magique, clés d'API, OAuth MCP ([AUTH.md](docs/AUTH.md)) | `packages/tenancy`                                           | en place                                            |
| Abonnement                   | Plans Gratuit, Pro (14 € HT), Business (39 € HT), quotas, Stripe, factures d'abonnement en Factur-X                                               | `packages/billing`, `/v1/abonnement`                         | en place (Stripe en mode test)                      |
| Devis et paiement en ligne   | Lien signé : le client accepte ou refuse un devis, télécharge le PDF et paie ses factures par carte sur le compte Stripe de l'entreprise          | `/v1/public`, `apps/web` (`/devis`, `/facture`)              | en place (Stripe en test)                           |
| Agents                       | CLI `auto agent` et serveur MCP `auto mcp` sur l'API, avec les droits de l'utilisateur                                                            | `apps/cli`, `apps/plugin` (`docs/AGENT.md`)                  | en place                                            |
| Extension Chrome             | Clic droit sur une facture PDF ou Factur-X en ligne : envoyée à auto ; compteur des factures à vérifier                                           | `apps/extension` (`CHROMEWEBSTORE.md`)                       | en place (soumission au store à faire)              |
| Automatisation               | Outbox d'événements signés, worker avec nouvel essai, `Bun.cron` ; n8n opérateur et abonnements webhook par entreprise                            | `apps/worker`, `infra/n8n`, `/v1/webhooks`                   | en place                                            |
| Conformité                   | Export et suppression d'un tenant (conservation légale 10 ans), archivage S3 verrouillé, sauvegardes, métriques, documents RGPD                   | `/v1/conformite`, `docs/conformite/`                         | en place (documents à valider par un juriste)       |
| Word, PowerPoint, vidéo, RAG | Documents et présentations générés, vidéos de présentation, recherche sur les données de l'entreprise                                             | wordcraft, deckcraft, `Bun.Video`, `aphrody-rag-core`        | prévu                                               |

Briques de la suite : voir `docs/SUITE.md`. Invariants et décisions techniques : voir `docs/ARCHITECTURE.md`.

Vidéos de présentation depuis les écrans et la base réels : `bun run video:tout`, voir [docs/VIDEO.md](docs/VIDEO.md).

Fournisseurs, chantiers, affectations analytiques, bons de livraison et confirmations de commande :
voir [docs/CHANTIERS.md](docs/CHANTIERS.md).

## Dépôt

Organisation du dépôt : `apps/` ne contient que des points d'entrée minces (une surface ou un service déployé) ;
tout ce qui est partagé vit dans `packages/` (TypeScript) ou `crates/` (Rust). Une app ne dépend jamais d'une
autre app, sauf en dépendance de test (`@auto/api/app` pour monter l'API dans un test de bout en bout).
`apps/standalone` est l’exception de distribution : son lanceur assemble les points d’entrée existants dans un
exécutable avec runtime embarqué, sans réimplémenter leur logique.

| Dossier                                                                               | Contenu                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/domain`                                                                     | Règles métier, totaux, TVA, RH, écritures comptables et FEC                  |
| `packages/store`                                                                      | Postgres (Bun.sql), migrations, RLS, outbox                                  |
| `packages/tenancy`                                                                    | Comptes, rôles, invitations, 2FA, chiffrement des secrets                    |
| `packages/services`                                                                   | Services partagés par l'API et le worker : événements, dépôts, mail, PA      |
| `packages/pa`, `packages/mail`, `packages/ingest`, `packages/billing`                 | Plateforme agréée, protocoles mail, ingestion, abonnement                    |
| `packages/agent`                                                                      | Outils de l'API, boucle d'agent LLM, serveur MCP (CLI et plugin)             |
| `packages/client`                                                                     | Client HTTP typé de l'API et proxy de même origine (web, admin)              |
| `packages/ui`                                                                         | Design system Material 3 : jetons, composants React, formats, styles de base |
| `crates/auto-facturx`, `crates/auto-docs`, `crates/auto-modele`, `crates/auto-sheets` | Factur-X, rendu PDF, modèle partagé, tableurs                                |
| `crates/auto-ffi`, `packages/native`                                                  | Pont bun:ffi vers le Rust                                                    |
| `infra/n8n`, `docker/`                                                                | Workflows n8n, images de production et de compilation                        |
| `docs/`                                                                               | Architecture, déploiement, PA, mail, agent, tarifs, conformité, OpenAPI      |

## Démarrer

```sh
docker compose up -d postgres   # Postgres 18 sur le port 5433
bun install
bun run build:native   # bibliothèque auto-ffi (Docker), requise par l'API
bun run migrate
bun run dev
```

Authentification (Better Auth, rôles, 2FA, clés d'API, MCP distant) : voir `docs/AUTH.md`.

Claude Code sur le serveur MCP distant d'auto (connexion OAuth dans le navigateur, aucun jeton à copier) :

```sh
claude mcp add --transport http auto https://auto.aphrody.com/mcp
```

ou le plugin `apps/plugin`, qui déclare ce serveur et la compétence d'usage.

Automatisation (n8n sur http://localhost:5678) : voir `docs/N8N.md`.

```sh
docker compose up -d --wait n8n
bun run e2e:n8n       # facture émise → n8n → Factur-X archivé
```

## Gates

```sh
bun run gates        # check, lint, fmt, tests (Postgres requis)
bun run gates:rust   # fmt, clippy, tests Rust dans le conteneur Linux
bun run validate:facturx
```

Runtime : [Aphrody](https://aphrody.app) (fork de Bun) pour `bun check`, `bun lint` et `bun fmt` natifs.

## Licence

Apache-2.0 (voir `LICENSE` et `NOTICE`). Paquets npm publiés sous `@aphrody/auto-*`.

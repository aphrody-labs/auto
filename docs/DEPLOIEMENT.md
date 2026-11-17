# Déploiement

## Image

`docker/app.Dockerfile` construit, sur Alpine (`oven/bun`), les images de production selon la cible :

| Cible         | Contenu                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `precompiled` | API et worker : Chromium, OCR, `libauto_ffi.so` musl déjà construite (`native/`)                   |
| `application` | Référence : le natif est compilé dans l'image (étape `natif`, `cargo build --release -p auto-ffi`) |
| `web`         | Front et proxy, sans Chromium, OCR ni natif                                                        |
| `sauvegarde`  | `pg_dump` 18 chiffré par la clé maître (`scripts/sauvegarde.ts`)                                   |

```sh
docker build --target precompiled -t auto-app:<version> .
docker build --target web -t auto-web:<version> .
```

Les images tournent sous l'utilisateur `auto` (uid 10001), le système de fichiers en lecture seule, et exposent
`/health` (API et worker sur `PORT` 3000, web sur 3001). Le worker utilise l'image de l'API :
`docker run … auto-app bun apps/worker/src/index.ts`. `docker/app-maj.Dockerfile` ne reconstruit que les sources
TypeScript sur `auto-app:base` (voie rapide de `scripts/prod.ts`). `docker/llm.Dockerfile` compile llama.cpp sur
Alpine pour le moteur d'extraction.

## Variables

Serveurs de fichiers et extraction des devis : voir [ARRIVAGES.md](ARRIVAGES.md) pour les montages en lecture seule,
`AUTO_DOSSIERS_RACINES` et la configuration OCR/LLM commune à l'API et au worker.

| Variable                                                                             | Rôle                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                       | Postgres de l'application (via pooler en mode transaction si présent) ; migrations appliquées au démarrage  |
| `DATABASE_URL_DIRECT`                                                                | Point d'accès direct (non poolé) pour les migrations et `pg_dump` ; facultatif sans pooler                  |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`  | Stockage objet compatible S3 de l'archivage légal (RustFS, R2…) ; absent : archivage désactivé (503)        |
| `AUTO_CLE_MAITRE`                                                                    | Clé maître (32 octets en base64) : chiffrement des secrets TOTP, PA, mail. Obligatoire en production        |
| `AUTO_URL_APP`                                                                       | URL publique (`https://auto.aphrody.com`) : aussi origine de Better Auth (cookies, OAuth, passkeys)         |
| `BETTER_AUTH_SECRET`, `AUTO_GOOGLE_*`, `AUTO_MICROSOFT_*`, `AUTO_ORIGINES_CONFIANCE` | Authentification, facultatives (voir `AUTH.md`)                                                             |
| `AUTO_EMAIL_OPERATEUR`                                                               | Contact de l'opérateur (`contact@aphrody.com`)                                                              |
| `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`                                              | Livraison des événements par le worker                                                                      |
| `STRIPE_*`, `AUTO_TENANT_OPERATEUR`                                                  | Abonnement (voir `STRIPE.md`)                                                                               |
| `AUTO_SMTP_*`                                                                        | Relais transactionnel (voir `MAIL.md`)                                                                      |
| `AUTO_IA_URL`                                                                        | API compatible OpenAI par défaut des nœuds IA (défaut `http://localhost:11434/v1`)                          |
| `AUTO_HOTES_PERMIS`                                                                  | Hôtes internes joignables par les workflows en production (ex. `ollama`) ; les autres sont refusés          |
| `AUTO_RESEAU_LOCAL`                                                                  | `permis` : tout le réseau local joignable par les workflows (installation à comptes de confiance seulement) |

Auto-hébergement complet (Auto, n8n, Hermes, Obsidian, Ollama et console d'administration) : voir `box/README.md`.

Les secrets ne sont jamais dans le dépôt : fichier d'environnement hors dépôt (`--env-file`), ou gestionnaire
de secrets de l'hébergeur.

## auto.aphrody.com (Cloudflare Tunnel)

Le nom `auto.aphrody.com` (zone `aphrody.com`) est un CNAME proxifié vers le tunnel Cloudflare `auto-usa`, géré à
distance avec la règle `auto.aphrody.com → http://auto-web:3001`. Aucun port entrant n'est ouvert : le connecteur
`cloudflared` ouvre la connexion sortante.

Production (depuis le 2026-11-12, historique de la bascule dans [MIGRATION.md](../MIGRATION.md)) : hôte usa (alias ssh
`prd`), pile entièrement auto-hébergée sur le réseau Docker `auto-prod`, aucun port publié sur l'hôte. Les données
(Postgres, S3, `arrivages/`, `media/`, `distributions/`, `prod.env`, sauvegardes) vivent sous une racine unique de
l'hôte, `RACINE` de `scripts/hote.ts` (`AUTO_RACINE` pour la changer, `AUTO_HOTE` pour l'hôte).

| Conteneur       | Rôle                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `auto-api`      | API `/v1` (migrations appliquées au démarrage)                                        |
| `auto-worker`   | File de jobs, relances, relève PA et mail (un seul worker actif)                      |
| `auto-web`      | Front et proxy `/v1`, `/api/auth`, `/.well-known`, `/mcp` vers `auto-api` (port 3001) |
| `auto-postgres` | Postgres 18, base `auto`, rôles `auto_app` et `auto_worker` (NOLOGIN, NOBYPASSRLS)    |
| `auto-s3`       | Stockage objet S3 RustFS de l'archivage (`S3_ENDPOINT`), seau `auto-archives`         |
| `auto-llm`      | llama.cpp, moteur d'extraction (`AUTO_LLM_URL`)                                       |
| `auto-tunnel`   | Connecteur Cloudflare                                                                 |

Les secrets sont dans `prod.env` à la racine des données de l'hôte (mode restreint, lu par les conteneurs ; jamais
dans le dépôt) : `DATABASE_URL`, `AUTO_CLE_MAITRE` (indispensable pour déchiffrer les sauvegardes), `S3_*`, etc.

Exploitation par `ay ssh` (hôte `AUTO_HOTE`, défaut `prd`) :

```sh
bun run prod etat       # hôte, conteneurs auto-*, sonde publique
bun run prod deployer   # voie rapide (sources TS, image reconstruite sur l'hôte) ou complète si le natif change
```

Le worker n'expose pas de port : il tourne avec `--no-healthcheck` (voir `scripts/prod.ts`). `/health` renvoie
`{ ok, version, commit }` (`AUTO_VERSION`, `AUTO_COMMIT`). Les distributions et la vidéo de lancement se publient par
`scripts/publier-distributions.ts` et `scripts/publier-media.ts` (vérification des empreintes, renommage atomique).

Sauvegardes : `infra/usa/sauvegarde.sh`, installé à la racine des données et lancé chaque nuit à 03:15 UTC par
`auto-sauvegarde.timer` (`infra/usa/auto-sauvegarde.service`) : dump Postgres chiffré en AES-256-GCM par la clé
maître (image `sauvegarde`, `AUTO_PG_LOCAL=1`) et archive du seau S3, 14 de chaque conservées. Restauration :
`bun scripts/restauration.ts <fichier> <base>` avec `AUTO_PG_LOCAL=1`. Bun charge les secrets avec `--env-file`, sans
interpréter `prod.env` comme du shell.

Archivage des exemplaires figés (`/v1/conformite/archivage`) : tout stockage compatible S3 configuré par
`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` et `S3_REGION` (client `Bun.S3Client`,
aucune hypothèse propre à un fournisseur). Seau à verrou d'objet (rétention par défaut GOVERNANCE 11 ans).

Restent à faire :

- Microsoft, Stripe et PA : configuration et qualification restantes (voir `PRODUCTION.md`, `STRIPE.md`, `PA.md`).

Le même `docker/app.Dockerfile` sert au mode auto-hébergé par docker compose (`compose.production.yaml`).

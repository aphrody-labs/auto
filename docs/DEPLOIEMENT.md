# Déploiement

## Image

`docker/app.Dockerfile` construit une image unique pour l'API et le worker :

1. étape `natif` : `cargo build --release -p auto-ffi` (Linux) ;
2. étape finale : Debian trixie, runtime Aphrody tiré de la release GitHub `aphrody-labs/bun` (`BUN_TAG`,
   par défaut `bun-v1.4.5`) et vérifié par `SHA256SUMS.txt`, dépendances de production, `libauto_ffi.so`.

```sh
docker build -f docker/app.Dockerfile -t auto-app .
```

L'image tourne sous l'utilisateur `auto` (uid 10001), écoute sur `PORT` (3000) et expose `/health`.
Le worker utilise la même image : `docker run … auto-app bun apps/worker/src/index.ts`.

Les scripts `https://aphrody.app/install(.sh)` renvoient actuellement une page HTML : l'image télécharge
donc directement l'archive de la release.

## Variables

Serveurs de fichiers et extraction des devis : voir [ARRIVAGES.md](ARRIVAGES.md) pour les montages en lecture seule,
`AUTO_DOSSIERS_RACINES` et la configuration OCR/LLM commune à l'API et au worker.

| Variable                                                                             | Rôle                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                       | Postgres de l'application (Neon : point d'accès poolé `-pooler`) ; migrations appliquées au démarrage       |
| `DATABASE_URL_DIRECT`                                                                | Point d'accès direct (non poolé) pour les migrations et `pg_dump` ; facultatif hors Neon                    |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`  | Stockage objet compatible S3 de l'archivage légal (MinIO, R2…) ; absent : archivage désactivé (503)         |
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

Le nom `auto.aphrody.com` (zone `aphrody.com`) pointe par un CNAME proxifié vers le tunnel Cloudflare
`auto` (`f8ba0d09-4ce8-4a9b-977d-b2e64acd2b2d.cfargotunnel.com`). Le tunnel est géré à distance
(`config_src: cloudflare`) avec la règle `auto.aphrody.com → http://auto-web:3001`. Aucun port entrant
n'est ouvert : le connecteur `cloudflared` ouvre la connexion sortante.

Production (depuis le 2026-10-22) : serveur OVH `vps` (Ubuntu, Docker), joint par le tunnel privé WireGuard
(`ssh vps`). Pile isolée des autres services du serveur : réseau Docker `auto-prod`, aucun port publié sur
l'hôte, le connecteur `cloudflared` est le seul point d'entrée.

Base de données (depuis le 2026-11-03) : **Neon**, projet `auto` (`small-forest-38471112`) de l'organisation
`org-long-shape-78978832`, région `aws-eu-central-1`, Postgres 18, base `auto`, rôle propriétaire `auto`. Branche
de production : `main` (par défaut). L'API et le worker utilisent l'URL poolée (PgBouncer, mode transaction :
`SET LOCAL ROLE auto_app` et `set_config(..., true)` restent dans la transaction) ; les migrations et
`pg_dump` utilisent l'URL directe. Les rôles `auto_app` et `auto_worker` (NOLOGIN, NOBYPASSRLS) sont créés par
les migrations 001 et 005 ; aucune extension ni instruction superutilisateur n'est requise.

| Conteneur      | Rôle                                                                                    |
| -------------- | --------------------------------------------------------------------------------------- |
| `auto-api`     | API `/v1` (migrations appliquées au démarrage)                                          |
| `auto-worker`  | File de jobs, relances, relève PA et mail                                               |
| `auto-web`     | Front et proxy `/v1`, `/api/auth`, `/.well-known`, `/mcp` vers `auto-api` (port 3001)   |
| `auto-tunnel`  | Connecteur Cloudflare, règle `auto.aphrody.com → http://auto-web:3001`                  |
| `auto-minio`   | Stockage objet S3 de l'archivage, réseau `auto-prod` seulement (`S3_ENDPOINT`)          |
| `auto-pg-prod` | Ancienne base Postgres 18, sans écriture depuis le 2026-11-03 : point de retour arrière |

Secrets sur le serveur, dans `~/auto` (mode 700) : `prod.env` (lu par les conteneurs : `DATABASE_URL`,
`DATABASE_URL_DIRECT`, `AUTO_CLE_MAITRE` générée sur place…), `neon.env` (`NEON_API_KEY`, `NEON_ORG_ID`,
`NEON_PROJECT_ID` : lu par la livraison seulement, jamais par les conteneurs), `tunnel.token`. Mêmes URL Neon
dans les secrets GitHub `NEON_DATABASE_URL` et `NEON_DATABASE_URL_DIRECT` (dépôt `aphrody-labs/auto`). Copie de `prod.env` chez l'opérateur, hors du serveur : `~/.auto/prod-vps.env` (la clé
maître est indispensable pour déchiffrer les sauvegardes).

Exploitation par `ay ssh` (hôte `AUTO_HOTE`, défaut `fr1`) :

```sh
bun run prod etat       # hôte, conteneurs auto-*, sonde publique
bun run prod deployer   # voie rapide (sources TS, image reconstruite sur vps) ou complète si le natif change
```

Le worker n'expose pas de port : il tourne avec `--no-healthcheck` (voir `scripts/prod.ts`).

Livraison : `bun run release:vps -- deployer` (`scripts/deployer-vps.ts`) prépare l'image puis lance
`scripts/release-vps.ts` sur le VPS, qui qualifie la livraison sur une branche Neon copie-sur-écriture de la
production (`candidat-<version>`, supprimée ensuite) avant de migrer et de recréer les conteneurs.
`release-vps.ts <version> relancer` recrée les conteneurs de la livraison en place avec le `prod.env` courant
(changement de base, rotation de secrets). `/health` renvoie `{ ok, version, commit }` : `version` est
l'identifiant de livraison, `commit` le commit Git livré (`AUTO_VERSION`, `AUTO_COMMIT`). Outils Neon communs :
`scripts/neon.ts` (projet, branches, URL poolée ou directe ; aucune URL affichée).

Sauvegardes : `~/auto/sauvegarde.sh` (source versionnée : `scripts/vps-sauvegarde.sh`, cron quotidien à 3 h 15) exécute `scripts/sauvegarde.ts` : `pg_dump` de Neon (`DATABASE_URL_DIRECT`) chiffré en
AES-256-GCM dans `~/auto/sauvegardes`, 14 conservées, journal `~/auto/sauvegarde.log`. Restauration vérifiée le
2026-10-24 dans une base jetable (55 tables, puis suppression de la base de recette). Bun charge les secrets
avec `--env-file`, sans interpréter `prod.env` comme du shell.
Copie hors site après chaque sauvegarde : `rsync --delete` vers `offsite:/srv/offsite/vps/auto-sauvegardes/`.
Neon conserve en plus l'historique de la branche (restauration à un instant) ; la branche
`avant-bascule-20261103t223215z` fige la production telle que restaurée lors de la bascule.

Bascule du 2026-11-03 : gel (arrêt de `auto-worker` puis `auto-api`), `pg_dump -Fc` de `auto-pg-prod`,
`pg_restore --no-owner --single-transaction` dans la branche `main` (rôles `auto_app` et `auto_worker` créés
avant), comparaison identique des comptes de lignes de chaque table, de `schema_migration`, des séquences, des
politiques RLS, des droits et des fonctions, puis relance par `release-vps.ts relancer`. Retour arrière :
restaurer `~/auto/prod.env.avant-neon-20261103T223215Z`, puis `release-vps.ts <version> relancer` ;
`auto-pg-prod` n'a pas été modifiée.

Archivage des exemplaires figés (`/v1/conformite/archivage`) : tout stockage compatible S3 configuré par
`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` et `S3_REGION` (client `Bun.S3Client`,
aucune hypothèse propre à MinIO). En production : MinIO `auto-minio` sur le réseau `auto-prod`, seau
`auto-archives` à verrou d'objet (rétention par défaut GOVERNANCE 11 ans), variables `S3_*` dans `~/auto/prod.env`. Recette du 2026-10-22 avec l'image de production (base jetable, seau `auto-recette` à rétention 1 jour) : `POST /v1/conformite/archivage` archive la facture Factur-X émise sous verrou GOVERNANCE, second passage vide.

Restent à faire :

- Microsoft, Stripe et PA : configuration et qualification restantes (voir `PRODUCTION.md`, `STRIPE.md`, `PA.md`).

Le relais Zimbra `auto@aphrody.com` est opérationnel sur le VPS : SMTP TLS, réception IMAP et livraison
Gmail avec SPF/DKIM/DMARC validés. Google est publié en production et testé. L'image auth/mail active et
les moyens de retour arrière sont décrits dans `PRODUCTION.md`.

La préproduction locale (poste de l'opérateur, base de dev `auto-pg` sans `fsync`) est arrêtée ; le même
`docker/app.Dockerfile` sert au mode auto-hébergé par docker compose.

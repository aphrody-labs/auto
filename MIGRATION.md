# Migration de auto : fr1 vers usa

Relevé en lecture seule le 2026-11-12 (`ay ssh exec fr1|usa|fr2`), puis bascule faite le même jour (section 5). Les
valeurs secrètes ne figurent nulle part ici : seulement les noms de variables.

## 5. Bascule réalisée (2026-11-12, 11:25-11:50 UTC)

État : auto tourne sur usa uniquement, entièrement auto-hébergé (plus de Neon, R2 ni tunnel SSH) ; fr1 est désinstallé.

- Données : `pg_dump` final depuis Neon refusé (`exceeded the quota`). Restauration du dump nocturne
  `auto-2026-11-09T03-15-43-749Z.dump.chiffre` : données arrêtées au **2026-11-09 03:15:43 UTC** (dernier job créé
  03:15:00). Rôles `auto_app` et `auto_worker` créés avant `pg_restore` ; ACL par défaut propres à Neon (`cloud_admin`,
  `neon_superuser`) écartées de la liste TOC. 73 tables, 580 Mo.
- Conteneurs usa, réseau `auto-prod` (172.19.0.0/16), aucun port publié, données sous `/srv/auto` :

  | Conteneur       | Image                                       | Taille  | Rôle                                                       |
  | --------------- | ------------------------------------------- | ------- | ---------------------------------------------------------- |
  | `auto-postgres` | `postgres:18-alpine` (18.6)                 | 434 Mo  | base `auto`, `/srv/auto/postgres`                          |
  | `auto-s3`       | `rustfs/rustfs:1.0.5`                       | 486 Mo  | S3 (`auto-archives`), `/srv/auto/s3`                       |
  | `auto-llm`      | `auto-llm:v0.9.0` (`docker/llm.Dockerfile`) | 62 Mo   | llama.cpp v0.9.0, alias `auto-extraction`, 3 CPU, 6 Go     |
  | `auto-api`      | `auto-app:20261112T112714Z-alpine`          | 1,76 Go | API, `/srv/auto/arrivages` en lecture                      |
  | `auto-worker`   | `auto-app:20261112T112714Z-alpine`          | 1,76 Go | worker (seul worker actif)                                 |
  | `auto-web`      | `auto-web:20261112T112714Z-alpine`          | 503 Mo  | front, `/srv/auto/media` et `/srv/auto/distributions`      |
  | `auto-tunnel`   | `cloudflare/cloudflared:latest` (2026.10.6) | 99 Mo   | tunnel `auto-usa` `6df6fb40-...` -> `http://auto-web:3001` |

- Images : `docker/app.Dockerfile` sur `oven/bun:1.4.4-alpine` (Bun.Image, Bun.WebView présents ; Bun.Video absent,
  les nœuds vidéo échouent proprement), Chromium et OCR par `apk`, natif musl de
  `ay build -t linux-musl --release --dylib -- -p auto-ffi` (FFI vérifiée dans le conteneur). Construites sur usa.
- S3 : seul l'archivage probant (`archiverFichiers`) utilise `S3_*` ; `media/` et `distributions/` restent des
  montages en lecture seule (copiés de fr1 par rsync).
- n8n : non déployé. La production n'a pas de `N8N_WEBHOOK_URL` (le worker journalise « livraison désactivée ») ; le
  moteur Rust de workflows n'existe pas encore.
- IA : `AUTO_LLM_URL=http://auto-llm:8080/v1`. Le llama-server de shenron (127.0.0.1:8799) sert un LoRA propre à
  shenron (`shenron-chat-v2`, une seule file) : non réutilisé. `auto-llm` charge une copie du même modèle de base
  Qwen3 4B Q4 (`/srv/auto/llm/model.gguf`), sans LoRA, raisonnement désactivé. Pas d'image llama.cpp officielle
  (Ubuntu) : compilé sur Alpine.
- DNS : CNAME proxifié `auto.aphrody.com` -> `6df6fb40-b493-4888-9add-f3e5b1377a71.cfargotunnel.com` ; ancien tunnel
  `auto` (`f8ba0d09-...`) supprimé. Tunnels de shenron non modifiés.
- Sauvegarde : `infra/usa/sauvegarde.sh` installé en `/srv/auto/sauvegarde.sh`, unité `auto-sauvegarde.timer`
  (03:15 UTC) : image `auto-sauvegarde` (pg_dump 18, `AUTO_PG_LOCAL=1`, chiffré par `AUTO_CLE_MAITRE`) et archive
  `s3-*.tar.zst` du seau, 14 de chaque, dans `/srv/auto/sauvegardes`. Premier passage 11:42 UTC vérifié (déchiffré,
  73 tables). Copie finale conservée : `/srv/auto/sauvegardes/fr1-final/` (dump du 09/11, `prod.env` et `tunnel.env`
  de fr1 chiffrés par la clé maître, info `archive:fr1:<nom>`), plus `/srv/offsite/vps/auto-sauvegardes`.
- Vérifié : `https://auto.aphrody.com/health` (version `20261112T112714Z-alpine`), `/` et `/app` 200,
  `/api/auth/get-session` 200, connexion par mot de passe faux 401 (base lue), jobs `automatisations.planifier`
  traités, extraction JSON par `auto-llm` en 4 s.
- fr1 : conteneurs `auto-*`, images `auto-app:*`, `auto-web:*`, `cloudflare/cloudflared:latest`, réseau `auto-prod`,
  cron `sauvegarde.sh`, `auto-ia-tunnel.service`, `~/apps/auto` et le lien `~/auto` supprimés. L'ancienne pile
  Aphrody (fin de la section 4) n'a pas été touchée.
- Exploitation : `bun run prod etat|deployer` vise `prd` (usa par IP publique ; le maillage 10.200.77.5 ne répondait
  pas depuis le poste ni depuis fr1 pendant la bascule).
- Retour arrière : plus de fr1 ; restaurer depuis `/srv/auto/sauvegardes` avec l'image `auto-sauvegarde`
  (`bun scripts/restauration.ts <fichier> <base>`, `AUTO_PG_LOCAL=1`).

## 0. Bloquants à lever avant la bascule

| Bloquant                       | Constat                                                                                                                                 | Action propriétaire                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Base Neon hors quota           | Requête depuis `auto-api` : `PostgresError: Your account or project has exceeded the quota`. `/health` répond 200 (sans base).          | Relever le quota Neon, ou basculer sur le Postgres local de usa (étape 3, option B).                     |
| Sauvegardes nocturnes en échec | Dernier dump chiffré réussi : `auto-2026-11-09T03-15-43-749Z.dump.chiffre` (275 Mo), copié sur usa `/srv/offsite/vps/auto-sauvegardes`. | Faire un dump frais dès que la base répond ; la clé `AUTO_CLE_MAITRE` est nécessaire pour le déchiffrer. |
| Bun du Dockerfile introuvable  | `docker/app.Dockerfile` télécharge `aphrody-labs/bun` release `bun-v1.4.6` : le dépôt n'a aucune release.                               | Publier la release du fork (glibc et musl) ou fixer une autre source de Bun 1.4.6+.                      |
| Moteur IA hors service         | `AUTO_LLM_URL` vise `172.26.0.1:18799`, tunnel SSH `auto-ia-tunnel.service` vers `dbfr:8799`, unité `inactive`.                         | Décider du moteur IA cible sur usa (même machine que `dbfr` ?).                                          |
| Stockage S3 inexistant         | `S3_ENDPOINT` vise `auto-minio`, conteneur absent ; `~/auto/minio.env` reste.                                                           | Choisir R2 (bucket dédié) ou supprimer les variables `S3_*` si les médias restent sur disque.            |

## 1. Ce qui tourne sur fr1 aujourd'hui

Hôte `fr1` (`ssh vps`, ubuntu), répertoire `/home/ubuntu/auto` (aussi `~/apps/auto`), 4,0 Go, pas un dépôt git.
Conteneurs lancés par `docker run` (`scripts/prod.ts`, `scripts/release-vps.ts`), sans compose.

| Conteneur     | Image                                | Taille  | Commande                       | Réseau      | Montages                                                                                        | Santé                       |
| ------------- | ------------------------------------ | ------- | ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| `auto-api`    | `auto-app:20261105T134013Z-88f036fd` | 1,94 Go | `bun apps/api/src/index.ts`    | `auto-prod` | `~/auto/arrivages` -> `/mnt/arrivages` (8 Ko)                                                   | `/health` sur 3000          |
| `auto-worker` | `auto-app:20261105T134013Z-88f036fd` | 1,94 Go | `bun apps/worker/src/index.ts` | `auto-prod` | `~/auto/arrivages` -> `/mnt/arrivages`                                                          | aucune (`--no-healthcheck`) |
| `auto-web`    | `auto-web:20261105T134013Z-88f036fd` | 754 Mo  | `bun apps/web/src/index.ts`    | `auto-prod` | `~/auto/media` -> `/mnt/media` (65 Mo), `~/auto/distributions` -> `/mnt/distributions` (533 Mo) | `/health` sur 3001          |
| `auto-tunnel` | `cloudflare/cloudflared:latest`      | 99 Mo   | `tunnel --no-autoupdate run`   | `auto-prod` | aucun                                                                                           | -                           |

Tous en `restart=unless-stopped`, utilisateur `10001:10001` (cloudflared : `65532`), aucun port publié. Réseau
`auto-prod` : `172.26.0.0/16`, passerelle `172.26.0.1`. Aucun volume Docker nommé. Version en ligne :
`~/auto/current-release.json` -> `20261105T134013Z-88f036fd`, commit source `95d163aa` (dépôt
`aphrody-labs/auto`, supprimé depuis).

Tunnel Cloudflare : `f8ba0d09-4ce8-4a9b-977d-b2e64acd2b2d`, géré à distance (jeton `TUNNEL_TOKEN` dans
`~/auto/tunnel.env` et `~/auto/tunnel.token`). Entrées : `auto.aphrody.com` -> `http://auto-web:3001`, reste ->
`http_status:404`. Le DNS `auto.aphrody.com` est proxifié par Cloudflare (CNAME du tunnel).

Base de données : Neon, projet `NEON_PROJECT_ID` (endpoint `ep-plain-hall-b9lk3cjs`, `eu-central-1`), via le
pooler (`DATABASE_URL`) et en direct (`DATABASE_URL_DIRECT`). Taille non mesurable : quota dépassé (section 0).
Base n8n : aucune en production (n8n n'est que dans `compose.yaml` de développement).

Fichiers d'environnement (valeurs non lues) :

- `prod.env` (chargé par les trois conteneurs applicatifs) : `DATABASE_URL`, `DATABASE_URL_DIRECT`,
  `AUTO_CLE_MAITRE`, `AUTO_URL_APP`, `AUTO_API_URL`, `AUTO_EMAIL_OPERATEUR`, `NODE_ENV`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `AUTO_GOOGLE_CLIENT_ID`,
  `AUTO_GOOGLE_CLIENT_SECRET`, `AUTO_MICROSOFT_CLIENT_ID`, `AUTO_MICROSOFT_CLIENT_SECRET`,
  `AUTO_MICROSOFT_TENANT_ID`, `AUTO_SMTP_HOTE`, `AUTO_SMTP_PORT`, `AUTO_SMTP_SECURITE`, `AUTO_SMTP_UTILISATEUR`,
  `AUTO_SMTP_MOT_DE_PASSE`, `AUTO_SMTP_EXPEDITEUR`, `AUTO_MAIL_EXPEDITEUR`, `AUTO_IMAP_HOTE`,
  `AUTO_MAIL_FOURNISSEUR`, `AUTO_RESEND_CLE_API`, `AUTO_RESEND_EXPEDITEUR`, `AUTO_RESEND_REPONDRE_A`,
  `AUTO_COURRIER_PROPRIETAIRE`, `AUTO_SUPER_ADMIN_EMAILS`, `AUTO_CONNEXION_APPAREIL`, `AUTO_ADMIN_IP_SOURCE`,
  `AUTO_ADMIN_IPS`, `AUTO_LLM_URL`, `AUTO_LLM_MODEL`, `AUTO_LLM_TIMEOUT_MS`, `AUTO_DOSSIERS_PARENT`,
  `AUTO_MEDIA_DIR`, `AUTO_DISTRIBUTIONS_DIR`, `AUTO_VERSION`, `AUTO_COMMIT`, `AUTO_CHROME_ARGS`, `PORT`.
  SMTP et IMAP : OVH mail.
- `tunnel.env` : `TUNNEL_TOKEN`. `neon.env` : `NEON_API_KEY`, `NEON_ORG_ID`, `NEON_PROJECT_ID`.
  `pg.env` : `POSTGRES_PASSWORD`. `minio.env` : `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`.
- 12 copies `prod.env.avant-*` / `prod.env.before-*` et `pg.env.avant-*` : historiques, à ne pas recopier.

Tâches : cron utilisateur `15 3 * * * ~/auto/sauvegarde.sh` (pg_dump chiffré dans `~/auto/sauvegardes`, 14
gardés, 1,6 Go, puis `rsync` vers `offsite` = usa `10.200.77.5:/srv/offsite/vps/auto-sauvegardes`). Unité
systemd `auto-ia-tunnel.service` (inactive). Livraisons : `~/auto/releases` (19 versions, 1,6 Go).

usa et fr2 : aucun conteneur, unité ni répertoire auto (seules les sauvegardes copiées sur usa).

## 2. Image cible (politique conteneurs : Alpine)

1. Bibliothèque native, depuis le poste :
   `ay build -t linux-musl --release --dylib -- -p auto-ffi`
   -> `target/x86_64-unknown-linux-musl/release/libauto_ffi.so` (ELF x86-64 dynamique musl, 36 Mo).
   `--dylib` est obligatoire : sans lui la cible musl abandonne le type `cdylib` (voir `AY_FIELD_TEST.md`).
2. `docker/app.Dockerfile` à réécrire sur `alpine:3.23` : Bun musl (`bun-linux-x64-musl`, fork 1.4.6+), paquets
   `chromium`, `font-dejavu`, `poppler-utils`, `tesseract-ocr`, `tesseract-ocr-data-fra`, `ca-certificates` ;
   utilisateur `10001` ; étage `web` sans Chromium ni OCR ; étage `precompiled` qui copie le `.so` musl dans
   `dist/native/linux-x64/`. Plus d'étage Rust dans l'image (le natif vient de l'étape 1). `hadolint` avant envoi.
3. Construire sur usa (`docker build --target precompiled` et `--target web`), étiquettes `auto-app:<version>` et
   `auto-web:<version>`, versions identiques à `current-release.json`.

## 3. Bascule vers usa

Prérequis : section 0 levée, image de l'étape 2 construite sur usa.

1. Préparer `/srv/auto` sur usa (root:10001, 0750) : `prod.env` recopié depuis fr1 par
   `ay ssh cp` (jamais affiché), `AUTO_LLM_URL` et `S3_*` corrigés ; `media/` et `distributions/` copiés par
   `rsync -a` (600 Mo) ; `arrivages/` créé (2770, groupe 1000).
2. Réseau `docker network create auto-prod` sur usa.
3. Base :
   - option A (Neon conservé) : rien à copier, les deux hôtes partagent la base ;
   - option B (Postgres local, `postgres:18-alpine`, volume `auto-pg`) : figer les écritures sur fr1
     (`docker stop auto-worker auto-api`), dump final par `DATABASE_URL_DIRECT`, restauration sur usa,
     `bun run migrate`, puis `DATABASE_URL` et `DATABASE_URL_DIRECT` pointés sur `auto-pg`.
4. Démarrer sur usa `auto-api` puis `auto-web` (mêmes options que `scripts/prod.ts`), vérifier les deux `/health`
   depuis le réseau `auto-prod`.
5. Démarrer `auto-tunnel` sur usa avec le même `TUNNEL_TOKEN` : Cloudflare répartit alors entre les connecteurs
   de fr1 et de usa ; vérifier `https://auto.aphrody.com/health` (champ `version`) et une connexion réelle.
6. Arrêter sur fr1 `auto-tunnel`, `auto-worker`, `auto-web`, `auto-api` (dans cet ordre), puis démarrer
   `auto-worker` sur usa : un seul worker à la fois, sinon les tâches planifiées partent en double.
7. DNS : rien à changer tant que le tunnel est réutilisé. Pour suivre la décision « tout le DNS vers usa » :
   enregistrement proxifié `auto.aphrody.com` -> `72.60.186.43`, Caddy sur usa vers `auto-web:3001`, puis
   suppression de l'entrée du tunnel dans Cloudflare.
8. Sauvegarde : installer `sauvegarde.sh` et le cron sur usa (destination locale `/srv/auto/sauvegardes`, copie
   hors site vers fr1 `/srv/build` ou R2) ; retirer le cron de fr1.
9. `AUTO_HOTE=usa` pour `bun run prod etat|deployer` ; mettre à jour `docs/INFRA_MATRIX.md` (service auto sur usa).

Retour arrière (tant que fr1 n'est pas désinstallé) : arrêter `auto-worker` puis `auto-tunnel` sur usa, relancer
sur fr1 `auto-api`, `auto-web`, `auto-worker`, `auto-tunnel` (images et `prod.env` intacts). Avec l'option B,
restaurer d'abord sur Neon le dump pris sur usa si des écritures y ont eu lieu.

## 4. À désinstaller sur fr1 après validation

Auto :

- conteneurs `auto-api`, `auto-worker`, `auto-web`, `auto-tunnel` ; images `auto-app:*`, `auto-web:*`,
  `cloudflare/cloudflared:latest` ; réseau `auto-prod` ;
- cron `sauvegarde.sh` ; `/etc/systemd/system/auto-ia-tunnel.service` ;
- `/home/ubuntu/auto` en entier (4,0 Go : `releases/`, `sauvegardes/`, `src/` copie partielle du 23 octobre,
  `outils/`, `*-patch/`, `activation-arrivages-*`, `arrivages-code.tgz`, `neon-migration/`, `recette/`,
  `credentials/`, tous les `*.env` et leurs copies) après archivage chiffré de `prod.env` hors serveur.

Ancienne pile Aphrody (relevé du jour, à confirmer service par service) :

- nginx `/etc/nginx/conf.d/` : `aphrody.conf` (aphrody.com, aphrody.app, api.aphrody.com ; amonts 3000, 3010,
  8788-8797, 8810, 29030 : aucun n'écoute, seul 3100 répond), `cdn.aphrody.com.conf`, `creator.aphrody.com.conf`,
  `downloads.aphrody.com.conf`, `fleet-api.conf`, `sites-enabled/omar.aphrody.com` ; les vhosts rosegriffon
  (`rosegriffon.fr`, `achillea`, `azalee`, `rg-core`, `rpbey.fr`) relèvent de rosegriffon, pas de cette liste ;
- unités utilisateur : `bunos-auto-*` (coordinator, deliver, guard, health, status, nightly, deps-*, en échec),
  `bunos-native-publish`, `bunos-sync`, `bun-os-*`, `aphrody-gpu-depot`, `aphrody-vnc`, `commons-relay`,
  `yolo-worker`, `yolo-lightpanda`, `yolo-git-sync`, `yolo-cluster.target`, `vps-health`, `sync-checkouts` ;
  unité système `rg-cdn-sync` (rosegriffon, à arbitrer) ;
- conteneurs du projet compose `nie-sre-service` (`nie-bridge-service`, `nie-lua-pipeline`, `nie-cfg-pipeline`) ;
- répertoires `~/apps/` : `aphrody`, `api-releases`, `bunos-status`, `bun-video`, `cdn`, `chat`, `control`,
  `craft-web`, `creator`, `downloads`, `komodo`, `nie`, `redis`, `remote-desktop`, `store`, `webos`,
  `compose.yaml` et `compose.yaml.bunos-auto-backup` (`rg` = rosegriffon, à garder jusqu'à sa propre bascule).

Les rôles de build de fr1 (Chromium, AOSP, noyau, `/opt/*` sysroots et SDK, `/srv/build`) restent en place.

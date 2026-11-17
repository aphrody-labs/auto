# Migration de auto : fr1 vers usa (réalisée)

Relevé du 2026-11-12 (`ay ssh exec fr1|usa|fr2`) : bascule faite le même jour. Les valeurs secrètes ne figurent nulle part ici : seulement les noms de variables. Le plan préalable (bloquants, inventaire de fr1, étapes, désinstallation) est exécuté et a été retiré.

## Bascule réalisée (2026-11-12, 11:25-11:50 UTC)

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
  Aphrody n'a pas été touchée.
- Exploitation : `bun run prod etat|deployer` vise `prd` (usa par IP publique ; le maillage 10.200.77.5 ne répondait
  pas depuis le poste ni depuis fr1 pendant la bascule).
- Retour arrière : plus de fr1 ; restaurer depuis `/srv/auto/sauvegardes` avec l'image `auto-sauvegarde`
  (`bun scripts/restauration.ts <fichier> <base>`, `AUTO_PG_LOCAL=1`).

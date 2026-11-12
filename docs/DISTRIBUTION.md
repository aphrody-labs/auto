# Distribution et déploiement Auto

## Conteneurs

Le fichier `compose.yaml` reste réservé au développement : ses identifiants et ses réglages PostgreSQL sans fsync ne conviennent pas à la production.

Pour une installation de production, copier `.env.production.example` vers `.env.production`, remplacer les secrets et renseigner l’URL publique. Les dépendances Rust sont vendorisées dans `vendor/suite` ; lancer :

```sh
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

L’API applique les migrations avant d’être saine ; le worker et le front attendent cette sonde. PostgreSQL conserve sa durabilité et son volume ; aucun port de base ni d’API n’est publié. Le front écoute par défaut uniquement sur `127.0.0.1:3001`, derrière votre proxy HTTPS. Les conteneurs applicatifs tournent sans root, sans capacités, avec racine en lecture seule et espaces temporaires bornés. Le worker dispose de 60 secondes pour terminer ses tâches lors de l’arrêt.

`docker/app.Dockerfile` propose une cible `web` sans Chromium, OCR ni FFI ; la cible finale conserve ces fonctions pour l’API et le worker. Les versions d’images sont surchargeables par `AUTO_IMAGE`, `AUTO_WEB_IMAGE` et `AUTO_POSTGRES_IMAGE` (une référence avec digest est acceptée). Les services mail, S3, IA et n8n sont externes et se configurent dans `.env.production` selon les besoins. Le front ne reçoit pas ce fichier de secrets.

Les fichiers `.env`, données locales, clés privées, caches et artefacts ne sont pas transmis au contexte Docker. Les documents persistants ne doivent jamais vivre dans les systèmes de fichiers temporaires des conteneurs. Sauvegarder PostgreSQL et le stockage documentaire avant une mise à niveau ; un retour à l’ancienne image ne restaure pas un schéma déjà migré.

## Paquet autonome

```sh
bun run build:native
bun run build:standalone windows-x64
bun run build:standalone linux-x64
```

Ajouter `--zip` produit aussi une archive complète et son empreinte SHA-256. Pour Linux, l’archive tar.gz publiée par la CI préserve les permissions d’exécution.

Construire sur le système cible avec le runtime qualifié : le script refuse la compilation croisée et une révision dont la notice n’est pas présente dans `licenses/bun`. Le paquet produit dans `dist/standalone/<cible>` contient le runtime Bun dans `auto` ou `auto.exe`, la bibliothèque FFI, les migrations et `SHA256SUMS.json`. Il inclut aussi `LISEZ-MOI.txt`, `LICENSE`, `NOTICE`, `BUN-LICENSE.md` et `RUNTIME.json` avec la révision exacte et son lien source. Distribuer le dossier complet. Aucune installation de Bun ni de dépendances JavaScript n’est nécessaire sur la machine d’exécution.

La révision d’empaquetage `r1` conserve Auto 0.2.0 et utilise des noms d’archives distincts pour préserver l’immutabilité des téléchargements. Windows embarque Aphrody Bun `169d8c5ea17b2b55a0582c475adc7123118b9623`. Linux utilise l’artefact brut `bun-linux-x64` de la préversion publique `main-runtime-633fd8a28f47`, révision `633fd8a28f47e8d29910fb0b0c3560df425bf611`, SHA-256 `c30e815700450abd93aa31ca92fcf756d719157dfae94af21a361db5eabd1ba7`. Ce choix est qualifié pour Auto ; il ne désigne pas une release stable générale de Bun. Le VPN et les autres plugins natifs optionnels ne font pas partie de ces archives serveur.

```sh
auto --help
auto migrate
auto api
auto worker
auto web
auto mcp
auto agent "résume les factures en retard"
```

Les commandes utilisent les mêmes variables que les serveurs sources (`DATABASE_URL`, `AUTO_CLE_MAITRE`, `AUTO_URL_APP`, `AUTO_API_URL`, `PORT`). Les migrations, images publiques et la FFI sont retrouvées à côté de l’exécutable, indépendamment du dossier courant ; `AUTO_MIGRATIONS_DIR`, `AUTO_PUBLIC_DIR` et `AUTO_FFI_LIB` permettent une installation personnalisée. Les commandes `agent`, `mcp`, `outils` et `flux` délèguent à la CLI existante ; elles utilisent `AUTO_TOKEN` et les paramètres LLM habituels. PostgreSQL, les outils OCR/PDF et Chromium restent des dépendances externes pour les fonctions qui les utilisent. Ce paquet est distinct de la coque native Tauri.

Vérification du paquet sur une base jetable :

```sh
AUTO_STANDALONE=dist/standalone/linux-x64/auto bun test scripts/standalone.test.ts
```

## Interfaces

La même interface responsive est servie dans le navigateur, la PWA et la coque Tauri desktop/mobile. Le menu mobile gère Échap, le focus clavier, l’inertie du contenu et le changement de largeur. Les zones sûres et la saisie sur iOS sont prises en compte. Le parcours de régression est `bun test apps/web/e2e/navigation.test.ts` ; il exige Chrome et PostgreSQL.

## Contrôles du monorepo

`bun run build:all` construit les bibliothèques natives Linux/Windows, le paquet autonome de l’hôte, les coques desktop Linux/Windows et l’extension Chrome. Les scripts Rust et desktop utilisent Bun et Docker directement, y compris sous PowerShell ; les anciens fichiers `.sh` ne sont que des relais. La publication mobile signée et les services externes se qualifient séparément.

`bun check` couvre `apps`, `packages` et `scripts`. `bun run gates` exécute build natif, types, lint, format et tests ; `bun run gates:rust` exécute format Rust, Clippy et tests avec le verrou Cargo. Les tests d’intégration disposent de 30 secondes par défaut et de pools bornés sur des bases jetables. La CI construit et vérifie aussi le paquet autonome Linux, puis le conserve comme artefact.

Pour vérifier l’image web construite : `AUTO_CONTAINER_IMAGE=auto-web:production bun test scripts/container.test.ts`. Ce test lance un conteneur temporaire sans root, capacités ni écriture sur la racine et vérifie HTML, proxy de santé et absence des outils OCR/navigateur. Sous PowerShell, définir les variables avec `$env:AUTO_CONTAINER_IMAGE = 'auto-web:production'` avant la commande.

Ajouter `AUTO_APP_IMAGE=auto-app:production` active également un déploiement Compose jetable complet : les tests vérifient l’API, le worker sans redémarrage, le front et `fsync=on`, puis suppriment uniquement le projet et le volume créés pour ce test.

## Livraison du VPS

`bun run release:vps preparer` crée un contexte immuable sans secrets, vérifie les empreintes des trois distributions Craft et de la FFI, puis construit sur le VPS les images application et web. `--base=<livraison>` réutilise les ressources natives et Craft dont les empreintes correspondent, sans transférer une image complète. `valider` qualifie les migrations sur une copie temporaire de la base ; `deployer` sauvegarde la production chiffrée avec copie hors site, qualifie cette copie puis bascule API, worker et web. Les images précédentes restent disponibles. Une restauration de données reste une opération explicite.

Le VPS utilise ses fichiers protégés `~/auto/prod.env` et `~/auto/pg.env`. Les volumes Arrivages, le groupe du worker et la configuration IA sont conservés. Les contrôles de recette native utilisent une base et un réseau distincts (`scripts/release-recette-vps.ts`), sans worker d’envoi.

## Import par lots

Dans **Fichiers et dossiers**, sélectionner plusieurs fichiers, un dossier ou déposer une arborescence. La file conserve les chemins relatifs, affiche la progression et les erreurs par fichier, et permet pause/reprise et nouvel essai des erreurs temporaires. Elle accepte jusqu’à 5 000 fichiers et 1 Go par sélection, 20 Mo par fichier. Les contenus partent progressivement, avec deux transferts simultanés pour l’indexation et un seul pour une extraction de devis ou facture. Garder la page ouverte ; après rechargement, une nouvelle sélection du dossier reconnaît les fichiers déjà reçus par SHA et chemin.

Les dossiers distants SMB/NFS/UNC restent des sources montées et autorisées par l’opérateur. Leur scan borné conserve un curseur en base (migration `027_imports_massifs.sql`) pour poursuivre les répertoires suivants. Le bouton **Continuer la synchronisation** reprend ce parcours, également après rechargement. La recherche sur tous les espaces autorisés et la pagination de 100 fichiers évitent la limite d’affichage historique des 500 derniers.

L’API `POST /v1/imports-fichiers` reçoit un fichier multipart, son chemin relatif, son espace et le traitement `index`, `devis` ou `facture`. Les sessions cookie exigent l’origine exacte du front et `x-auto-import: 1`. Les requêtes Bearer authentifiées peuvent omettre Origin. Aucune URL distante arbitraire n’est téléchargée. Les originaux sont conservés ; les extractions passent par les files de vérification existantes.

## APK Android de contrôle

Après initialisation du projet Android Tauri, définir `ANDROID_HOME`, `NDK_HOME` et `JAVA_HOME`, puis lancer `bun run build:android`. Le script produit `dist/mobile/android/auto-debug.apk` et son SHA-256. Il utilise le SDK/NDK installés et le toolchain Rust GNU sur Windows. `AUTO_INSTANCE_URL` choisit l’instance au moment de la compilation ; l’absence de cette variable cible la production. Cet APK de contrôle ne constitue pas une publication signée dans un magasin.

La qualification native du 25 octobre 2026 a vérifié sur un émulateur Android isolé : ouverture du navigateur système, approbation indépendante du code, session HttpOnly dans la WebView, API privée accessible, absence de jeton URL/storage et absence de débordement. Une capture de l’écran Android confirme Word Craft WASM rendu en WebGL, interaction tactile et clavier Android. Les coques Linux/Windows se compilent et leurs trois tests Rust passent. Le lancement Windows est vérifié par capture native et arbre d’accessibilité ; la connexion et le tableau de bord dans l’application installée ont ensuite été confirmés par le propriétaire.

## Téléchargements publics et mises à jour

La page publique est `https://auto.aphrody.com/telechargements`. Elle présente uniquement les fichiers du catalogue publié : installateur Windows NSIS, APK Android ARM64 et serveurs autonomes Windows/Linux. Les applications se connectent à l’instance ; les paquets serveur nécessitent PostgreSQL et la configuration décrite ci-dessus. Le navigateur et la PWA restent disponibles sur les autres plateformes.

| Route du front                            | Contrat                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/distributions`                  | Catalogue `schema: 1`, version stable, date ISO, notes et fichiers avec plateforme, architecture, type, taille et SHA-256. Les installateurs de mise à jour portent aussi leur signature. |
| `GET/HEAD /downloads/:fichier`            | Fichier explicitement publié dans le catalogue ; 404 pour tout autre nom. Empreinte en ETag, taille exacte, téléchargement et reprise par plage HTTP.                                     |
| `GET /api/updates/:target/:arch/:version` | Protocole Tauri : nouvelle version, date, notes, URL HTTPS canonique et signature. Réponse 204 si aucune mise à jour compatible plus récente ; 400 pour une version mal formée.           |
| `GET/HEAD /media/lancement-btp.mp4`       | Film qualifié, lecture par plages 206 et recherche dans la vidéo. Une absence retourne 404 sans mise en cache.                                                                            |

Les versions stables utilisent trois nombres (`0.2.0`). Le service refuse les régressions. Les noms de fichiers sont immuables et limités aux entrées validées du manifeste. Les requêtes HEAD, ETag/If-Range, plages simples, suffixes et plages insatisfaisables 416 sont prises en charge sans charger les binaires complets en mémoire.

Le conteneur web monte `~/auto/distributions` et `~/auto/media` en lecture seule. `scripts/publier-distributions.ts <dossier>` vérifie chaque taille et empreinte, transfère dans un répertoire de préparation, refuse le remplacement d’un fichier publié par des octets différents, puis publie le manifeste atomiquement. La dernière livraison locale doit déjà être validée et disponible sur le VPS. Les clés privées restent sur la machine de signature.

### Windows

```sh
bun scripts/build-desktop.ts --output=dist/desktop-release
bun scripts/bundle-windows.ts dist/desktop-release/windows-x64
bun scripts/qualifier-updater.ts 0.1.0
```

L’empaquetage utilise le CLI Tauri 2.12.4 épinglé pour les crates Tauri 2, inclut `WebView2Loader.dll` et le bootstrapper WebView2, installe pour l’utilisateur courant et refuse les régressions. La configuration embarque la clé publique ; `~/.auto/updater-auto.key` reste privée. Les signatures Minisign lient les octets et la version. `requireSignedVersion` contrôle cette version signée avant installation. Aucun certificat éditeur Authenticode n’est configuré pour l’installateur initial.

L’hôte Rust recherche les mises à jour au démarrage et depuis le menu **Auto**. Une proposition permet d’enregistrer ses documents avant l’installation et le redémarrage. Ce circuit n’ouvre aucune commande IPC au contenu web distant. La qualification du 25 octobre a téléchargé et vérifié l’installateur réel depuis la production avec le plugin Rust ; le poste installé est passé de 0.1.0 à 0.2.0. Le propriétaire a ensuite confirmé sa connexion et son tableau de bord dans l’application Windows.

### Android signé

```sh
bun scripts/build-android.ts --release
bun scripts/signer-android.ts
```

Définir `JAVA_HOME`, `ANDROID_HOME` et `NDK_HOME` sur les SDK présents. La compilation release ne porte pas le drapeau débogable et refuse le trafic HTTP en clair. La signature utilise `~/.auto/android-release.p12` ; son mot de passe reste dans le coffre système `Auto.Android.Release`. Conserver cette clé pour les futures versions. Le script aligne les bibliothèques sur 16 Ko, signe et vérifie l’APK avec `apksigner`. Les signatures v2/v3 sont vérifiées et le SHA-256 du fichier est publié.

Android confirme l’installation d’un APK et exige la même clé pour une mise à niveau ; une application debug existante utilise une autre clé. L’APK release 0.2.0 a été installé sur l’émulateur de qualification isolé, puis connecté réellement à la production via le navigateur et un compte synthétique : le tableau de bord s’affiche dans la WebView release. Les évolutions du front sont disponibles au prochain chargement ; la mise à niveau du paquet natif passe par l’installation Android.

### Film et vérification de production

`bun scripts/publier-media.ts` vérifie le reçu de décodage et le SHA-256 du MP4, vérifie à nouveau les octets transférés puis effectue un renommage atomique. La purge Cloudflare ne concerne que l’URL de la vidéo. Le film français publié le 25 octobre dure 259,833 secondes en 1080p/24 fps ; lecture et recherche à 35 secondes sont qualifiées sur ordinateur et mobile.

`scripts/verifier-production-vps.ts`, exécuté sur le VPS, contrôle les conteneurs actifs : utilisateur 10001, racine et médias en lecture seule, capacités retirées, aucun port exposé, santé, absence des outils OCR dans le web et durabilité PostgreSQL. Il n’affiche aucune variable secrète. Les quatre téléchargements complets ont été reçus depuis l’URL publique et comparés à leurs tailles/SHA-256 ; HEAD et reprise 206 ont également été vérifiés.

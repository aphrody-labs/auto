# Vidéos depuis le monorepo

La chaîne `video:*` produit la présentation française d’Auto pour une entreprise de BTP. Les écrans viennent du front du dépôt, de l’API réelle et d’une vraie base PostgreSQL jetable. Les personnes et pièces sont fictives. Aucun mock réseau ne remplace l’application et aucune session personnelle n’est exportée.

## Préparer le poste

Exécuter depuis la racine du dépôt, avec le runtime Aphrody :

```powershell
bun agent-plugin doctor --json
bun install --frozen-lockfile
docker compose up -d postgres
bun run video:outils
bun run video:doctor
```

La bibliothèque native Auto doit déjà être construite pour l’émission de facture de démonstration : `bun run build:native`. PostgreSQL doit autoriser la création des bases de test ; `DATABASE_URL` utilise le même réglage que les E2E du dépôt. Le banc crée sa propre base, applique les migrations, puis la supprime dans son bloc de nettoyage. Ne pas pointer cette commande vers un serveur où la création de bases de recette serait indésirable.

Le rendu courant exige Windows, Chromium installé, un pilote NVIDIA compatible et FFmpeg avec `h264_nvenc`. Le script d’outils télécharge l’archive officielle du distributeur [Gyan](https://www.gyan.dev/ffmpeg/builds/), compare son SHA-256 publié et l’extrait uniquement dans `.cache/video-outils`. Il n’installe rien dans le système. FFmpeg reste un outil de rendu externe, avec sa licence propre, et n’est pas incorporé au produit Auto.

La voix peut utiliser la synthèse Windows ou le clonage local Chatterbox, qui n’envoie pas l’enregistrement de référence à un service vocal. Pour préparer le profil Chatterbox avec CUDA sur ce poste :

```powershell
$env:UV_PROJECT_ENVIRONMENT = 'C:/chemin/du/depot/.cache/voix-auto'
bun uv sync --locked --python 3.12 --project scripts/video-voice
$env:AUTO_VIDEO_VOICE_REFERENCE = 'C:/chemin/vers/un-extrait-consenti.wav'
bun scripts/video-lancement-voix.ts
```

`scripts/video-voice/pyproject.toml` et son verrou pinent Python 3.12, Chatterbox et les roues PyTorch CUDA 12.4. `chatterbox-tts` 0.1.7 fournit le modèle multilingue V2 (français) ; sa sortie locale est générée à partir d’un extrait consenti. Le premier lancement télécharge les poids publics du modèle dans le cache Hugging Face de l’utilisateur. Le chemin d’enregistrement n’est pas inclus dans la vidéo publiée. Les sous-titres sont temporisés dans les limites de chaque scène, car cette version ne fournit pas d’alignement mot à mot.

Le propriétaire de capture reste **Bun Video** : `captureNativeWebViewFrames` dans `packages/bun-video/src/hyperframes-native.ts`. Définir les chemins du poste si la découverte automatique ne convient pas :

```powershell
$env:BUN_VIDEO_PACKAGE_ROOT = 'C:/bun/packages/bun-video'
$env:AUTO_CHROME = 'C:/chemin/chrome.exe'
$env:AUTO_VIDEO_FFMPEG = 'C:/chemin/ffmpeg.exe'
$env:AUTO_VIDEO_FFPROBE = 'C:/chemin/ffprobe.exe'
$env:AUTO_VIDEO_CAPTURE_PROVIDER = 'native'
$env:AUTO_VIDEO_FRAME_WORKERS = '4'
```

Le paquet Bun Video est fourni par le checkout/runtime Aphrody du poste ; le dépôt Auto n’en copie pas le moteur et ne dépend pas d’un paquet `latest` à chaque rendu. Le reçu de rendu enregistre le chemin, le SHA-256 du module utilisé, la révision Bun et le GPU effectivement exposé.

Le fournisseur de rendu par défaut est `openChromiumFrameContext` de Bun Video, qui utilise `bun:chromium`, puis le protocole `captureNativeWebViewFrames`. Quatre contextes au maximum sont autorisés, avec une seule image en vol par contexte et une publication ordonnée vers NVENC. `AUTO_VIDEO_CAPTURE_PROVIDER=playwright` sélectionne explicitement l’autre adaptateur qualifié ; il n’y a pas de remplacement silencieux du fournisseur. Le reçu identifie le fournisseur et le GPU réellement interrogé.

## Générer

```powershell
bun run video:tout
```

Les étapes sont aussi indépendantes :

`bun scripts/video-lancement.ts essai` rend deux secondes de composition réelle pour qualifier la capture et l’encodage avant un film complet. Ce fichier de contrôle n’est pas la vidéo finale. Les horodatages des scènes doivent être continus, alignés sur 24 images/s, et les sous-titres doivent rester dans leur scène ; la chaîne refuse les timecodes invalides. Les tests de régression se lancent avec `bun test packages/video/src/timeline.test.ts`.

| Commande                 | Résultat                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `bun run video:captures` | Front et API réels sur PostgreSQL de démonstration ; captures et enregistrement WebM brut |
| `bun run video:preparer` | Scénario JSON et polices locales                                                          |
| `bun run video:voix`     | Voix française, segments audio, timeline alignée sur 24 images/s                          |
| `bun run video:planches` | Une image de contrôle par scène, sans encoder le film                                     |
| `bun run video:studio`   | Composition locale ; URL affichée, arrêt par Ctrl+C                                       |
| `bun run video:rendre`   | Captures déterministes Bun Video et H.264 NVENC en 1920 × 1080, 24 images/s               |
| `bun run video:mix`      | Voix et mixage dans le fichier final                                                      |
| `bun run video:verifier` | Contrôle vidéo/audio et décodage complet du fichier final                                 |

Sortie : `dist/lancement-btp/auto-btp-lancement-fr.mp4`. `image.mp4` est l’intermédiaire muet. Les médias et voix restent dans `dist`, ignoré par Git. Le code, le scénario et la composition sont versionnés.

Après une publication, `bun scripts/video-lancement-production.ts` vérifie le service réel : nouvelle vitrine, HEAD et plages HTTP 206 du MP4, lecture et déplacement dans la vidéo, onglets et pages d’accès, en 1440 pixels et sur un profil mobile tactile de 375 pixels. Les preuves sont conservées dans `dist/lancement-btp/production`.

## Ajouter ou actualiser un parcours

1. Modifier `scripts/video-lancement-captures.ts` pour exercer l’action dans le vrai navigateur. Les données passent par l’API ou les fonctions de stockage du produit. Le banc E2E existant gère l’authentification ; ne pas réécrire ce protocole pour la vidéo.
2. Ajouter la capture au manifeste avec sa provenance. Les fichiers de démonstration et résultats d’extraction préparés doivent rester déclarés comme tels. Une capture du formulaire d’extraction ne qualifie pas un modèle IA.
3. Ajouter une scène dans `packages/video/src/scenario.ts` : identifiant stable, titre, texte métier, image et narration.
4. Relancer captures, préparation, voix et planches. Le rendu final exige la timeline de voix ; il refuse de rendre sur une simple estimation de durée.
5. Inspecter les planches, rendre, mixer et vérifier. La sortie vidéo vérifie le nombre exact d’images ; la vérification finale décode tout le fichier.

La composition expose `window.__hf.seek(seconds)` : chaque image dépend du temps demandé, sans horloge réelle ni attente arbitraire d’animation. Le moteur Bun Video conserve la validation PNG et les délais de chaque capture. L’entrée de l’encodeur est diffusée avec contre-pression ; toutes les images ne sont pas gardées en mémoire.

Les transitions utilisent les transformations et l’opacité. Le rendu de référence garde le mouvement activé ; la composition respecte aussi `prefers-reduced-motion` pour une consultation adaptée. La narration est française et les sous-titres sont inscrits dans l’image. Le mixage conserve la voix au premier plan.

## Couverture et limites

Les captures comprennent les entrées principales de navigation : tableau de bord, clients, fournisseurs, devis et détail, éditeur, facture et paiements, achats, chantiers et analytique, livraisons et commandes, devis reçus, recherche, imports, exports, fichiers et sources, atelier, courrier, employés, absences, automatisations et paramètres. Le site public, la connexion et les deux premières étapes d’inscription sont aussi photographiés sur le service réel. Le formulaire public d’entreprise n’est pas soumis. Une vue mobile réelle est capturée.

Le WebM brut conserve le passage dans l’application ; les PNG permettent le montage pédagogique. Cette couverture de présentation n’est pas une preuve de tous les cas d’erreur, rôles, échanges externes ou combinaisons possibles. Les tests fonctionnels du monorepo restent leur référence. Le courrier, les plateformes de facturation, le paiement, les partages réseau et les modèles IA nécessitent leurs configurations et qualifications propres.

La vidéo propose d’abord le web/PWA. La coque Windows vérifiée ne constitue pas un installateur MSI ; l’APK Android de contrôle ne constitue pas une publication magasin. L’installation locale et la Box sont présentées comme une mise en place accompagnée par le responsable informatique. Le solde du chantier montré est ventes HT moins achats HT validés, hors main-d’œuvre et charges non saisies.

La RTX peut être utilisée par le compositeur Chromium et par l’encodeur NVENC : ces deux étapes sont qualifiées séparément. Les fonctions WebGPU de calcul de Bun Video ne sont pas présentées comme un lien direct entre shaders et encodeur. `Bun.Video.available` est contrôlé séparément des codecs réellement décodés.

## Direction graphique

Principes retenus après recherche du 25 octobre 2026 : [Atlas Motion de Lusion](https://lusion.co/projects/atlas_motion/) pour le ton industriel, [Apple](https://www.apple.com/macbook-pro/) pour la progression par bénéfices et [Linear](https://linear.app/) pour les écrans au premier plan. La vidéo utilise ses propres textes, captures, tracés et animations ; aucune ressource de ces sites n’est embarquée.

Autres références vérifiées : [Motion Canvas](https://github.com/motion-canvas/motion-canvas), [Anime.js](https://github.com/juliangarnier/anime), [Motion](https://github.com/motiondivision/motion) et [Three.js](https://github.com/mrdoob/three.js), sous MIT. [GSAP](https://github.com/greensock/GSAP) et [Remotion](https://github.com/remotion-dev/remotion) ont des licences spécifiques à consulter avant emploi. Aucun de ces moteurs supplémentaires n’est ajouté pour ce film.

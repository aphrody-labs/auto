# Automatisations

Workflows visuels intégrés à auto, à la manière de n8n : un déclencheur, des nœuds reliés sortie → entrée, des
éléments JSON qui circulent de nœud en nœud. Chaque entreprise a ses workflows, ses secrets et son historique
d'exécutions, isolés par la RLS. n8n reste utilisable en plus (webhooks signés, voir N8N.md).

| Couche  | Où                                                     | Rôle                                                                  |
| ------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Moteur  | `packages/automate`                                    | Schéma (Zod 4), expressions, catalogue de nœuds, exécution, modèles   |
| Données | `packages/store/src/automatisations.ts`, migration 017 | Workflows, exécutions (200 conservées par workflow), secrets chiffrés |
| Savoir  | `packages/store/src/connaissance.ts`, migration 019    | Morceaux et embeddings des bases de connaissances                     |
| Accès   | `packages/services/src/automatisations.ts`             | Garde réseau, boîte mail, API d'auto, secrets, URL de webhook signée  |
| API     | `apps/api/src/modules/automatisations.ts`              | `/v1/automatisations…`, `/v1/executions/:id`, `/v1/secrets`, webhooks |
| Worker  | `apps/worker/src/automatisations.ts`                   | Exécutions déclenchées par un événement ou un cron                    |
| Éditeur | `apps/web/src/client`                                  | Canevas, palette, paramètres, essai, historique                       |

## Déclencheurs

| Type                    | Démarre                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declencheur.manuel`    | depuis l'éditeur, l'API (`POST /v1/automatisations/:id/executer`), le CLI ou le MCP                                                                                               |
| `declencheur.evenement` | à chaque événement de l'entreprise (`document.emis`, `paiement.enregistre`…) : job enfilé dans la transaction de l'événement, donc jamais perdu ni envoyé pour une action annulée |
| `declencheur.planifie`  | selon un cron à 5 champs dans le fuseau du workflow (`Bun.cron.parse`), une fois par minute due                                                                                   |
| `declencheur.webhook`   | à chaque requête sur l'URL secrète `/v1/public/crochets/<jeton>` ; `reponse: "fin"` renvoie la sortie du workflow, sinon 202 et exécution par le worker                           |

## Nœuds

Logique : si, aiguillage, laisser passer, attendre (60 s au plus), arrêter. Données : définir, filtrer, trier, limiter,
dédoublonner, seulement les nouveaux (mémoire conservée entre exécutions, éphémère pendant un essai), regrouper,
éclater une liste, créer un tableur xlsx et lire un tableur (xlsx, ods, csv) par la crate native
`auto-sheets`, et les fichiers PDF, Word et PowerPoint (voir plus bas). Réseau : requête HTTP, extraction d'une page web par sélecteurs CSS (`HTMLRewriter`), flux
RSS ou Atom (`Bun.XML`), Home Assistant (appel de service, état d'une entité), dépôt Nextcloud par WebDAV.
Communication : mail (boîte de l'entreprise, pièce jointe facultative), Slack, Discord, Telegram, et les services libres
auto-hébergeables ntfy, Gotify, Matrix (transaction idempotente par élément) et Mastodon (clé d'idempotence). IA : modèle compatible OpenAI (Ollama, Mistral, OpenAI…), OCR par un modèle de vision,
base de connaissances (indexer, rechercher ; voir plus bas). auto : toute route de l'API
(`auto.requete`) avec les droits de l'auteur du workflow, par un jeton temporaire révoqué en fin d'exécution ;
comptes, jetons et automatisations restent inaccessibles. Sous-workflows (`auto.workflow`) : un workflow de l'entreprise exécuté avec
les éléments reçus, ensemble ou un par un, ses éléments de sortie (100 au plus) poursuivant le flux ; exécution
consignée côté sous-workflow (origine `workflow:<id>`), trois niveaux d'imbrication au plus, appel de soi-même refusé. Le catalogue complet, paramètres en JSON Schema, est
servi par `GET /v1/automatisations/catalogue`.

## Fichiers PDF, Word et PowerPoint

Par la crate native `auto-fichiers` (suite Craft : `pdfcraft-organize`, `pdfcraft-render`, `pdfcraft-redact`,
`pdfcraft-sign`, `wordcraft-docx`, `wordcraft-pdf`, `deckcraft-pptx`, `deckcraft-pdf`), injectée par `packages/services` comme les tableurs : le moteur reste pur. Les fichiers circulent
en `{ nom, type, base64 }` (pièce jointe d'un mail, sortie d'un autre nœud) ; un fichier d'entrée peut aussi être
une URL téléchargée par le `fetch` gardé (20 Mo au plus).

| Type                             | Rôle                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fichier.pdf_fusionner`          | par lot : fusionne le champ `champ` (`fichier` par défaut, fichier ou liste) de chaque élément, ou la liste `fichiers`, dans l'ordre ; un signet par fichier ; 50 PDF au plus                                                                                                                                                                                                                     |
| `fichier.pdf_pages`              | garde les pages `pages` (« 1-3, 5, 8- », numérotées à partir de 1, dans l'ordre donné)                                                                                                                                                                                                                                                                                                            |
| `fichier.pdf_texte`              | texte dans l'ordre de lecture (couche texte de hayro), pages séparées par une ligne vide, dans `champ` (`texte`) ; `pages` = nombre de pages ; vide pour un scan (pas d'OCR, voir SUITE.md)                                                                                                                                                                                                       |
| `fichier.document`               | gabarit DOCX (`gabarit` ou `url`) dont les champs `{{ nom }}` sont remplacés par `champs` (valeurs résolues par le moteur), sinon par le chemin `nom` de l'élément ; les champs restés vides sont listés dans `manquants`. Sans gabarit : document A4 composé de `titre` et `paragraphes` (style normal, titre1 à titre3, gras). `format` : `docx`, `pdf` ou `docx_pdf` (`fichier` DOCX et `pdf`) |
| `fichier.pdf_caviarder`          | caviardage définitif des `textes` (liste ou un par ligne ; `casse`, `motsEntiers`) et des `motifs` `iban` (clé vérifiée), `email`, `telephone`, `carte`, `date` : le contenu sous chaque occurrence est supprimé des flux et remplacé par un pavé noir (`texteSuperpose` facultatif), puis vérifié ; sortie `occurrences`, `pagesCaviardees`, `parRecherche` ; sans occurrence, PDF inchangé      |
| `fichier.pdf_signer`             | signature PAdES B-B (`ETSI.CAdES.detached`, mise à jour incrémentale) avec `certificat` PKCS #12 en base64 (`{{ $secret.certificat }}`) ou fichier, et `motDePasse` (`{{ $secret.… }}`) ; `raison`, `lieu`, `contact` ; `visible` (page `page`, `rectangle` en points, 200 × 60 en bas à gauche par défaut) ; `certifier` : `aucune_modification`, `formulaires`, `commentaires`                  |
| `fichier.pdf_verifier_signature` | `signatures` (champ, `statut` `valide`/`inconnue`/`invalide`, signataire, date, raison, format, `modifications` après signature, empreinte du certificat, détails) et `signe`, `intacte`, `valide` ; `confiance` : certificats PEM de confiance, sans quoi une signature intacte est « inconnue »                                                                                                 |
| `fichier.presentation`           | par lot : PPTX 16:9, diapositive de titre (`titre`, `sousTitre`) puis une diapositive par élément (`champTitre`, `champPuces` liste ou texte multiligne, puces `{ texte, niveau }` de 0 à 4, `champNotes`) ou par entrée de `diapositives` ; `format` `pptx`, `pdf` ou `pptx_pdf` (diapositives rendues, texte sélectionnable)                                                                    |

Le certificat de signature est un secret (32 000 caractères au plus) : il n'apparaît pas dans les étapes conservées.
Pas d'horodatage ni de révocations (PAdES B-T/LTA), voir SUITE.md.

Un champ de gabarit garde la mise en forme de son `{{` ; il doit tenir dans un paragraphe (Word peut le couper en
plusieurs segments, ce qui est géré) et ne pas contenir d'objet (image, champ Word). Corps, tableaux, en-têtes, pieds
de page, notes et zones de texte sont parcourus.

`continuerSurErreur` sur un nœud : l'élément fautif continue avec un champ `erreur`. Sinon l'exécution s'arrête et
l'erreur est consignée. Une erreur de workflow ne relance pas le job (les mails déjà partis ne repartent pas).

## Nœud Code

JavaScript libre façon n8n (`$input.all()`, `items`, `$json`, `$("id").first().json`, `console.log`, `await`), par lot ou
par élément. Exécuté par QuickJS compilé en WebAssembly (`quickjs-emscripten`) dans un Worker Bun créé pour l'appel : ni
réseau, ni fichiers, ni `Bun`, ni `process` ; 64 Mo, 5 s, résultat de 5 Mo au plus. Le `ShadowRealm` de Bun n'isole pas
(il expose `Bun`, `fetch` et `process`, vérifié sur 1.4.6), d'où ce moteur séparé.

## Expressions

`{{ chemin | filtre:arg }}`, sans `eval`. Variables : `$json` (élément courant), `$noeud.<id>.json` (premier
élément produit par un nœud déjà exécuté), `$secret.<nom>`, `$execution.id`, `$workflow.nom`, `$index`,
`$maintenant`, `$aujourdhui`. Filtres : `majuscules`, `minuscules`, `rogner`, `texte`, `json`, `nombre`,
`arrondi:n`, `euros`, `centimes` (montants d'auto), `longueur`, `premier`, `dernier`, `joindre:sep`,
`defaut:valeur`, `date` (`iso`, `jour`, sinon français), `plus_jours:n`. Une valeur réduite à une seule expression
garde son type.

## Sécurité

- Secrets chiffrés au repos (AES-GCM, clé dérivée de `AUTO_CLE_MAITRE` et du tenant), jamais relus par l'API ;
  leurs valeurs sont masquées dans les étapes conservées. Un workflow actif ne peut citer qu'un secret existant.
- Requêtes sortantes : http(s) seulement, pas d'identifiants dans l'URL, pas de redirection suivie, et en
  production aucune adresse interne (`localhost`, réseaux privés, `.internal`, nom sans point comme un
  conteneur), sauf les hôtes de `AUTO_HOTES_PERMIS` ; `AUTO_RESEAU_LOCAL=permis` ouvre tout le réseau local,
  pour une installation dont on contrôle tous les comptes (Aphrody Box).
- Versions : chaque modification du contenu (nom, description, définition) conserve l'état précédent, 50 au
  plus ; `GET /v1/automatisations/:id/versions`, restauration par `POST …/versions/:numero/restaurer` (l'état
  remplacé devient à son tour une version).
- Nouveaux essais par nœud (0 à 5, attente doublée à chaque fois, 60 s au plus) pour un service momentanément
  en échec ; une erreur de paramètres ou d'expression n'est jamais réessayée. Importés du « Retry On Fail » de n8n.
- Bornes : 100 nœuds, 500 étapes, 5 000 éléments par nœud, 5 minutes par exécution (60 s pour un essai,
  30 s pour un webhook synchrone), 50 workflows et 100 secrets par entreprise.
- L'URL d'un webhook est un jeton signé (HMAC, clé dérivée) portant l'entreprise et le workflow.

## Modèles

`GET /v1/automatisations/modeles` : facture émise sur Slack, remerciement au paiement, récapitulatif des impayés
du lundi, création de client depuis un formulaire, absence sur Telegram, tri des messages par un modèle local,
surveillance d'une API avec alerte Discord, veille RSS résumée par un modèle local, réponses aux questions à partir
de vos documents (base de connaissances).

## Tests

`bun test packages/automate apps/api/src/automatisations.test.ts apps/api/src/connaissance.test.ts apps/worker/src/automatisations.test.ts` ; la
bibliothèque native (`bun run build:native`) sert aux essais de tableurs et de fichiers PDF, Word et PowerPoint de l'API.

## Import depuis n8n

`POST /v1/automatisations/importer-n8n` (outil MCP `importer_n8n`, `auto flux importer export-n8n.json`) convertit
un export n8n : déclencheurs manuel, webhook, planification (cron à 6 champs ramené à 5, intervalles), HTTP, Si,
Filtrer, Définir, Trier, Limiter, Dédoublonner, Éclater, Regrouper, Attendre, RSS, Arrêter, mail, Slack, Discord,
Telegram. Les expressions réduites à des chemins sont traduites (`$('Nœud').item.json.x` → `$noeud.<id>.json.x`,
`$now` → `$maintenant`) ; les nœuds non pris en charge (Code, LangChain…), les authentifications et les
expressions JavaScript sont listés dans les avertissements ; un nœud non pris en charge devient « Laisser passer »
(note « À remplacer ») pour garder le graphe connecté, les notes du canevas sont ignorées, et chaque déclencheur d'un
workflow n8n donne un workflow auto (`autres`). Rien n'est enregistré avant validation. Exemple réel :
`docs/modeles/automatisation-factures/workflow/`.

## Image, vidéo et navigateur (API natives du runtime)

`media.image` (Bun.Image : redimensionner, recadrer, pivoter, niveaux de gris, luminosité, JPEG/PNG/WebP),
`media.video` (Bun.Video, fournisseur Rust FilmCraft : métadonnées, image extraite, GIF de 5 s au plus) et
`reseau.navigateur` (Bun.WebView : page rendue avec son JavaScript, titre, texte visible, capture PNG). Le navigateur
est toujours un Chrome sans interface lancé par le serveur (`backend: { type: "chrome", url: false }`) : sans cette
option, Bun se rattache au Chrome ouvert sur le poste, qui demande une autorisation et bloque. Une page à la fois par
processus ; l'URL passe par la garde réseau. Sans Chrome ou Chromium sur la machine, le nœud échoue avec un message clair.
Tests : `packages/services/src/media.test.ts` (vraie image, vraie vidéo du modèle factures, vraie page).

## OCR par un modèle de vision

`ia.ocr` lit le texte d'une image (scan, photo, capture) : l'image est réduite et réencodée en JPEG par Bun.Image, puis
envoyée à un modèle de vision derrière une API compatible OpenAI (`/chat/completions`, contenu `image_url`) :
aphrody-llama-server avec un modèle multimodal, Ollama (`qwen2.5vl`, `llava`…), OpenAI ou Mistral. Sortie en texte ou en
JSON (`json: true`, par exemple pour extraire les champs d'une facture). C'est l'approche d'`aphrody-ocr-vlm`, sans
binaire ni modèle embarqué dans auto ; `pdfcraft-ocr` a été écarté (alphabet latin sans accents).

## Base de connaissances (RAG)

Chaque entreprise range des documents dans des bases de connaissances nommées (`documents` par défaut ; minuscules,
chiffres, `-`, `_`), puis y cherche les passages utiles à une question avant d'appeler un modèle de langage.

| Type            | Rôle                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ia.indexer`    | `texte`, sinon `fichier` ou `url` : PDF (couche texte, comme `fichier.pdf_texte`), DOCX (texte du corps), sinon texte UTF-8 (Markdown découpé par sections si la source finit par `.md`). Découpe en morceaux de `taille` unités (1 400 par défaut), embeddings par lots de 32, rangés sous `source` (nom du fichier par défaut) : une source déjà indexée est remplacée. Sortie `morceaux`, `remplaces` |
| `ia.rechercher` | `question` → `resultats` (`source`, `position`, `texte`, `score` cosinus), `k` (4 par défaut, 20 au plus), `scoreMin`, `diversite` (λ de MMR, facultatif) ; `contexte` concatène les morceaux (`[source, partie n]`) pour le `prompt` d'`ia.texte`                                                                                                                                                       |

Les embeddings viennent d'une API compatible OpenAI (`POST <api>/embeddings`) : aphrody-llama-server, Ollama
(`nomic-embed-text` par défaut, `bge-m3`…), OpenAI, Mistral ; `cle` par `{{ $secret.nom }}`, appels par le `fetch`
gardé. Une base n'accepte qu'un modèle (et une dimension) : changer de modèle demande de vider la base. Découpage
(`ProseChunker`, `MarkdownChunker`) et recherche exacte (`fusion::top_k_exact`, `fusion::mmr`) sont faits par la crate
native `auto-connaissance` sur `aphrody-rag-core` ; les vecteurs sont stockés en `bytea` f32 (migration 019, RLS par
entreprise), relus en une matrice pour chaque recherche. Bornes : 20 000 morceaux et 50 bases par entreprise,
4 000 morceaux par source, vecteurs de 8 192 composantes au plus.

API : `GET /v1/connaissances` (bases, sources, morceaux, modèle, dimension), `DELETE /v1/connaissances/:base`
(`?source=` pour une seule source). Modèle de workflow « Répondre aux questions avec vos documents » : webhook
(réponse en fin de workflow) → `ia.rechercher` → `ia.texte` → réponse `{ reponse, sources }`. Test de bout en bout avec
un faux serveur d'embeddings : `apps/api/src/connaissance.test.ts`.

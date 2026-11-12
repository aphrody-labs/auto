# Arrivages depuis un serveur de fichiers

Le connecteur est intégré à l'API et au worker existants. Il utilise les droits du compte système qui exécute
auto. Les identifiants SMB/NFS sont gérés par le montage système, jamais envoyés depuis le navigateur.

## Configuration de l'opérateur

### Dossiers dédiés préparés automatiquement

`AUTO_DOSSIERS_PARENT` active un espace dédié : chaque entreprise reçoit exclusivement le sous-dossier portant
son UUID, sous l'alias `arrivages`. Le worker crée sept sources au premier relevé : clients, fournisseurs/documents,
fournisseurs/devis, fournisseurs/factures, chantiers, livraisons et commandes. Une source désactivée ou modifiée
n'est pas réinitialisée aux relevés suivants. Les entreprises suspendues ou supprimées sont exclues.

Le parent est monté **en lecture seule dans l'API**, en écriture dans le worker pour créer les dossiers vides.
Le scanner conserve son fonctionnement en lecture seule sur les pièces. Sur Linux, préparer ce parent avec
le propriétaire 10001 et le groupe opérateur, en mode 2770 ; les dossiers créés héritent de ce groupe.

```sh
bun scripts/arrivages.ts preparer
bun scripts/arrivages.ts verifier
bun scripts/arrivages.ts synchroniser UUID_ENTREPRISE
```

La vérification interroge le catalogue réel du modèle et contrôle les outils OCR ; elle ne journalise ni secrets
ni contenu des pièces. Un serveur de fichiers préexistant peut toujours être raccordé avec les alias explicites
ci-dessous, sans activer ce mode de préparation.

Monter le partage en lecture seule sur la machine ou le conteneur **de l'API et du worker**. Déclarer ensuite
`AUTO_DOSSIERS_RACINES` dans leur environnement, avec l'identifiant réel de l'entreprise obtenu via `/v1/moi` :

```json
{ "comptabilite": { "tenantId": "UUID_ENTREPRISE", "chemin": "/mnt/comptabilite" } }
```

Sur Windows, un chemin UNC accessible au compte du service convient aussi :

```json
{ "comptabilite": { "tenantId": "UUID_ENTREPRISE", "chemin": "\\\\serveur\\comptabilite" } }
```

Chaque alias appartient à une entreprise précise. Les autres entreprises ne le voient pas. Un administrateur
ne peut choisir qu'un alias déclaré et un sous-dossier relatif ; chemins absolus, `..` et sorties de racine
sont refusés. Les liens symboliques et jonctions rencontrés pendant la relève sont ignorés.

Pour Docker, monter le partage sur l'hôte puis ajouter aux deux services API et worker un volume en lecture seule :

```yaml
environment:
  AUTO_DOSSIERS_RACINES: '{"comptabilite":{"tenantId":"UUID_ENTREPRISE","chemin":"/mnt/comptabilite"}}'
volumes:
  - /srv/partages/comptabilite:/mnt/comptabilite:ro
```

Appliquer les migrations avec le processus existant, puis redémarrer API et worker avec le même environnement.
Dans **Serveur de fichiers**, connecter un dossier et lancer **Synchroniser**. L'écran indique les nouveautés,
les fichiers inchangés, les erreurs et la dernière relève. Désactiver une source arrête les futures relèves
sans effacer ses copies. Changer son segment requalifie immédiatement l'accès aux copies déjà indexées.

## Extraction automatique

Pour une source « Extraire les devis », choisir le segment fournisseurs. Configurer le service compatible
OpenAI existant avec `AUTO_LLM_URL`, `AUTO_LLM_MODEL` et éventuellement `AUTO_LLM_KEY`. Le même service et les
mêmes quotas que l'ingestion des factures sont réutilisés. L'OCR utilise les outils déjà installés ; le texte
natif des PDF est aussi pris en charge. Sans OCR exploitable ou modèle configuré, l'original est conservé avec
une anomalie et une saisie manuelle reste possible. Après correction de la configuration, relancer l'extraction
depuis la revue du devis. Un dépôt identique ne relance pas le modèle ni ne crée un doublon.

La relève mail existante reconnaît les pièces PDF/images portant « devis » dans leur nom ou dans le sujet.
Une pièce Factur-X ou explicitement nommée « facture » conserve le circuit facture, même dans un message mixte.
Les données du document sont traitées comme des données non fiables, puis contrôlées avant validation.

PDF, PNG/JPEG, DOCX, XLSX, CSV, XML et TXT sont indexables. Limites : 20 Mo par pièce et 2 000 entrées par relève.
Subdiviser les très gros dossiers en plusieurs sources ; la limite est signalée, sans suppression d'originaux.
Les copies sont immuables et conservées selon les règles de rétention de l'entreprise. Désactiver une source
n'efface pas son historique. L'interface liste les 500 copies les plus récentes ; la recherche globale interroge
tout l'index autorisé.

## Vérification

```sh
bun check
bun lint apps packages scripts
bun test apps/api/src/modules/arrivages.test.ts apps/web/e2e/arrivages.test.ts
```

Les tests utilisent des bases et dossiers temporaires : relève réelle de fichiers, déduplication, extraction
simulée déterministe, reprise d'échec, création unique de brouillon et refus d'accès inter-entreprises/par segment.
Ils n'établissent aucune connexion à un partage client dont le montage n'a pas été configuré.

## Installation Auto sur le VPS

Le parent de production est `/home/ubuntu/auto/arrivages`, celui de recette
`/home/ubuntu/auto/recette/arrivages`. Ils sont distincts et montés dans `/mnt/arrivages` de leur environnement.
Les fichiers se déposent par l'accès SFTP opérateur existant, dans le dossier UUID de l'entreprise et le
sous-dossier concerné. Aucun droit n'a été ajouté au partage Samba `games`.

Le modèle de base Qwen3-4B-Instruct-2507 Q4_K_M déjà présent sur `dbfr` est servi sans l'adaptateur spécialisé
Shenron, par le conteneur `auto-extraction-ia`, limité à deux CPU et 4 Gio. Le service existant est conservé.
Le port 8798 écoute uniquement sur la boucle locale de dbfr. Le service systemd `auto-ia-tunnel` du VPS relie
ce port aux passerelles Docker privées : production `172.26.0.1:18799`, recette `172.27.0.1:18799`.
Les deux règles UFW sont limitées à leurs interfaces et sous-réseaux Docker ; aucun port IA public n'est ouvert.

`AUTO_LLM_MODEL=auto-extraction` et `AUTO_LLM_TIMEOUT_MS=300000` tiennent compte de l'inférence CPU. La Box
réutilise automatiquement son Ollama et `BOX_MODELE` pour les extractions ; les valeurs `AUTO_LLM_*` explicites
restent prioritaires. Le rendu OCR français est inclus dans les images complètes et les mises à jour rapides.

Avant chaque remplacement de conteneur, la configuration et l'environnement ont été conservés en fichiers privés
sous `~/auto/activation-arrivages-*`. Les anciens conteneurs sont conservés arrêtés sous un nom
`*-avant-arrivages*`, pour permettre le retour arrière. Ne pas publier ces dossiers : ils contiennent des secrets.

# Fournisseurs, chantiers et analytique

Ces fonctions prolongent l'application `auto` et son API `/v1`. Les données sont enregistrées dans Postgres,
isolées par entreprise avec `withTenant`, RLS forcée et clés étrangères composites. Aucun stockage navigateur
ou service de facturation distinct n'est nécessaire. Les écritures exigent le droit `ecrire` ; les consultations
restent ouvertes aux rôles autorisés à lire.

## Parcours

1. Créer les fiches dans **Clients** et **Fournisseurs**. Le dossier fournisseur rassemble ses factures reçues
   classées, ses coordonnées, ses bons de livraison et confirmations de commande.
2. Créer un **Chantier** lié à un client : code analytique unique, adresse, budget HT, avancement, dates et statut.
3. Depuis le chantier, **Créer un devis** ou une facture reprend le client et le code analytique dans l'éditeur
   existant. Les lignes, remises, TVA, émission, PDF et Factur-X réutilisent les règles existantes.
4. Dans **Factures reçues**, utiliser **Classer** pour choisir un fournisseur et éventuellement un chantier.
   L'ingestion existante par API, mail, extension et plateforme reste inchangée.
5. Dans **Livraisons et commandes**, saisir la référence fournisseur, le chantier, la date, les lignes et les
   réserves éventuelles. Une pièce peut être rapprochée d'une facture reçue ; l'affectation doit correspondre.
6. Archiver les fournisseurs, chantiers ou pièces depuis leur formulaire. Les archives restent consultables et
   continuent de participer à l'historique et aux calculs. Elles peuvent être restaurées en décochant « archivé ».

## Analytique

- Une vente ou un achat est affecté à **un seul chantier**, sans ventilation par ligne ou pourcentage.
- **Ventes HT** : factures et acomptes émis, avec déduction des avoirs. Les avoirs suivent automatiquement le
  chantier de leur facture d'origine, même sans affectation manuelle. Une facture soldée par un avoir reste
  compensée dans le calcul ; une facture annulée sans avoir est exclue. Devis et brouillons sont exclus.
- **Achats HT** : factures reçues validées en EUR et affectées au chantier ; avoirs fournisseurs déduits.
  Une extraction absente ou une devise différente est signalée et exclue. Les factures rejetées ou à vérifier
  sont exclues.
- **Solde HT** : ventes HT moins achats HT. Ce n'est pas une marge nette : main-d'œuvre et charges non saisies
  n'y figurent pas.
- **Commandes non facturées HT** : confirmations validées, tant qu'aucune facture rapprochée n'est validée.
  Les bons de livraison ne créent pas de charges supplémentaires. Ces engagements restent séparés du solde.
- Un export CSV du dossier fournit le code analytique, les ventes et les achats, y compris leur statut.
- **Exports → Les cinq espaces de gestion** fournit un fichier Excel à cinq onglets, avec montants numériques
  formatés en euros, dates, en-têtes figées et archives comprises. Le rapport PDF reprend ces mêmes données, sans
  reproduire la mise en page d'un classeur préexistant. Il est limité à 10 000 lignes ; le classeur complet n'est pas tronqué.

Les affectations sont des métadonnées séparées : modifier un rattachement ne modifie ni le document émis ni son
exemplaire PDF/Factur-X. Le client du chantier doit correspondre au client enregistré du document. Un chantier
avec des documents affectés ne peut pas changer de client. Chaque changement de classement est audité.

## API et stockage

Migration : `packages/store/migrations/022_chantiers.sql` (nouvelle migration, aucune migration antérieure modifiée).
Application en développement : `bun run migrate`. Ne pas appliquer en production sans le processus de déploiement habituel.

| Routes                                     | Usage                                                             |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `/v1/fournisseurs`, `/:id`, `/:id/dossier` | Répertoire, modification et dossier fournisseur                   |
| `/v1/chantiers`, `/:id`                    | Répertoire, modification, documents, achats, pièces et analytique |
| `/v1/documents/:id/chantier`               | Lire ou changer l'affectation d'une vente                         |
| `/v1/factures-recues/:id/affectation`      | Classer un achat reçu                                             |
| `/v1/pieces-chantier`, `/:id`              | Créer, consulter, rapprocher et archiver les pièces               |

Les corps complets et droits figurent dans `docs/openapi.json`. Les nouvelles tables et leurs pièces sources
sont intégrées à l'export et au cycle de conservation du tenant. La purge respecte l'ordre des références.

Les bons et confirmations sont des fiches structurées saisies manuellement ; cette version n'ajoute pas
d'extraction OCR de ces deux types de pièce ni de génération de PDF spécifique à ces fiches.

## Recherche et organisation des espaces

`/app/livraisons` et `/app/commandes` sont deux espaces distincts. `/app/pieces` conserve une vue transversale.
`/app/recherche` retrouve devis, factures, achats et pièces, y compris les pièces archivées, par référence, tiers,
chantier ou texte déjà extrait. Les agents disposent des outils `chercher_piece_gestion` et `consulter_chantier`,
avec le jeton et les droits de l'utilisateur. Les exports Excel et PDF passent par `/v1/exports/gestion.xlsx` et
`/v1/exports/gestion.pdf` ; la recherche par `/v1/recherche-gestion?q=…`.

## Serveur de fichiers et devis reçus

La migration `023_arrivages_segments.sql` ajoute les sources, les copies indexées, les devis reçus et les
restrictions par membre. Dans **Serveur de fichiers**, un administrateur choisit un montage autorisé, un
sous-dossier et un traitement : indexation seule, extraction des factures ou extraction des devis. Le worker
relève les dossiers actifs toutes les cinq minutes ; **Synchroniser** déclenche aussi une relève manuelle.
Le connecteur lit les partages SMB/UNC ou NFS montés par le système, ainsi que les dossiers locaux. Configuration
et exemple Docker : [ARRIVAGES.md](ARRIVAGES.md).

Les originaux ne sont jamais déplacés ou supprimés. Une empreinte SHA-256 évite les doublons ; une nouvelle
version crée une copie supplémentaire. Les copies restent consultables si le serveur devient indisponible.
Les fichiers indexés et leur contenu rejoignent la recherche globale et ses restrictions par segment.

**Devis reçus** accepte PDF et images, depuis un dépôt, une source ou une pièce jointe identifiée comme devis.
L'OCR et le modèle configurés extraient l'émetteur, la référence, les dates, les prestations et les montants.
La pièce reste **À vérifier**, même si l'extraction réussit. Le formulaire permet de corriger et valider ;
**Relancer l’extraction** reprend l'original en cas d'échec. Après validation et choix explicite d'un client,
un seul brouillon client peut être prérempli. Ce brouillon réutilise l'éditeur existant ; aucune facture n'est
émise automatiquement. Les remises ou arrondis incompatibles avec les lignes doivent être repris manuellement.

## Permissions par segment

Dans **Paramètres → Membres → Permissions par segment**, un propriétaire ou administrateur attribue les espaces clients,
fournisseurs, analytique chantier, livraisons et commandes à chaque autre membre. Ces restrictions s'ajoutent
au rôle existant : elles n'accordent jamais un droit d'écriture absent du rôle. Sans restriction enregistrée,
les accès existants sont conservés ; une sélection vide retire les cinq espaces. Propriétaires et administrateurs
conservent tous les segments.

Chaque requête relit les droits : sessions, clés API et agents sont concernés immédiatement. Recherche,
téléchargements, dossiers et exports filtrent les pièces accessibles. Les listes de référence minimales restent
partagées pour rattacher une livraison à un fournisseur ou chantier ; elles ne donnent pas accès à leurs dossiers.
L'analytique donne accès aux agrégats HT, mais les documents clients et fournisseurs détaillés exigent leur segment.
Les fonctions transversales mail, PA, automatisations, connaissances et conformité exigent les cinq segments.
Les exports de gestion ne contiennent que les onglets autorisés.

## Vérification

```sh
bun check
bun lint apps packages scripts
bun test packages/store/src/chantiers.test.ts apps/api/src/modules/chantiers.test.ts apps/api/src/openapi.test.ts
bun test apps/web/e2e/chantiers.test.ts
```

Les tests utilisent une base jetable. Le parcours navigateur réutilise le banc Chrome existant et vérifie
les écrans à 375, 768 et 1440 pixels, le thème sombre, la réduction des animations et les erreurs JavaScript.

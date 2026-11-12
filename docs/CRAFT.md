# Craft dans Auto

Auto intègre les véritables éditeurs Bun OS Gridcraft (Excel), Wordcraft (Word) et PDFcraft, servis depuis la même origine. Les moteurs Rust existants restent propriétaires de la lecture, du rendu et des transformations ; aucun moteur Office parallèle n'est ajouté.

## Utilisation

L’espace **Word, Excel et PDF** permet de créer un classeur ou un courrier, importer un fichier et retrouver ses versions. Les fichiers indexés des arrivages peuvent être copiés dans cet espace, sans modifier leur original. Chaque document appartient à un segment comptable ; les permissions habituelles déterminent qui peut le consulter et le modifier. Un utilisateur en lecture consulte l’aperçu et télécharge les fichiers.

Dans l’éditeur, **Enregistrer** ou Ctrl+S conserve une nouvelle version sur le serveur. Une sauvegarde concurrente est refusée avec conflit 409 ; les modifications restent téléchargeables ou conservables dans une nouvelle copie. La restauration crée une nouvelle révision. Les factures émises restent séparées de ces documents de travail.

## Distribution WASM

Les ressources sont dans `apps/web/public/craft`, avec manifeste `11f9687984d2f5ae`, WASM compressés gzip, thèmes et notices de licences. Le serveur les lit sous `AUTO_PUBLIC_DIR/craft` si cette variable est définie. Elles sont copiées dans les conteneurs et distributions autonomes ; aucun téléchargement externe n’est requis à l’ouverture.

Provenance : Gridcraft et PDFcraft viennent de la distribution canonique `2026-10-24T19-44-50-429Z`. Wordcraft inclut le pont parent du checkpoint Bun OS `b83b388f77`, compilé et assemblé sur VPS par le pipeline du propriétaire. Les métadonnées et SHA-256 des contenus décompressés sont dans le manifeste.

Pour réimporter une distribution qualifiée, préparer un dossier contenant `grid/`, `word/`, `pdf/` et `sources.json`, puis exécuter :

```sh
bun scripts/craft-web.ts chemin/vers/distribution
```

Ne pas reformater le JavaScript généré ; les fichiers sont référencés par leur empreinte. Le bootstrap HTML est externalisé pour la CSP. Le pont vérifie exactement l’origine et la fenêtre émettrice. Les ressources publiques ne contiennent aucun document métier ; leur ouverture passe par l’API authentifiée.

## API et bibliothèques natives

Migration 024 : documents et révisions sous RLS par entreprise. Routes `/v1/atelier` : création/import, liste, consultation, archivage, téléchargement courant ou historique, sauvegarde optimiste, restauration, opérations natives et export Word en PDF. Les contrats figurent dans OpenAPI ; `@auto/client` expose les méthodes typées.

`OperationAtelier`, partagé depuis `@auto/store`, décrit les modifications. Excel utilise `auto-sheets::modifier`, FFI `xlsx_modifier` et `modifierXlsx` : coordonnées à partir de 1, styles conservés, formules recalculées par `gridcraft-calc` vendorisé dans `vendor/suite`. Word utilise `auto-fichiers::remplacer_docx`, FFI `docx_remplacer` et `remplacerDocx` : remplacements Unicode dans paragraphes, tableaux et parties liées, attributs conservés. PDF réutilise les opérations natives existantes. Reconstruire auto-ffi avant de déployer ces routes.

## Vérifications

Les tests ciblés couvrent recalcul Excel, remplacement Word Unicode, export PDF, permissions entre entreprises et segments, concurrence, historique, restauration, CSP, chemins et décodage du protocole. La recette `bun apps/web/e2e/craft-qualification.ts` utilise Chrome et une base jetable : chargement des trois WASM réels, saisie puis sauvegarde Excel et Word contrôlée par l’inspection serveur, ouverture PDF et contrôle de débordement aux largeurs 375 et 768 pixels. Les captures et journaux de qualification se trouvent dans `.cache`.

## Recette publique du 25 octobre 2026

Parcours exécuté sur `https://auto.aphrody.com`, dans une entreprise de contrôle distincte : dépôt réel DOCX dans le serveur de fichiers, synchronisation et extraction IA (600,00 EUR TTC sans anomalie), copie dans Wordcraft, saisie au clavier d’un prix unitaire de 300,00 EUR HT, sauvegarde version 2, nouvelle extraction IA (720,00 EUR TTC sans anomalie), validation dans l’interface et création d’une facture préremplie **en brouillon**, sans numéro ni émission.

Facture de contrôle : `33b2ac9f-b8b5-4db2-a792-9c39966024c3`. Original devis : `80fe88f4-9ead-463e-b5cf-4d32cb04175a`. Copie Craft : `087806ba-ffb6-4d97-a563-3b7536ce3f0a`. Le contrôle des écrans à 375 et 768 pixels ne relève aucun débordement, et Chrome ne relève aucune erreur JavaScript. Preuves dans `.cache/parcours-reel-browser.log` et `.cache/parcours-reel-*.png`.

La recette a corrigé le passage Word/PDF sauvegardé vers la revue IA, le choix devis/facture pour le brouillon et une incompatibilité de sérialisation SQL des listes sur le runtime de production. Les paramètres de listes sont transmis par JSON texte puis décodés côté Postgres ; aucune concaténation SQL de valeurs utilisateur.

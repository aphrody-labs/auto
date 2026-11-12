# Auto local sur Windows

L’instance installée sur ce poste est accessible sur <http://127.0.0.1:3007/app>. Le raccourci **Auto local** du menu Démarrer ouvre une connexion depuis la session Windows courante. La tâche planifiée **Auto local Windows** relance l’API, le web et le worker à l’ouverture de session, sans console visible.

## Identité et secrets

Le lanceur interroge l’identité Windows réelle (nom et SID), puis lit la configuration dans **Windows Credential Manager** par `Bun.secrets` (`Auto.Windows.Local/instance`). Le SID du compte courant doit correspondre à celui de l’installation. Aucun mot de passe Windows ou Google n’est copié. Le propriétaire local est lié au fournisseur `windows-local` de Better Auth ; aucune entreprise fictive n’est créée pour son accès administrateur personnel.

La commande `connexion` produit en mémoire un lien Better Auth officiel à usage unique pour ce propriétaire, puis l’ouvre dans le navigateur. Le cookie de session est géré par Better Auth. Le jeton n’est pas affiché dans les journaux ni envoyé par mail. Cela réutilise la session Windows déjà ouverte ; AD, Kerberos, NTLM web et une nouvelle authentification biométrique Windows Hello ne sont pas déclarés configurés.

L’API et le web écoutent uniquement sur `127.0.0.1` (ports 3006 et 3007). Postgres est isolé dans `auto-pg-windows`, port 5544 limité à la boucle locale, volume `auto_windows_pgdata`, avec fsync actif et identifiants aléatoires dans le coffre Windows. L’instance cloud et ses secrets restent distincts.

## Commandes

```powershell
bun scripts/windows-local.ts configurer
bun scripts/windows-local.ts proprietaire adresse@exemple.fr
bun scripts/windows-local.ts installer
bun scripts/windows-local.ts connexion
bun scripts/windows-local.ts etat
bun scripts/windows-local.ts inventaire
bun scripts/windows-local.ts preparer
bun scripts/windows-local.ts arreter
```

`configurer` préserve une installation existante. `proprietaire` ne réaffecte pas implicitement un compte déjà lié. `installer` crée la tâche et le raccourci pour le compte Windows courant. `arreter` conserve les données. Le dépôt et le runtime installés doivent rester au chemin utilisé par la tâche ; réexécuter `installer` après déplacement.

Le tunnel IA utilise le service déjà configuré sur `dbfr` via SSH, avec le modèle `auto-extraction`, sur la boucle locale 18798. Le lanceur réutilise un tunnel disponible et en démarre un sous le même compte Windows si nécessaire. L’accès SSH existant et le réseau privé doivent être disponibles ; les clés ne sont pas recopiées dans Auto.

## Dossiers, classeurs et réseau

La racine dédiée est `C:\Users\aphro\Documents\Auto\Arrivages`. Le préparateur crée un sous-dossier UUID par entreprise et les espaces clients, fournisseurs, devis, factures, chantiers, livraisons et commandes. Les permissions par segment d’Auto s’appliquent aux fichiers indexés et aux copies Craft.

Un dossier local ou UNC accessible au compte Windows courant se raccorde explicitement à une entreprise :

```powershell
bun scripts/windows-local.ts raccorder UUID_ENTREPRISE comptabilite '\\serveur\comptabilite'
```

Redémarrer ensuite l’instance locale et connecter l’alias dans **Serveur de fichiers**. Windows applique ses propres autorisations et identifiants réseau ; aucun mot de passe SMB ne transite dans le formulaire web. `inventaire` donne les interfaces, lecteurs et partages actuellement montés, sans parcourir tous les fichiers du poste ni scanner le LAN. Les partages existants ne sont pas automatiquement affectés à la comptabilité.

Les fichiers `.xlsx` sont lus et modifiés avec Gridcraft/Rust, puis conservés en versions dans Auto. Microsoft Excel n’est pas installé sur ce poste selon le registre Windows : une connexion COM à une application Excel ouverte n’a donc pas été qualifiée. Les échanges de fichiers XLSX fonctionnent avec Craft.

## Vérifications réelles

- Session Windows `APHRODY\aphro` (CloudAP), coffre Windows et tâche planifiée opérationnels.
- Connexion locale : `/v1/admin/moi` répond 200 avec `super_admin` ; rejeu du lien refusé ; faux en-têtes IP et utilisateur Windows sans session refusés 403.
- Compte et entreprise **QA Windows local** isolés : un XLSX déposé dans le dossier Windows a été relevé, copié dans Craft, modifié au clavier à 42 et sauvegardé en révision 2. Le fichier source est intact.
- Recette : `bun apps/web/e2e/windows-local-reel.ts`. Captures et preuves dans `.cache/windows-*.png` et `.cache/windows-*.log` ; secrets de recette dans le coffre Windows.

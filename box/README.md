# Aphrody Box

Une seule commande installe sur votre machine ou votre serveur un ensemble prêt à l'emploi :

| Application  | Rôle                                                                                        | Adresse                  |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------ |
| **Console**  | Tableau de bord : état de chaque service, journaux, redémarrage, modèles d'IA, identifiants | `http://<machine>:8080`  |
| **Auto**     | Automatisations, factures et devis                                                          | `http://<machine>:8081`  |
| **n8n**      | Éditeur de workflows (plus de 400 applications)                                             | `http://<machine>:5678`  |
| **Hermes**   | Assistant IA qui agit pour vous : mémoire, outils, Telegram, Discord, Slack                 | `http://<machine>:9119`  |
| **Obsidian** | Vos notes dans le navigateur                                                                | `https://<machine>:3001` |
| **Courrier** | Les courriels envoyés par la boîte                                                          | `http://<machine>:8025`  |

Tout fonctionne sur la machine : les modèles d'IA sont servis par **Ollama**, aucune donnée ne part chez un
fournisseur d'IA.

## Installer

Il faut [Docker](https://docs.docker.com/engine/install/) (Docker Desktop sous Windows et macOS), 16 Go de mémoire
conseillés et 25 Go de disque libre.

Sans carte graphique, Hermes est lent : chaque tour lui envoie environ 12 000 jetons d'instructions et d'outils, que
le processeur traite en plusieurs minutes. Une carte NVIDIA, ou un modèle distant compatible OpenAI réglé dans
`donnees/hermes/config.yaml`, le rend interactif. Hermes exige un modèle d'au moins 64 000 jetons de contexte
(`qwen3:4b`, le modèle par défaut, en accepte 262 144).

Linux et macOS :

```sh
curl -fsSL https://raw.githubusercontent.com/aphrody-labs/auto/main/box/installer.sh | sh
```

Windows (PowerShell) :

```powershell
irm https://raw.githubusercontent.com/aphrody-labs/auto/main/box/installer.ps1 | iex
```

À la fin, le script affiche l'adresse de la console et son mot de passe. Les identifiants de chaque application sont
dans la console, section « Accès ».

Le premier démarrage télécharge les images et le modèle `qwen3:4b` (2,5 Go) : comptez quelques minutes. La console
montre chaque service passer de « Démarre » à « En marche ».

## Ce qui est déjà prêt

- **n8n** : compte propriétaire créé (votre e-mail et le mot de passe affiché dans « Accès »), identifiants
  « Ollama de la boîte » et « Hermes de la boîte » déjà enregistrés, dossier `coffre` lisible et inscriptible
  (`/coffre`).
- **Hermes** : branché sur Ollama, tableau de bord protégé par mot de passe, API compatible OpenAI sur le port 8642
  (clé dans « Accès »), coffre visible dans `/opt/data/coffre`.
- **Obsidian** : le coffre `coffre` est ouvert d'office ; ce sont des fichiers Markdown du dossier `coffre` de la
  boîte, que vous pouvez sauvegarder ou synchroniser.
- **Auto** : nœuds IA reliés à Ollama ; les courriels (inscription, factures) arrivent dans « Courrier » tant
  qu'aucun relais réel n'est configuré.
- **Services de la maison** : les workflows d'Auto pilotent Home Assistant, déposent dans Nextcloud et notifient
  par ntfy, Gotify, Matrix ou Mastodon. Pour atteindre des appareils du réseau local, ajoutez
  `BOX_RESEAU_LOCAL='permis'` dans `.env`, seulement si vous contrôlez tous les comptes de la boîte.
- **Carte graphique NVIDIA** détectée et utilisée par Ollama si le NVIDIA Container Toolkit est installé.

## Sur un domaine, en HTTPS

Faites pointer `*.mondomaine.fr` vers la machine (ports 80 et 443 ouverts), puis :

```sh
BOX_DOMAINE=mondomaine.fr BOX_EMAIL=vous@mondomaine.fr sh installer.sh
```

Chaque application a son sous-domaine (`console.`, `auto.`, `n8n.`, `agent.`, `notes.`, `courrier.`), avec des
certificats Let's Encrypt renouvelés automatiquement.

## Au quotidien

| Besoin                     | Commande, dans le dossier de la boîte                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Arrêter                    | `docker compose stop`                                                                                         |
| Relancer                   | `docker compose up -d`                                                                                        |
| Mettre à jour              | `BOX_MAJ=1 sh installer.sh` (vos données et `.env` sont conservés)                                            |
| Sauvegarder                | copier `.env`, `coffre/` et `donnees/`, et `docker compose exec postgres pg_dumpall -U auto > sauvegarde.sql` |
| Envoyer de vrais courriels | renseigner `AUTO_SMTP_*` dans `.env`, puis `docker compose up -d`                                             |

Le fichier `.env` contient tous les secrets de la boîte : ne le partagez pas.

## Pour les développeurs

La console est écrite en Rust : [Leptos](https://leptos.dev) (rendu serveur puis hydratation WebAssembly), axum,
client du moteur Docker par son socket Unix. `console/` se construit avec `cargo leptos build --release` ou
`docker build console` ; `cargo test --features ssr --lib` lance ses tests. Le préparateur des secrets est la
sous-commande `aphrody-box preparer`.

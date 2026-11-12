# n8n

Automatisation entre les services de la suite.

## Démarrer

```sh
docker compose up -d --wait n8n   # Postgres, base n8n créée si absente, n8n sur http://localhost:5678
bun run n8n:provision auto_…      # credential « API auto » + workflows de infra/n8n/workflows publiés
bun run e2e:n8n                   # bout en bout (API sur le port 3000, Postgres de l'API requis)
```

Image : `n8nio/n8n:2.45.2`.

## auto → n8n : événements

L'API écrit ses événements métier dans l'outbox Postgres, dans la transaction de l'action ; le worker
(`bun run worker`) les livre quand `N8N_WEBHOOK_URL` est défini (voir ARCHITECTURE.md, « Outbox, worker et
planification ») :

```sh
N8N_WEBHOOK_URL=http://localhost:5678/webhook/auto-evenements
N8N_WEBHOOK_SECRET=auto-dev-secret-webhook   # même valeur que dans compose.yaml
bun run worker
```

| Type                  | Émis par                                        |
| --------------------- | ----------------------------------------------- |
| `document.emis`       | `POST /v1/documents/:id/emettre`                |
| `document.statut`     | `POST /v1/documents/:id/statut`                 |
| `paiement.enregistre` | `POST /v1/documents/:id/paiements`              |
| `absence.demandee`    | `POST /v1/employes/:id/absences`                |
| `absence.decidee`     | `POST /v1/absences/:id/decision`                |
| `relance.a_envoyer`   | tâche relances du worker (8 h, J+7, J+30, J+60) |
| `export.mensuel`      | tâche export du worker (le 1er, mois précédent) |

Corps : `{ id, type, tenantId, date, data }`. En-têtes `x-auto-signature: sha256=<hex>` (HMAC-SHA256 du corps brut)
et `x-auto-evenement: <id>`. Un récepteur indisponible ou une réponse non 2xx entraîne un nouvel essai
exponentiel (2 s à 1 h, 15 essais), puis l'événement passe en échec dans l'outbox. Livraison au moins une fois :
un workflow dont l'effet n'est pas idempotent dédoublonne par `id`. Schéma dans `docs/openapi.json` (`webhooks`).

Workflow `infra/n8n/workflows/auto-evenements.json` : vérification de la signature, puis pour une facture émise,
téléchargement du Factur-X par l'API (credential « API auto ») et archivage dans `data/n8n/archives/<tenant>_<numéro>.pdf`
(écrasement idempotent). `e2e:n8n` vérifie que l'archive est identique octet pour octet au Factur-X de l'API et
conforme PDF/A-3b. Une relance (`relance.a_envoyer`) est transmise telle quelle, signature comprise, au workflow
`auto-relances`.

## Relances

Workflow `infra/n8n/workflows/auto-relances.json` (webhook `auto-relances`) : vérification de la signature,
dédoublonnage par `id` (données statiques du workflow, 30 jours), préparation du mail selon le palier (rappel,
deuxième relance, mise en demeure ; sans adresse du client, rien n'est préparé), puis nœud « Envoyer le mail »
(SMTP), **désactivé par défaut**. Pour l'activer : credential SMTP sur le nœud, `AUTO_MAIL_FROM` dans
l'environnement de n8n, puis activer le nœud. La relance est notée côté auto (`relance`, canal mail) au moment
où l'événement est publié. `workflows.test.ts` exécute les nœuds de code des deux workflows sur un corps signé.

## n8n → auto : API

Jeton d'API (`POST /v1/jetons`) stocké chiffré dans n8n par `n8n:provision` (credential `httpHeaderAuth`,
`Authorization: Bearer auto_…`). Un jeton appartient à un tenant : une instance n8n provisionnée agit pour ce tenant.
Depuis le conteneur, l'API de l'hôte est `$env.AUTO_API_URL` (`http://host.docker.internal:3000`).

## Abonnements par entreprise (n8n multi-tenant)

En plus de la livraison opérateur (`N8N_WEBHOOK_URL`), chaque entreprise peut abonner ses propres
destinations : `POST /v1/webhooks` avec une URL https (son n8n, son espace n8n hébergé, tout autre outil)
et, en option, la liste des types d'événements voulus. La réponse contient le secret de signature, montré
une seule fois et chiffré au repos (AES-GCM, clé dérivée de `AUTO_CLE_MAITRE` et du tenant).

Le worker livre chaque événement du tenant à ses abonnements (job `webhook.livrer`, nouvel essai
exponentiel), avec le même corps et les mêmes en-têtes que la livraison opérateur : `x-auto-signature`
(HMAC-SHA256 avec le secret de l'abonnement) et `x-auto-evenement`. Le workflow `auto-evenements.json`
sert de modèle de vérification côté n8n. Les données d'un tenant ne partent jamais vers l'abonnement d'un
autre : l'abonnement est lu sous la RLS du tenant de l'événement, et le worker vérifie la correspondance.

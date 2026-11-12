---
name: auto
description: Automatiser et gérer l'entreprise de l'utilisateur dans auto (workflows d'automatisation type n8n, devis, factures Factur-X, paiements, relances, factures fournisseurs reçues, absences, exports) avec les outils MCP du serveur « auto ». À utiliser dès que l'utilisateur parle d'automatiser une tâche, de workflows, de ses devis, factures, clients, impayés, relances, factures reçues ou congés.
---

# auto

Les outils `mcp__auto__*` agissent sur le compte auto de l'utilisateur, dans l'entreprise choisie lors de
l'autorisation OAuth, avec ses seuls droits.

- Chercher avant de créer : `chercher_client`, puis `creer_devis` ou `creer_facture` avec le `clientId` trouvé.
- Les montants sont en centimes, la TVA en dixièmes de point (200 = 20 %).
- `creer_facture` crée un brouillon. `emettre_document` lui donne son numéro définitif et fige le Factur-X : c'est
  irréversible, demander confirmation à l'utilisateur avant de l'appeler.
- Impayés : `lister_relances` à la date du jour, puis `relancer` au palier indiqué.
- Factures fournisseurs : `lister_factures_recues` (statut `a_verifier` pour celles à contrôler).

## Workflows

- `catalogue_automatisation` d'abord : types de nœuds, paramètres (JSON Schema) et modèles. Partir d'un modèle
  proche plutôt que d'une page blanche.
- Une définition a un seul déclencheur (`declencheur.manuel`, `.evenement`, `.planifie`, `.webhook`), des nœuds
  `{ id, type, nom, parametres, position: [x, y] }` espacés de 280 px en x, et des connexions `{ de, sortie, vers }`
  (`logique.si` : sortie 0 vrai, 1 faux), sans cycle.
- Expressions : `{{ $json.champ }}`, `{{ $noeud.<id>.json.champ }}`, filtres `| centimes`, `| date`, `| defaut:'x'`.
  Les jetons et URL de webhook vont dans des secrets (`{{ $secret.nom }}`, créés par l'utilisateur dans auto),
  jamais en clair dans la définition.
- `creer_automatisation` crée le workflow inactif ; `executer_automatisation` pour l'essayer, `lire_execution`
  pour voir chaque étape. L'activer seulement après accord de l'utilisateur.
- Workflow en code : `auto flux importer workflow.json`.

Configuration : le plugin déclare le serveur MCP distant `https://auto.aphrody.com/mcp` (variable
`AUTO_MCP_URL` pour une autre instance). Au premier appel, Claude Code ouvre le navigateur : connexion à auto,
choix de l'entreprise, autorisation ; le jeton se renouvelle seul. Révocation : auto, Paramètres, Sécurité,
Applications autorisées. Sans navigateur (CI, scripts) : `claude mcp add auto -e AUTO_TOKEN=auto_… -- auto mcp`
avec une clé d'API créée dans Paramètres, Clés d'API.

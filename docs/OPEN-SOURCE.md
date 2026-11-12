# Ce qu'auto reprend de l'open source

Revue des références de l'automatisation par workflows et de ce qu'auto en tire, puis des briques Bun, Bun OS,
Aphrody et Craft effectivement utilisées. « Repris » renvoie au code du dépôt ; « manque » est un écart connu.

## Plateformes d'automatisation

| Projet       | Licence                     | Idée retenue                                                             | Dans auto                                                                                                                                           |
| ------------ | --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| n8n          | Sustainable Use (fair-code) | Graphe de nœuds, éléments `json`, expressions `{{ }}`, sorties multiples | Repris : moteur `packages/automate`, import des workflows n8n (`importerN8n`), n8n lui-même dans l'Aphrody Box                                      |
| n8n          |                             | « Retry On Fail », « Continue On Fail », nœud Code                       | Repris : `tentatives` et `delaiEssaiMs` par nœud (attente doublée), `continuerSurErreur`, nœud Code en QuickJS isolé dans un Worker                 |
| Activepieces | MIT (cœur)                  | Pièces typées par schéma, catalogue exposé à l'IA                        | Repris : paramètres Zod, catalogue en JSON Schema (`GET /v1/automatisations/catalogue`), outils MCP pour créer et lancer                            |
| Node-RED     | Apache-2.0                  | Nœuds communautaires pour les services de la maison et de l'IoT          | Repris : Home Assistant, ntfy, Gotify, Matrix, Mastodon, Nextcloud (API HTTP documentées, sans SDK)                                                 |
| Windmill     | AGPL-3.0                    | Moteur et exécution natifs rapides, scripts isolés                       | Repris : calcul natif en Rust (crates Craft par FFI), scripts sans `eval` (QuickJS, 64 Mo, 5 s)                                                     |
| Huginn       | MIT                         | Agents qui surveillent le web et réagissent                              | Repris : flux RSS/Atom (`Bun.XML`), extraction par sélecteurs (`HTMLRewriter`), « seulement les nouveaux » avec mémoire persistante                 |
| Temporal     | MIT                         | Exécution durable, reprises                                              | Partiel : file de jobs Postgres avec nouvel essai du worker, exécutions conservées (200 par workflow). Manque : reprise d'un workflow à mi-parcours |
| Kestra       | Apache-2.0                  | Workflows déclaratifs versionnés                                         | Repris : définitions JSON validées, 50 versions par workflow, restauration réversible (l'état remplacé devient une version)                         |

Sous-workflows (« Execute Workflow » de n8n) : repris par le nœud `auto.workflow`. Versions (Kestra, n8n) : reprises, 50 versions par
workflow et restauration réversible. Manque suivi : reprise d'une exécution interrompue.

## Services auto-hébergés de l'Aphrody Box

| Projet                       | Rôle                                       | Licence               |
| ---------------------------- | ------------------------------------------ | --------------------- |
| n8n                          | Éditeur de workflows, 400 intégrations     | fair-code             |
| Hermes Agent (Nous Research) | Agent avec mémoire, outils et messageries  | MIT                   |
| Ollama                       | Modèles d'IA locaux, API compatible OpenAI | MIT                   |
| Obsidian (image linuxserver) | Notes Markdown dans le navigateur          | propriétaire, gratuit |
| Mailpit                      | Courriels de test                          | MIT                   |
| Caddy                        | HTTPS automatique                          | Apache-2.0            |
| PostgreSQL                   | Base de données                            | PostgreSQL            |

Console de la boîte : Leptos (rendu serveur et hydratation WebAssembly) et axum, MIT.

## Runtime Bun OS (fork Aphrody de Bun)

API natives utilisées à la place de paquets npm : `Bun.serve` (API, front, console opérateur), `Bun.SQL`
(Postgres, y compris le dialecte Kysely de Better Auth), `Bun.Image` et `Bun.Video` (nœuds média, OCR),
`Bun.WebView` (nœud navigateur), `Bun.XML` (flux), `HTMLRewriter` (extraction), `Bun.cron` (planification),
`Bun.password` et `Bun.CryptoHasher` (secrets, signatures de webhooks), `Bun.Archive` (extension Chrome),
`Bun.Glob`. Outils : `bun check`, `bun lint`, `bun fmt`, `bun n2b`, `bun test`.

Paquets Aphrody : `@aphrody/bun-types`, `@aphrody/m3-react`, `@aphrody/m3-tokens`, `@aphrody/m3-tailwind`,
`@aphrody/material-web`, `@aphrody/bun-plugin-tailwind`.

## Crates Craft et Aphrody

Suite Aphrody vendorisée (`vendor/suite`), liée par FFI (`crates/auto-ffi`) :

- PDF : `pdfcraft-create`, `-organize`, `-render`, `-redact`, `-sign`, `-annot`, `-preflight` (fusion, pages, texte,
  caviardage, signature et vérification) ;
- Word et PowerPoint : `wordcraft-docx`, `wordcraft-pdf`, `deckcraft-pptx`, `deckcraft-pdf` ;
- Tableurs : `gridcraft-xlsx` (création, lecture xlsx, ods, csv) ;
- Base de connaissances : `aphrody-rag-core` (découpage, plus proches voisins, MMR).

# Pile technique d'auto

Choisie le 2026-10-23 d'après la documentation officielle (Context7) et les paquets Material 3 de Bun OS. Règles : les API natives de Bun passent avant tout paquet npm (`Bun.serve`, `Bun.sql`, `Bun.cron`, `Bun.Image`,
`Bun.Archive`, `Bun.WebView`) ; on assemble des bibliothèques maintenues et on n'écrit ni composants, ni routeur, ni client
HTTP maison. Hono, Express et consorts ne sont pas retenus : `Bun.serve` couvre le besoin.

## Décisions

| Couche                 | Choix                                                                                                                                                                                                      | Remplace                                                                 | Source (Context7)                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Primitives d'interface | Base UI (`@base-ui/react`) : Tabs, Accordion, Dialog, AlertDialog, Field, Fieldset, Select, Toast                                                                                                          | `packages/ui/src/react/composants.tsx` (Modale, champs, toasts, onglets) | `/websites/base-ui_react` (aucun style, états `data-*`)                 |
| Style                  | Tailwind v4 + preset `@aphrody/m3-tailwind` (rôles, formes, typographie, ressorts) via `@aphrody/bun-plugin-tailwind`                                                                                      | `base.css`, `site.css`, `accueil.css` écrits à la main                   | README `@aphrody/m3-tailwind`                                           |
| Widgets Material 3     | `@aphrody/m3-react` 3.3.x (wrappers React des `<md-*>`), seulement boutons, icônes, puces                                                                                                                  | boutons et badges maison                                                 | `@aphrody/material-web`                                                 |
| Routage                | TanStack Router, routes déclarées en code (aucun plugin de bundler requis)                                                                                                                                 | `routeur.tsx` maison                                                     | `/tanstack/router` (`createRootRoute`, `createRoute`)                   |
| État serveur           | TanStack Query (`queryOptions`, `useMutation`, `invalidateQueries`)                                                                                                                                        | hook `useDonnees`                                                        | `/tanstack/query`                                                       |
| Tableaux               | TanStack Table et Virtual par `@aphrody/m3-react/adapters/tanstack`                                                                                                                                        | `<table>` maison                                                         | `@aphrody/m3-react`                                                     |
| API HTTP               | `Bun.serve({ routes })` natif (déjà en place), validation et documentation par Zod 4                                                                                                                       | générateur OpenAPI écrit à la main (`openapi-outils.ts`)                 | `/colinhacks/zod` (`z.toJSONSchema(schema, { target: "openapi-3.0" })`) |
| Client de l'API        | `fetch` et types déduits des schémas Zod de l'API (aucun client écrit schéma par schéma)                                                                                                                   | `@auto/client` écrit à la main                                           | `/colinhacks/zod` (`z.infer`)                                           |
| Validation             | Zod 4, partagé par l'API, les formulaires et le client ; `Bun.CSRF`, `Bun.password`, `Bun.sql` pour le reste                                                                                               | contrôles dispersés                                                      | `/colinhacks/zod`                                                       |
| Authentification       | Better Auth 1.7.12 (organization, twoFactor, passkey, apiKey, bearer, admin, magicLink, openAPI, jwt, mcp, cimd) sur `Bun.sql` par un dialecte Kysely de 100 lignes (`packages/tenancy/src/kysely-bun.ts`) | couche comptes maison (`credential`, TOTP, invitations)                  | MCP `better-auth`, `/better-auth/better-auth`                           |
| Icônes                 | Police Material Symbols (autohébergée, `@fontsource/material-symbols-rounded`) et `<MdIcon>`                                                                                                               | `symboles.gen.ts`, planche SVG                                           | `@aphrody/material-web` (`icon`)                                        |

Adaptateur de base de Better Auth : ni Better Auth ni Kysely ne fournissent de pilote `Bun.SQL` (l'adaptateur
Kysely de Better Auth reconnaît `pg`, `postgres.js`, MySQL, SQLite, `bun:sqlite`, D1). Plutôt qu'ajouter `pg` et
un second pool, auto fournit le dialecte (adaptateur, compilateur et introspection Postgres de Kysely ;
`sql.unsafe` ; transactions sur `sql.reserve()`). `kysely` 0.29 est la seule dépendance ajoutée pour la base, déjà
requise par Better Auth. Voir [AUTH.md](AUTH.md).

## Ce qui reste, parce que c'est notre métier

Postgres par `Bun.sql` avec RLS forcée et `withTenant`, l'outbox transactionnelle, le worker et ses jobs, les crates
Rust (Factur-X, PDF, tableurs) par `bun:ffi`, le domaine (`@auto/domain`), la facturation Stripe. Ce sont des règles
d'entreprise et non des composants d'interface : aucune bibliothèque ne les remplace.

## Migration par étapes

1. Accueil public : React + Base UI + Tailwind M3 + `m3-react` (en cours).
2. Application web : Base UI + TanStack Router/Query à la place de `@auto/ui/react` ; suppression de `composants.tsx`,
   `routeur.tsx`, `base.css`.
3. API : les routes restent des `Bun.serve` natifs ; chaque module décrit ses entrées et sorties en Zod, l'OpenAPI et
   les types du client en sont déduits (les tests d'isolation et d'OpenAPI restent la référence).
4. Suppression des icônes maison (`symboles.*`) une fois tous les écrans migrés.

Chaque étape est livrée seule, avec ses tests de bout en bout verts.

## Fonctions natives du fork Bun OS, vérifiées sur ce poste (2026-10-23)

Binaire `bun` 1.4.6-canary.1 (169d8c5ea), Windows x64. Catalogue : `docs/runtime/fork-features.mdx` du dépôt Bun.

| Fonction                       | État        | Preuve et usage                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.WebView`                  | utilisable  | `navigate`, `evaluate`, `screenshot` répondent (capture de 16 Ko en 2,4 s). Candidat pour remplacer `playwright-core` dans `apps/web/scripts/vitrine.ts` puis dans les tests de bout en bout ; migration non commencée, les tests actuels utilisent l'API Playwright. |
| `@aphrody/bun-plugin-tailwind` | utilisé     | Compile Tailwind v4 et le preset M3 pour les pages HTML servies par `Bun.serve` (`bunfig.toml`, `[serve.static]`).                                                                                                                                                    |
| `bun rsync --native`           | écarté      | Exige un binaire `bun` du fork côté serveur (`--remote-bun`) : le serveur n'a que `bun` standard. Le déploiement garde `tar` par `ssh` (sources) et l'archive d'image.                                                                                                |
| `bun docker`                   | non utilisé | Client natif de Docker Engine (lecture, démarrage, arrêt). Les builds et déploiements passent par `docker` et `ay`.                                                                                                                                                   |

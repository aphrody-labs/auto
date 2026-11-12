# Interfaces

Trois interfaces sur la même API `/v1` : le front web (`apps/web`), la console opérateur (`apps/admin`) et la
coque de bureau (`apps/desktop`). Design system : `docs/design/DESIGN-SYSTEM.md` et `@auto/ui`.

## Front web (`apps/web`)

`Bun.serve` avec imports HTML (bundling natif de Bun, HMR en développement), React 19, sans Next ni Vite. Le
serveur ne fait que servir les pages et relayer `/v1/*`, `/health`, `/api/auth/*`, `/.well-known/*` et `/mcp` vers
l'API (`@auto/client/proxy`) : même origine pour le navigateur, donc le cookie de session Better Auth
`auto.session_token` (HttpOnly, Secure, SameSite=Lax), son contrôle d'origine et l'anti-CSRF de l'API fonctionnent
sans CORS. Toute mutation part en `application/json` ; l'authentification passe par `better-auth/react`
(`src/client/auth.ts`, voir [AUTH.md](AUTH.md)).

```sh
bun run --cwd apps/api dev            # API sur :3000 (Postgres requis)
AUTO_API_URL=http://localhost:3000 bun run --cwd apps/web dev   # front sur :3001
```

| Route                                  | Page                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                    | Accueil public                                                                                                                                       |
| `/tarifs`                              | Gratuit 0 €, Pro 14 € HT par mois (essai 30 jours), Business 39 € HT par mois                                                                        |
| `/mentions-legales`                    | Éditeur, données, cookie de session                                                                                                                  |
| `/app/inscription`                     | Onboarding en 3 étapes : compte, entreprise (SIREN prérempli), connexions à venir                                                                    |
| `/app/connexion`                       | Connexion (mot de passe puis 2FA, lien magique, passkey, Google ou Microsoft si configurés), retour vers la page demandée (chemins `/app` seulement) |
| `/app/invitation?id=`                  | Acceptation d'une invitation (aussi l'ancien lien `/invitation#jeton`)                                                                               |
| `/app/autorisation`                    | Consentement OAuth d'un client MCP : entreprise liée au jeton, accord ou refus                                                                       |
| `/app`                                 | Tableau de bord : CA HT du mois, impayés, retards, TVA collectée, à relancer                                                                         |
| `/app/devis`, `factures`, `avoirs`     | Listes filtrables par statut (« en retard » dérivé) et recherche                                                                                     |
| `/app/documents/nouveau`               | Éditeur : lignes, TVA, remises, totaux en direct ; `?depuis=<id>&vers=facture                                                                        | avoir` |
| `/app/documents/:id`                   | Fiche : émission, PDF, XML Factur-X, statut, paiements, relances, avoir                                                                              |
| `/app/clients`, `produits`             | Répertoire (préremplissage SIREN) et catalogue                                                                                                       |
| `/app/employes[/:id]`, `/app/absences` | Fiches, solde de congés, demandes et validation                                                                                                      |
| `/app/imports`, `/app/exports`         | Import guidé (aperçu, correspondance, bilan) ; journal des ventes, créances, FEC                                                                     |
| `/app/parametres`                      | Entreprise, sécurité (2FA, passkeys, mot de passe, sessions, applications), gabarit, membres et invitations, clés d'API, abonnement, audit           |

Pied de page public : contact@aphrody.com. Les montants de `/tarifs` sont vérifiés contre
`packages/billing/src/plans.ts` par `src/serveur.test.ts`.

### Règles d'interface (checklist appliquée)

Gestion de chantier : `/app/fournisseurs[/:id]`, `/app/chantiers[/:id]`, `/app/livraisons`, `/app/commandes` et `/app/recherche` réutilisent les composants,
jetons et thèmes de `@auto/ui`. Le dossier chantier rassemble les documents et le suivi analytique ; les factures
reçues se classent depuis `/app/achats`. Voir [CHANTIERS.md](CHANTIERS.md).

- Couleurs : uniquement les rôles M3 `--md-sys-color-*` et leurs alias `--auto-*` de `@auto/ui` ; thème sombre par
  `data-theme="sombre"` (bascule clair, sombre, système), `prefers-color-scheme` sinon.
- Icônes : Lucide (SVG, `aria-hidden`), aucun émoji ; un statut est toujours pictogramme et libellé.
- Focus visible (anneau 2 px), lien d'évitement, focus déplacé sur le titre à chaque page, modales natives
  (`<dialog>` : focus piégé, Échap, retour du focus).
- Chaque champ a un libellé visible ; requis marqué ; erreur sous le champ, liée par `aria-describedby` ;
  erreurs de l'API en résumé focalisé avec leurs détails.
- Cibles de 44 px au moins ; états vide, chargement (squelette `role="status"`) et erreur (« Réessayer ») sur
  chaque liste ; toasts `aria-live="polite"` sans vol de focus.
- `prefers-reduced-motion` : animations ramenées à 0 ms.
- Chiffres tabulaires sur montants, numéros et dates ; `Intl.NumberFormat("fr-FR")` et `Intl.DateTimeFormat`
  (`src/client/format.ts`, centimes entiers, dates `AAAA-MM-JJ` sans décalage de fuseau).
- Mobile : tableaux empilés en cartes sous 768 px, tiroir de navigation sous 1024 px, jamais de défilement
  horizontal de la page ; l'éditeur se met en page par requêtes de conteneur.
- Totaux calculés par `@auto/domain` (même règle que le Rust), jamais recalculés à la main ; les mentions
  manquantes (`verifier`) sont listées avant émission.

### Tests

```sh
bun test apps/web                       # formatage, client API, serveur et proxy, parcours navigateur
AUTO_CAPTURES=C:/temp/captures bun test apps/web/e2e
```

`e2e/parcours.test.ts` lance l'API réelle sur une base Postgres jetable, le front et Chrome headless (celui de
Playwright déjà installé, `AUTO_CHROME` pour un autre) : inscription en 3 étapes avec SIREN simulé, devis émis,
conversion en facture émise, PDF relu par le proxy, tableau de bord ; puis import CSV de clients, employé et
absence validée, gabarit, exports ; pages publiques. Captures en clair, sombre et mobile dans `AUTO_CAPTURES`
(par défaut le dossier temporaire). Sans Chrome, ces tests sont ignorés.

### Design system Material 3

Les jetons viennent des paquets npm publiés `@aphrody/m3-tokens` (rôles de couleur dérivés de la graine,
forme, élévation, mouvement, classes de fenêtre), `@aphrody/m3-tailwind` et `@aphrody/m3-react` (composants
Material génériques, page d'accueil). `@auto/ui` n'ajoute que ce qui est propre à auto : alias `--auto-*`,
couleurs personnalisées (succès, avertissement), statuts de documents et composants métier
(`packages/ui/src/react/composants.tsx`).

## Console opérateur (`apps/admin`)

```sh
AUTO_API_URL=http://localhost:3000 bun run --cwd apps/admin dev   # :3002
```

Une page : santé (`/health`), plans publiés et, connecté avec un compte opérateur, ses factures d'abonnement,
la liste des entreprises avec leur plan et leur état, la suspension et le rétablissement, les événements en
échec et l'intégrité de tous les journaux d'audit.

Routes opérateur (module `apps/api/src/modules/admin.ts`, réservées aux owner et admin du tenant
`AUTO_TENANT_OPERATEUR`), utilisées par la section « Entreprises » de la console :

| Route                                   | Usage                                                           |
| --------------------------------------- | --------------------------------------------------------------- |
| `GET /v1/admin/tenants`                 | entreprises, plan effectif, statut Stripe, consommation du mois |
| `GET /v1/admin/tenants/:id`             | fiche d'un tenant : membres, quotas, dernières émissions, audit |
| `POST /v1/admin/tenants/:id/suspension` | suspendre ou rétablir un tenant (motif, trace dans son audit)   |
| `GET /v1/admin/utilisateurs?email=`     | retrouver un compte et ses adhésions (support)                  |
| `GET /v1/membres`                       | lister les membres d'un tenant                                  |
| `GET /v1/jetons, DELETE /v1/jetons/:id` | lister et révoquer les clés d'API                               |
| `/api/auth/admin/*` (Better Auth)       | comptes de toutes les entreprises, bannissement, sessions       |
| `GET /v1/admin/stripe/evenements`       | webhooks Stripe reçus, rejoués ou en échec                      |
| `GET /v1/admin/evenements`              | file des événements métier et leurs échecs                      |
| `GET /v1/admin/audit`                   | vérification des chaînes d'audit de tous les tenants            |

L'opérateur est un owner ou admin du tenant opérateur. Les lectures de données métier passent par
`withTenant` (RLS) ; seules les tables de comptes, `stripe_evenement` et l'outbox (rôle `auto_worker`) sont
lues de façon transverse. Une entreprise suspendue ne s'authentifie plus, ses données restent intactes.

## Coque de bureau (`apps/desktop`)

Tauri 2 (`src-tauri/`, hors du workspace Cargo racine) : une fenêtre qui charge `/app` de l'instance désignée par
`AUTO_URL` (par défaut `https://auto.aphrody.com`, `http://localhost:3001` pour le front de dev). La coque n'embarque ni API ni données et n'accorde aucune
permission IPC au contenu (`capabilities/default.json`) ; la navigation reste sur l'origine de l'instance, les
autres liens (mailto, Stripe Checkout) s'ouvrent dans le navigateur du système.

```sh
cd apps/desktop
bun run test     # tests Rust de la coque (URL, origine)
bun run dev      # cargo tauri dev, front sur :3001 lancé à part
bun run build    # installeurs NSIS/MSI, DMG, AppImage, deb
bun run icones   # régénère src-tauri/icons depuis icone.svg
```

Outillage : `cargo tauri` (CLI Tauri) et, sous Windows, WebView2 (présent sur Windows 11). La compilation native
reste facultative pour les gates : `gates:rust` ne couvre que `crates/*`.

## Ressources libres

| Ressource                       | Usage                                                                           | Licence    | Intégration                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Material Symbols (Rounded, 400) | Toutes les icônes (application, admin, pages publiques)                         | Apache-2.0 | `packages/ui/scripts/symboles.ts` extrait les tracés des icônes utilisées vers `symboles.gen.ts` ; composants `@auto/ui/symboles` |
| pattern.css                     | Fonds à motifs : grille sur l'accueil, points sur la connexion et l'inscription | MIT        | `@import` dans `base.css`, classe `fond-motif` + `pattern-*`                                                                      |
| Inter, Plus Jakarta Sans        | Corps et titres                                                                 | OFL-1.1    | `@fontsource`, auto-hébergées                                                                                                     |
| Jetons Material 3               | Couleurs, rôles, contrastes                                                     | Apache-2.0 | `@aphrody/m3-tokens` → `@auto/ui`                                                                                                 |

Ajouter une icône : une ligne dans `ICONES` (nom dans le code → nom Material Symbols), puis
`bun run --cwd packages/ui symboles`.

## Application mobile (Android)

La coque Tauri d'`apps/desktop` sert aussi au mobile (`mobile_entry_point`, options de fenêtre réservées au bureau).

```sh
cd apps/desktop
ANDROID_HOME=… NDK_HOME=… cargo tauri android init --ci          # génère src-tauri/gen/android (ignoré par git)
ANDROID_HOME=… NDK_HOME=… bun msvc exec -- cargo tauri android build --debug --apk --target aarch64
```

Les scripts de build Rust tournent sur l'hôte Windows et exigent la bibliothèque d'exécution MSVC (`msvcrt.lib`).
En attendant, l'application web installable (manifeste, icônes) fait office d'application mobile.

État au 2026-10-23 : APK de débogage construit (`dist/mobile/android/auto-debug.apk`, arm64, `com.aphrody.auto`) et
lancé dans l'émulateur `bun_pixel_api37` (page de connexion de production affichée). Chaîne utilisée, sans MSVC :
Rust `stable-x86_64-pc-windows-gnu` (hôte), NDK Android 30, JDK 25, `as.exe` relais vers le clang du NDK placé à côté
de `dlltool` (le toolset GNU n'embarque pas d'assembleur), `JAVA_HOME` défini. Gradle accepte les licences du SDK.
Reste : signature de release et publication sur le Play Store (compte développeur).

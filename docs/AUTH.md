# Authentification (Better Auth 1.7)

Depuis le 2026-10-23, les comptes d'auto reposent sur [Better Auth](https://www.better-auth.com) 1.7.12. La
couche maison (sessions et jetons dans `credential`, TOTP écrit à la main, invitations par jeton haché) est
remplacée ; ses routes `/v1` restent, comme façades, pour l'API publique, la CLI, n8n et l'extension.

| Élément                   | Emplacement                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| Serveur Better Auth       | `packages/tenancy/src/auth.ts` (`creerAuth`)                                      |
| Dialecte Kysely `Bun.SQL` | `packages/tenancy/src/kysely-bun.ts`                                              |
| Rôles et droits           | `packages/tenancy/src/droits.ts` (partagé avec le front : `@auto/tenancy/droits`) |
| Façades et RLS            | `packages/tenancy/src/index.ts` (`authentifierRequete`, `authentifier`)           |
| Reprise de l'ancienne 2FA | `packages/tenancy/src/legacy.ts`                                                  |
| Routes HTTP, MCP distant  | `apps/api/src/modules/comptes.ts`                                                 |
| Client du front           | `apps/web/src/client/auth.ts` (`better-auth/react`)                               |
| Schéma                    | `packages/store/migrations/020_better_auth.sql`                                   |

## Versions

`better-auth`, `@better-auth/passkey`, `@better-auth/api-key`, `@better-auth/oauth-provider`, `@better-auth/mcp`,
`@better-auth/cimd` : 1.7.12 ; `kysely` 0.29.7 ; `jose` 6.2.13. Versions épinglées (pas de `^`) : une montée de
version se fait à la main, avec relance de `bunx auth@latest generate` et une nouvelle migration.

## Base de données

Better Auth parle à la base Postgres de l'application par le **même pool `Bun.SQL`** que le reste d'auto. Ni
Better Auth ni Kysely ne fournissent de pilote pour `Bun.SQL` (l'adaptateur Kysely reconnaît `pg`, `postgres.js`,
MySQL, SQLite, `bun:sqlite`, D1) : `kysely-bun.ts` en est un dialecte de 100 lignes (adaptateur, compilateur
et introspection Postgres de Kysely, requêtes par `sql.unsafe`, transactions sur une connexion réservée par
`sql.reserve()`). Aucune dépendance `pg` n'est ajoutée. Le `CamelCasePlugin` de Kysely convertit les champs
camelCase de Better Auth en colonnes snake_case, comme le reste du schéma.

Les tables historiques sont reprises par `modelName` et `fields` :

| Modèle Better Auth | Table        | Champs renommés                                                         |
| ------------------ | ------------ | ----------------------------------------------------------------------- |
| `user`             | `app_user`   | —                                                                       |
| `organization`     | `tenant`     | `name` → `nom` ; champs ajoutés : SIREN, SIRET, adresse, TVA, franchise |
| `member`           | `membership` | `organizationId` → `tenant_id`                                          |
| `invitation`       | `invitation` | `organizationId` → `tenant_id`, `inviterId` → `invite_par`              |

Nouvelles tables : `account` (mot de passe et comptes Google/Microsoft), `session`, `verification`,
`two_factor`, `passkey`, `apikey`, `jwks`, `oauth_client`, `oauth_resource`, `oauth_client_resource`,
`oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, `oauth_client_assertion`, `rate_limit`. Elles sont
hors RLS, comme l'étaient `membership` et `credential` : seule la couche comptes les lit, avec le propriétaire du
schéma ; les données métier restent sous RLS (`withTenant`, `app.tenant`).

Le schéma vient de `bunx auth@latest generate --config packages/tenancy/auth.cli.ts` sur une base à jour de la
migration 019, repris à la main dans `020_better_auth.sql` (types `uuid`, clés étrangères vers `tenant`, index
uniques). Better Auth ne migre jamais la base (`npx auth migrate` n'est pas utilisé) ; au démarrage, il vérifie
que le schéma contient ce qu'il écrit (`advanced.database.validateSchema`).

## Contrat avec la RLS

`authentifierRequete(sql, headers)` (et `authentifier(sql, jeton)`, contrat historique) renvoie
`{ userId, tenantId, role }` :

| Moyen                                       | Reconnu par                                   | Entreprise (`tenantId`)              |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| Cookie `auto.session_token` (navigateur)    | `auth.api.getSession`                         | entreprise active de la session      |
| `Authorization: Bearer <jeton de session>`  | plugin `bearer`                               | entreprise active de la session      |
| `Authorization: Bearer auto_…`, `x-api-key` | plugin `apiKey` (`verifyApiKey`)              | référence de la clé (`reference_id`) |
| `Authorization: Bearer <JWT OAuth>` (MCP)   | `jose`, clés du plugin `jwt`, audience `/mcp` | revendication `auto_tenant` du jeton |

Le rôle est relu dans `membership` à chaque requête ; une entreprise suspendue (`tenant.suspendu_at`) ou un
compte banni (plugin admin) n'obtient rien. Le résultat alimente `withTenant` puis la RLS, sans changement pour
les modules métier.

## Fonctions

| Fonction                       | Plugin                | Détails                                                                                                                                                       |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mot de passe                   | `emailAndPassword`    | 12 à 256 caractères ; hachage `Bun.password` (argon2id) par `password.hash/verify` : les anciens hachages sont acceptés tels quels. Réinitialisation par mail |
| Entreprises                    | `organization`        | Tenant = organisation ; entreprise active = tenant de la session (la plus ancienne adhésion à la création de session). Inscription avec SIRET contrôlé        |
| Rôles                          | `organization` (`ac`) | `owner`, `admin`, `comptable`, `lecture`, `rh` ; énoncés `auto` (lire, ecrire, membres, parametres, rh) et `apiKey`. Seul un owner nomme un owner             |
| Invitations                    | `organization`        | Mail avec `/app/invitation?id=…`, 7 jours, usage unique, révocables, une seule en cours par adresse ; audit `invitation.*`                                    |
| Double authentification        | `twoFactor`           | TOTP (6 chiffres, 30 s) et 10 codes de secours chiffrés ; appareil de confiance 30 jours ; 5 essais par défi                                                  |
| Clés d'accès                   | `passkey` (WebAuthn)  | `rpID` = hôte de `AUTO_URL_APP`                                                                                                                               |
| Lien magique                   | `magicLink`           | 10 minutes, usage unique, sans création de compte                                                                                                             |
| Clés d'API                     | `apiKey`              | Clés d'entreprise `auto_…` (référence = tenant, auteur dans `metadata.userId`), expiration facultative, révocables ; hash SHA-256 seul en base                |
| Jetons de session pour scripts | `bearer`              | En-tête `set-auth-token` des connexions                                                                                                                       |
| Console opérateur              | `admin`               | Rôle global `admin` = owner et admin du tenant `AUTO_TENANT_OPERATEUR` ; liste des comptes, bannissement, fermeture des sessions                              |
| Google, Microsoft              | `socialProviders`     | Déclarés seulement si leurs identifiants sont présents (désactivés par défaut)                                                                                |
| OAuth 2.1 des clients MCP      | `jwt`, `mcp`, `cimd`  | Voir plus bas                                                                                                                                                 |
| Documentation                  | `openAPI`             | Fusionnée dans `GET /v1/openapi.json` (chemins `/api/auth/*`, étiquette « Authentification ») et `docs/openapi.json`                                          |
| Limitation de débit            | `rateLimit`           | Active en production, stockée en base : 120 requêtes/min par IP, 5/min pour la connexion et l'inscription, 3/min pour le lien magique et la réinitialisation  |
| Cookies                        | `advanced`            | Préfixe `auto`, `HttpOnly`, `SameSite=Lax`, `Secure` et préfixe `__Secure-` en HTTPS ; pas de cache de session en cookie (révocation immédiate)               |

## Routes

Better Auth est monté dans `Bun.serve` de l'API sur `/api/auth/*` (`auth.handler`) et `/.well-known/*`
(métadonnées OAuth). Le serveur du front et la console opérateur relaient `/api/auth/*`, `/.well-known/*` et
`/mcp` vers l'API (même origine pour le navigateur).

Façades `/v1` (même contrat qu'avant, implémentées sur `auth.api`) : `POST /v1/auth/inscription` (compte,
entreprise par SIRET), `POST /v1/auth/connexion` (session ou défi 2FA), `POST /v1/auth/2fa`,
`POST /v1/auth/deconnexion`, `GET /v1/auth/methodes`, `GET /v1/moi` (avec `entreprises`, `deuxFacteurs`),
`POST /v1/entreprises`, `GET|POST /v1/jetons`, `DELETE /v1/jetons/{id}`, `GET|POST /v1/membres`,
`DELETE /v1/membres/{id}`, `GET|POST /v1/invitations`, `DELETE /v1/invitations/{id}`,
`POST /v1/invitations/acceptation`, `POST /v1/2fa/enrolement|confirmation|codes-secours|desactivation`.

Changements de contrat : l'enrôlement 2FA et la régénération des codes demandent le mot de passe ; les codes de
secours sont remis à l'enrôlement ; l'identifiant d'une clé d'API est un UUID ; le cookie s'appelle
`auto.session_token` (`__Secure-auto.session_token` en HTTPS) et sa valeur est signée.

## Flux

- **Inscription** : `POST /v1/auth/inscription` → `signUpEmail` puis `createOrganization` (owner) ; la session
  est créée sur la nouvelle entreprise. Un compte ouvert par lien magique ou Google sans entreprise passe par
  `POST /v1/entreprises` (écran d'inscription, étape entreprise).
- **Connexion** (front) : `authClient.signIn.email` ; avec la 2FA, `twoFactorRedirect` puis
  `twoFactor.verifyTotp` ou `verifyBackupCode`. Lien magique : `signIn.magicLink`. Passkey : `signIn.passkey`.
- **Choix d'entreprise** : sélecteur de la navigation → `organization.setActive`.
- **Invitation** : `organization.inviteMember` (Paramètres, Membres) ; le destinataire ouvre le lien : connecté
  avec la bonne adresse, `acceptInvitation` ; sinon mot de passe du compte existant ou à créer
  (`POST /v1/invitations/acceptation`), puis connexion normale.
- **Sécurité du compte** (Paramètres, Sécurité) : 2FA, passkeys, mot de passe (ferme les autres sessions),
  sessions actives, applications OAuth autorisées.

## Serveur MCP distant

`POST /mcp` expose les outils de `packages/agent` (les mêmes que `auto mcp` en stdio), en JSON-RPC sur HTTP
(une requête, une réponse JSON ; notification → 202). Il est protégé par `requireMcpAuth` de `@better-auth/mcp` :
signature (clés `jwks` du plugin `jwt`), émetteur (`<origine>/api/auth`), audience (`<origine>/mcp`) et
expiration du jeton d'accès. Sans jeton : 401 avec `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728).

Découverte et autorisation (MCP 2025-06 et 2026-07-28) :

1. `GET /.well-known/oauth-protected-resource/mcp` → serveur d'autorisation `<origine>/api/auth`.
2. `GET /.well-known/oauth-authorization-server/api/auth` (RFC 8414).
3. Inscription du client : document CIMD (`client_id` = URL HTTPS, plugin `cimd`, profil `mcp-2026-07-28`) ou
   inscription dynamique RFC 7591 (`/api/auth/oauth2/register`, clients publics, PKCE obligatoire).
4. `GET /api/auth/oauth2/authorize` (PKCE S256, `resource=<origine>/mcp`) → connexion (`/app/connexion`) si besoin
   → consentement `/app/autorisation` : choix de l'entreprise, accord → code.
5. `POST /api/auth/oauth2/token` → jeton d'accès JWT (1 h) lié à l'entreprise active au consentement
   (`auto_tenant`, `consentReferenceId`), jeton de rafraîchissement (`offline_access`).

Les outils appellent l'API `/v1` en boucle locale avec ce même jeton : droits du rôle, RLS et quotas sont ceux
du REST. Révocation : Paramètres, Sécurité, Applications autorisées (supprime le consentement).

Claude Code : le plugin `apps/plugin` déclare `{"type": "http", "url": "https://auto.aphrody.com/mcp"}` ; à la
main : `claude mcp add --transport http auto https://auto.aphrody.com/mcp`, puis `/mcp` pour s'authentifier.
Claude Desktop et les autres clients : connecteur personnalisé sur la même URL. Sans navigateur (CI) : serveur
stdio `auto mcp` avec `AUTO_TOKEN` (clé d'API).

## Variables d'environnement

| Variable                                                                               | Rôle                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AUTO_URL_APP` (ou `BETTER_AUTH_URL`)                                                  | Origine publique : cookies, liens des mails, émetteur OAuth, ressource MCP, `rpID` des passkeys      |
| `BETTER_AUTH_SECRET`                                                                   | Facultatif : par défaut dérivé de `AUTO_CLE_MAITRE` (HMAC-SHA256), un seul secret à garder au coffre |
| `AUTO_CLE_MAITRE`                                                                      | Clé maître (obligatoire en production) ; aussi requise pour reprendre les anciens secrets TOTP       |
| `AUTO_ORIGINES_CONFIANCE`                                                              | Origines supplémentaires, séparées par des virgules (console opérateur sur un autre hôte)            |
| `AUTO_TENANT_OPERATEUR`                                                                | Tenant opérateur : ses owner et admin reçoivent le rôle global `admin`                               |
| `AUTO_GOOGLE_CLIENT_ID`, `AUTO_GOOGLE_CLIENT_SECRET`                                   | Connexion Google (redirection : `<origine>/api/auth/callback/google`)                                |
| `AUTO_MICROSOFT_CLIENT_ID`, `AUTO_MICROSOFT_CLIENT_SECRET`, `AUTO_MICROSOFT_TENANT_ID` | Connexion Microsoft (`common` par défaut ; redirection `<origine>/api/auth/callback/microsoft`)      |
| `AUTO_SMTP_*`, `AUTO_MAIL_EXPEDITEUR`                                                  | Envoi des invitations, liens magiques et réinitialisations (voir `MAIL.md`)                          |

## Migration des données

Appliquée par `020_better_auth.sql` (au démarrage de l'API, comme les autres migrations) puis, en TypeScript,
par `migrerDeuxFacteurs` (au démarrage, idempotente ; aussi `bun scripts/migrer-auth.ts`) :

| Donnée               | Reprise                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comptes              | `app_user` conservé (même `id`) ; `name` = partie locale de l'adresse ; `password_hash` → `account` (`credential`), puis colonne supprimée                                                                                                                                                                                        |
| Entreprises          | `tenant` conservé ; `slug` = `<siren>-<8 premiers caractères de l'id>`                                                                                                                                                                                                                                                            |
| Adhésions            | `membership` conservé ; `id` et `created_at` ajoutés ; rôle `rh` permis                                                                                                                                                                                                                                                           |
| Mots de passe        | Hachages `Bun.password` (argon2id) acceptés par `password.verify` ; aucune réinitialisation                                                                                                                                                                                                                                       |
| Sessions             | Non reprises : reconnexion forcée (une fois)                                                                                                                                                                                                                                                                                      |
| Jetons API `auto_…`  | → `apikey` : même SHA-256, converti de l'hexadécimal au base64url (format de Better Auth) ; les jetons existants continuent de fonctionner                                                                                                                                                                                        |
| Invitations en cours | Statut `pending` ; leur ancien lien `/invitation#<jeton>` reste accepté (hash conservé)                                                                                                                                                                                                                                           |
| 2FA                  | Secret TOTP déchiffré par la clé maître puis stocké chiffré par Better Auth sous la forme `legacy:<base32>` ; un crochet vérifie les codes sur l'ancien secret : les applications d'authentification déjà enrôlées continuent de servir. Codes de secours non utilisés : repris par sentinelle (`legacy-<hash>`), chacun une fois |

Après une période de recouvrement, une migration ultérieure pourra supprimer `app_user.totp_*`, `code_secours`
et `invitation.token_hash`.

## Tests

`packages/tenancy/src/comptes.test.ts` (inscription, clés d'API, invitations, 2FA, reprise de l'ancienne 2FA et
des anciens jetons), `apps/api/src/auth.test.ts` (routes Better Auth, limitation de débit, flux OAuth MCP de bout
en bout avec un client de test, isolation de deux entreprises en REST et en MCP, plugin admin),
`apps/web/e2e/auth.test.ts` (Chrome : connexion 2FA, sécurité, invitation, consentement OAuth).

## Restriction réseau de l’administration humaine

`AUTO_ADMIN_IPS` contient une liste d’adresses IPv4/IPv6 exactes, séparées par des virgules. La restriction s’ajoute à la session du super-administrateur (compte vérifié et rôle autorisé) ainsi qu’à la console opérateur historique. Elle n’attribue jamais une identité ou un rôle. Les agents administratifs conservent leurs clés nominatives et leur journal propre.

En production derrière l’unique Cloudflare Tunnel, déclarer également `AUTO_ADMIN_IP_SOURCE=cloudflare-tunnel`. L’API et le web ne doivent publier aucun port direct : l’adresse contrôlée est `CF-Connecting-IP` fournie par ce chemin de confiance. `X-Forwarded-For` n’accorde aucun accès. Une configuration d’adresse invalide, une source non déclarée ou une adresse absente entraîne un refus.

Cette confiance est liée à la topologie du déploiement, pas au seul nom de l’en-tête. La [documentation Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip) décrit ce contrat et les différences pour les sous-requêtes Workers. Requalifier la confiance avant d’ajouter un Worker de même zone ou un nouveau proxy.

Avant activation : livrer le code sans `AUTO_ADMIN_IPS`, ouvrir `/v1/admin/moi` avec le compte propriétaire dans son navigateur et vérifier `reseau.adresse`. Comparer une requête normale et une requête avec en-tête CF forgé ; l’adresse observée à l’origine doit rester celle du client réel. Conserver l’environnement précédent en fichier privé. L’absence de `AUTO_ADMIN_IPS` désactive la restriction, sans modifier les droits de la session.

Retour arrière : par SSH opérateur, retirer `AUTO_ADMIN_IPS` de l’environnement protégé et recréer l’API via le pipeline habituel. Ce chemin et les accès agents nominatifs restent indépendants de la restriction humaine. Aucun changement de filtre n’est nécessaire pour les routes OAuth ou la boîte mail privée. Une adresse publique dynamique devra être réévaluée lorsqu’elle change.

La connexion depuis la session Windows du poste et la configuration des dossiers locaux sont décrites dans [WINDOWS-LOCAL.md](WINDOWS-LOCAL.md).

## Employés, sessions et reconnexion automatique

Dans **Paramètres → Membres**, le propriétaire ou administrateur invite les employés dans son entreprise existante, avec leur rôle. L’acceptation crée ou rattache leur compte personnel à cette même organisation ; aucune entreprise supplémentaire n’est créée. Chaque employé utilise ses propres identifiants, sessions, éventuelle 2FA et clés d’accès. Les autorisations par espace restent appliquées côté serveur à chaque requête. Une invitation ouverte avec un autre compte propose de changer de compte en conservant le lien.

La connexion par mot de passe propose **Rester connecté sur cet appareil**, activé par défaut. Better Auth gère les cookies HttpOnly persistants et signés : durée de 30 jours, renouvellement après une journée d’activité. Décocher ce choix utilise une session non persistante. Une session valide ouvre directement la destination interne demandée depuis `/app/connexion` ; le retour d’une fenêtre en premier plan revalide le compte et ses droits.

Les appels serveur qui résolvent une identité utilisent `disableRefresh: true`, car ils ne peuvent pas transmettre le nouveau cookie au navigateur. Le front appelle d’abord le endpoint public officiel `get-session`, qui renouvelle ensemble la base et le cookie. Les expirations ne sont donc pas repoussées silencieusement dans la seule base.

Dans **Paramètres → Sécurité → Sessions actives**, chaque personne voit ses appareils, l’expiration et la session courante. Elle peut fermer une session ou ses autres sessions ; les sessions des collègues restent ouvertes. Les erreurs de fermeture sont affichées. La révocation est effective à la requête suivante, sans cache de session en cookie.

Le test `apps/web/e2e/equipe-sessions.test.ts` vérifie deux employés dans une seule entreprise, leurs rôles distincts, le refus d’écriture d’un lecteur, les sessions séparées, une reprise depuis des cookies persistants, le renouvellement effectif du cookie, une session temporaire et une révocation isolée. Les parcours de connexion navigateur Windows/Android restent décrits dans [APPAREILS.md](APPAREILS.md).

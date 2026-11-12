# Qualification des intégrations de production

## État vérifié les 24 et 25 octobre 2026

### Google

Le projet `aphrody` est publié : statut **In production**, type External. Le client Web `Auto — production`
utilise `https://auto.aphrody.com/api/auth/callback/google` et les seuls scopes `email profile openid`.
Connexion réelle vérifiée depuis Chrome jusqu'à la création de l'entreprise. Google signale encore une
vérification du projet partagé ; la publication ne constitue pas une validation de marque ou des scopes
sensibles éventuellement utilisés par ses autres clients.

Les secrets `AUTO_GOOGLE_CLIENT_ID` et `AUTO_GOOGLE_CLIENT_SECRET` sont dans Secret Manager, projet
`aphrody`, et dans l'environnement de production. L'accès opérateur Google passe par
`aphrody-bot@aphrody.iam.gserviceaccount.com`.

### Mail réel

La boîte **auto@aphrody.com** est créée et active (15 Gio), dédiée aux notifications Auto. Elle utilise
le slot Starter existant `f588f4df-9fd8-4197-a4f1-5e495d7d1b95`, inclus et lié à **rpbey.fr**. Ne pas supprimer
cette licence lors d'un nettoyage de ce domaine : elle porte maintenant le relais Auto. Sa date de
renouvellement affichée est le 1er novembre 2026, avec renouvellement automatique déjà actif. Aucune
nouvelle commande payante ni modification du renouvellement n'a été effectuée.

La boîte préexistante `contact@aphrody.com` et son mot de passe sont conservés. Plateforme Zimbra :
`c5e259b7-f723-4175-9ec5-be3904e3bd37` ; compte Auto : `4f5a9621-1ed4-4c5c-8f64-6993cb492c38`.

Configuration du relais : `smtp.mail.ovh.net:465`, TLS, utilisateur `auto@aphrody.com`, expéditeur
`Auto <auto@aphrody.com>`. IMAP : `imap.mail.ovh.net:993`, TLS, mêmes identifiants. Le secret dédié est
stocké dans Secret Manager sous `AUTO_SMTP_MOT_DE_PASSE` (version 1), injecté dans `~/auto/prod.env` et
la copie de reprise opérateur `~/.auto/prod-vps.env`. Aucun secret n'est inscrit dans le dépôt.

Résultats réels :

- SMTP → IMAP avec texte et pièce jointe intacts : réussi depuis Windows, puis depuis l'image candidate
  sur le VPS, puis depuis le conteneur `auto-api` de production. Dernier Message-ID :
  `<01a16fd3-7b7a-74ab-bcd0-a58e6a2d60d5@aphrody.com>`, UID 259, réception en environ 3 secondes.
- `POST /api/auth/sign-in/magic-link` : réponse positive et mail reçu dans la boîte de réception Gmail de
  l'opérateur. Gmail confirme **SPF=pass, DKIM=pass, DMARC=pass** ; sélecteur DKIM `ovhmo-selector-1`.
  Message-ID : `<01a16fd3-237d-734a-88b4-954d5a3cfec2@aphrody.com>`.
- `/health` et `/v1/auth/methodes` : réponses valides, Google disponible ; API et web Docker healthy.

### Microsoft

Application `Auto — production`, client `48a26fb9-d0b9-41b4-9012-640633eb4aa7`, créée dans le tenant
existant `b390ca9e-1540-4f95-9bd4-36387bcce4c5`. Comptes professionnels multi-tenant et comptes Microsoft
personnels ; callback Web exact `https://auto.aphrody.com/api/auth/callback/microsoft`.
`AUTO_MICROSOFT_TENANT_ID=common`. Secret valable jusqu'au **24 octobre 2027**, stocké dans Secret Manager
(`AUTO_MICROSOFT_CLIENT_ID`, `AUTO_MICROSOFT_CLIENT_SECRET`, versions 1) et dans les environnements protégés
VPS/reprise. Prévoir sa rotation avant cette date.

Connexion réelle du compte opérateur réussie jusqu'à l'étape « Votre entreprise ». Scopes demandés par
Better Auth : `openid profile email User.Read offline_access` ; aucun accès aux boîtes mail. Les liens
d'accueil et de confidentialité sont renseignés dans Entra. L'éditeur reste **non vérifié** : aucune
vérification Microsoft Partner Center/MPN n'a été effectuée. Certaines politiques d'entreprises clientes
peuvent exiger leur administrateur ou un éditeur vérifié ; le test opérateur ne prouve pas leur acceptation.

### Stripe réel, en mode test

Organisation Stripe **Aphrody** créée le 25 octobre 2026, après acceptation explicite des conditions
Stripe Organizations : `org_6Vdb3aHTDP7piYokO97fPei`. Le nouveau compte **Aphrody**, France,
`acct_1UUDExJjg4RzOszD`, est créé. La configuration active n'utilise plus le compte historique.
L'environnement de test Aphrody dédié est `acct_1UUDFkQpL4EotU2M` ; ses clés, quatre prix et webhook
sont maintenant configurés sur le VPS. Stripe refuse l'autorisation CLI du compte live avant
vérification de l'entreprise. Aucun accès administrateur live ni encaissement live n'est qualifié.

Stripe CLI 1.55.1 est installé sur Windows et le VPS ; le plugin officiel Codex est installé et activé.
Le serveur dispose d'une clé de sandbox existante à **accès complet**, fichier 0600 dans
`~/auto/credentials/stripe-aphrody-admin-test.env`, utilisée par `~/auto/outils/stripe-aphrody`.
L'appel CLI `/v1/account` confirme le compte de sandbox Aphrody. Le plugin MCP nécessite encore
sa connexion OAuth dans Codex ; son installation seule ne vaut pas authentification.

Nouvelle recette Aphrody du 25 octobre : Checkout `cs_test_a1pAdO21z4F0k60OA5CZ0k5SooJJvbwCSwz008MhwWzHcaH9eDmV2EpTwl`
confirmé `complete/paid`, 4680 centimes, `livemode=false` ; abonnement
`sub_1UUDKGQpL4EotU2MOU5hlIq9` actif et plan Business confirmé par l'API Auto.
Trois webhooks fournisseur reçus en HTTP 200. Facture `in_1UUDKEQpL4EotU2MtifJCLNh`, événement
`evt_1UUDKHQpL4EotU2MpU4kI8Rw` : signature absente refusée et deux rejeux ignorés.
La résiliation de cet abonnement de test est programmée à l'échéance. Aucun débit réel.

Une recette isolée est disponible sur `https://recette-auto.aphrody.com` : réseau Docker `auto-recette`,
Postgres distinct `auto-pg-recette`/volume `auto_pg_recette`, API et web distincts, aucun port hôte publié.
Elle ne copie pas les données, secrets Google/Microsoft, clés S3 ni la clé maître de production.
Le relais SMTP est partagé ; les comptes de recette utilisent le domaine réservé `example.test`.

Le script `scripts/stripe-provisionner.ts` crée ou retrouve les deux produits, quatre prix, TVA française
20 % exclusive, configuration du portail et webhook. Il reprend un fichier de sortie existant sans recréer
les prix ni le webhook. Clé de test exigée par défaut ; `--production` exige une clé live et un compte
autorisé à encaisser. Configurations/secrets hors dépôt sous `~/.auto/stripe-*-recette.env` et
`vps:~/auto/recette/*.env`. API et webhook épinglés à `2026-09-30.endive`.

Preuves de la recette antérieure (historique ; les identifiants ci-dessous ne sont plus la configuration active) :

- Checkout Business mensuel : **39 € HT + 7,80 € TVA = 46,80 €**, carte de test Stripe `4242`, aucun débit réel.
- Événements reçus directement de Stripe via Cloudflare : `invoice.paid`, `customer.subscription.created`,
  `checkout.session.completed`, tous traités avec réponse 200. Abonnement `active`, plan effectif Business.
- Facture Stripe `in_1UUCo1JQ54N1JC88OyEc6Sgf` ; une seule facture opérateur Factur-X créée
  (`e9c7146c-5d99-440d-8790-ba202f7f2063`).
- Signature absente refusée (400) ; événement réel `evt_1UUCo4JQ54N1JC88kyYclFrD` rejoué deux fois avec
  signature de recette : `rejeu`, aucune nouvelle facture.
- Portail client réel ouvert, facture payée et carte de test affichées ; lien de retour confirmé vers
  `/app/parametres`. Les anciens retours erronés `/parametres/abonnement` sont corrigés dans l'API déployée.
- Résiliation de test programmée au 24 novembre depuis le portail. L'événement réel reçu utilise
  `cancel_at` avec `cancel_at_period_end=false` (mode flexible). Le traitement corrigé conserve le plan
  actif et expose désormais `annulationFinPeriode=true` avec la bonne date. Réactivation couverte par
  le test d'intégration. Aucun abonnement live n'a été créé ou résilié.

### PA : limites identifiées avant activation

B2Brouter est accessible via le compte Google existant. Les conditions ont été acceptées avec autorisation
explicite. Le fournisseur demande désormais de créer l'entreprise (raison sociale et SIREN) avant d'accéder
au groupe d'intégration. Aucun SIREN d'Aphrody vérifié ni identifiant API de ce compte n'a été retrouvé ;
aucune identité juridique fictive ni mandat réel n'a été enregistré.

L'adaptateur a été corrigé d'après les guides B2Brouter actuels : Factur-X envoyé en `application/pdf`,
états `sent → déposée`, `registered → reçue`, `read → prise en charge`. Les URL de polling sont limitées
à l'origine de l'API et les redirections sont refusées pour ne pas transmettre la clé à un tiers.
Le XML d'e-reporting simplifié n'est pas un Flux 10 v3.2 valide : son envoi réel est désormais refusé
explicitement (503), au lieu d'envoyer une déclaration non qualifiée. Il reste à implémenter et qualifier
le format officiel ou la chaîne de génération native du fournisseur.

### Déploiement et reprise

Image déployée sur API, worker et web : `auto-app:integrations-20261025`, digest
`sha256:7fdf04806117d8e91e84b6f4c29d24fcf1c2b5525d129bd3caa06ef929bf9eb9`.
Cette image étend `auto-app:auth-mail-20261024` avec les corrections des retours Stripe et de l'adaptateur PA.
Le patch contient seulement les changements d'intégrations et les scripts de diagnostic. Les autres travaux
locaux du dépôt ne sont pas inclus. Les anciens conteneurs sont conservés arrêtés sous
`auto-api-before-smtp`, `auto-worker-before-smtp`, `auto-web-before-smtp` ; l'environnement précédent est
`~/auto/prod.env.before-smtp`. Le patch source et son Dockerfile sont sous `~/auto/auth-mail-patch`.
Le dernier retour arrière applicatif est `auto-{api,worker,web}-before-flexible` (image du 24 octobre) ; l'environnement
avant Microsoft est `~/auto/prod.env.before-microsoft`. Sources, Dockerfile et déploiement avec contrôle
de santé et retour arrière automatique sous `~/auto/integrations-patch`.

Le durcissement SMTP (TLS, validation, arrêt si relais absent), la liaison explicite Google/Microsoft et
la gestion des comptes liés dans Paramètres → Sécurité sont déployés avec cette image.

### VPS et Cloudflare

Les DNS proxifiés `auto.aphrody.com` et `recette-auto.aphrody.com` pointent vers le tunnel `auto`, sain avec quatre connexions. Son
origine est `http://auto-web:3001`, puis le proxy web dessert l'API privée sur `auto-api:3000`.
TLS Cloudflare est en mode strict. Aucun port Docker n'est publié sur l'hôte ; les cinq conteneurs
web, API, worker, tunnel et Postgres partagent `auto-prod` et redémarrent avec `unless-stopped`.

La règle Cloudflare `auto-private-no-cache` (`ff1d3a792e354eb796196d598cd3b66e`) désactive explicitement
le cache sur les deux hôtes pour `/v1/`, `/api/auth/`, `/app`, `/mcp`, `/devis`, `/facture`, `/health` et les requêtes portant
le cookie de session Auto. La règle existante du CDN est conservée. Les sondes publiques après application
répondent 200 avec `CF-Cache-Status: DYNAMIC` ; la session anonyme vaut `null` avec `Cache-Control: no-store`.

Sauvegarde chiffrée et copie hors site sur `dbfr` vérifiées le 24 octobre. La restauration du dump
quotidien dans une base jetable a retrouvé 55 tables ; la base de recette est ensuite supprimée.
Le script installé `~/auto/sauvegarde.sh` est versionné dans `scripts/vps-sauvegarde.sh` : il charge les
secrets avec Bun `--env-file` plutôt que `source`, afin de respecter le format du fichier Docker.
La sauvegarde manuelle après correction a réussi et la copie hors site contient sept fichiers.

### Accès OVH et limite du compte de service

L'ancien outil `aphrody-infra ovh` (retiré, sans équivalent `ay`) faisait l'audit MX/SPF/DMARC/DKIM avec `--profile aphrody.com`.
Le compte de service du profil et celui du coffre DPAPI s'authentifient sur `eu8427-ovh`, mais la liste
Zimbra renvoie `[]` et la lecture de la plateforme connue reçoit 404. Le catalogue IAM ne liste aucun
type Zimbra ; la clé applicative historique reçoit 403. Une liste vide ne permet donc pas de conclure
qu'une boîte est absente. Le gestionnaire propriétaire connecté dans Chrome a permis de retrouver la
plateforme et de créer la boîte dédiée. Aucun élargissement IAM n'a été effectué.

### Validation et reste du périmètre

16 tests d'intégration API/comptes/mail et 3 tests navigateur avaient réussi ; les tests ciblés du relais,
des fournisseurs OAuth et de la recette SMTP/IMAP passent. Après les corrections Stripe/PA : 13 tests
ciblés passent (204 assertions), les huit tests navigateur paiement/parcours passent, et le contrôle
TypeScript passe sur 279 fichiers. Microsoft est configuré et sa connexion opérateur est validée.

Le diagnostic ne remplace pas une recette de bout en bout. Exécuter sur l'hôte qui possède les variables
d'environnement : `bun scripts/diagnostic.ts`, puis `bun scripts/diagnostic.ts --reseau` pour tester réellement
Postgres et l'authentification SMTP. Aucun mail n'est envoyé et aucune donnée n'est modifiée. Le rapport ne
contient ni secrets ni chaînes de connexion ; le code de sortie vaut 1 si un contrôle échoue. Les contrôles
Google et Microsoft valident la configuration, pas le consentement auprès du fournisseur.

## Authentification Google et Microsoft

La stack existante reste Better Auth 1.7.12 sur Postgres, sessions révocables, organisations, droits, passkeys,
2FA et OAuth MCP. Aucun second système d'identité n'est nécessaire.

Créer un client OAuth Web dans Google Cloud, configurer l'écran de consentement et enregistrer exactement
`https://auto.aphrody.com/api/auth/callback/google`. Fournir `AUTO_GOOGLE_CLIENT_ID` et
`AUTO_GOOGLE_CLIENT_SECRET` au service API. Google demande maintenant le choix du compte à la connexion.

Créer une inscription d'application Microsoft Entra avec une redirection de type Web vers
`https://auto.aphrody.com/api/auth/callback/microsoft`. Choisir les comptes autorisés dans Entra et renseigner
`AUTO_MICROSOFT_CLIENT_ID`, `AUTO_MICROSOFT_CLIENT_SECRET` (la valeur du secret, pas son identifiant).
`AUTO_MICROSOFT_TENANT_ID=common` autorise le mode multi-tenant ; employer l'identifiant du tenant pour une
organisation unique. Configurer le renouvellement du secret avant son expiration.

Les callbacks doivent correspondre à l'origine de `BETTER_AUTH_URL` ou `AUTO_URL_APP`. Une paire
client ID/secret partielle bloque désormais l'initialisation. Sans les deux valeurs, le fournisseur reste
désactivé. Le navigateur obtient les méthodes disponibles par `GET /v1/auth/methodes`.

La fusion automatique de deux comptes par leur seule adresse est désactivée. Un utilisateur existant doit
d'abord se connecter avec sa méthode habituelle, puis lier explicitement son compte via l'API Better Auth
`linkSocial`, depuis Paramètres → Sécurité → Comptes Google et Microsoft. Cet écran permet l'association
et la dissociation et conserve au moins une méthode de connexion. Tester les nouveaux comptes,
les comptes existants, le refus de consentement et le retour vers l'application avant activation publique.

Documentation consultée avec Context7 :
[Google](https://www.better-auth.com/docs/authentication/google),
[Microsoft](https://www.better-auth.com/docs/authentication/microsoft),
[liaison des comptes](https://www.better-auth.com/docs/concepts/users-accounts).

## Mail

Le relais réel utilise `AUTO_SMTP_HOTE`, `AUTO_SMTP_PORT`, `AUTO_SMTP_SECURITE=tls|starttls`,
`AUTO_SMTP_UTILISATEUR`, `AUTO_SMTP_MOT_DE_PASSE`, `AUTO_SMTP_EXPEDITEUR`. OVH MX Plan reste le préréglage.
Les ports hors 1–65535 sont refusés. En production, le mode sans TLS et l'absence de relais empêchent le
démarrage de l'API. Une erreur de configuration ne déclenche plus un faux envoi dans les journaux.
Les journaux de développement ne contiennent plus les liens magiques ni les jetons de réinitialisation.

Le mode `--reseau` vérifie le dialogue SMTP, TLS et l'authentification. La réception externe et les résultats
SPF/DKIM/DMARC sont validés sur Gmail ; le traitement automatique des rebonds reste à compléter. La connexion OAuth à auto ne
donne pas accès à Gmail ou Outlook : les boîtes métier utilisent actuellement IMAP/SMTP et leurs identifiants.
L'accès délégué Gmail API / Microsoft Graph avec renouvellement des jetons est un chantier distinct.

## Ce qui reste avant de déclarer le produit fini

- Vérifier l'éditeur Microsoft pour les entreprises qui l'exigent ; Google et Microsoft sont testés avec un compte réel.
- Exécuter la recette navigateur des associations et dissociations de comptes, y compris les erreurs et annulations.
- Compléter le traitement des rebonds et étendre la recette de délivrabilité à d'autres opérateurs ; SMTP,
  réception IMAP et livraison Gmail sont déjà validés sur le domaine réel.
- Vérifier le nouveau compte Stripe Aphrody et qualifier le mode live ; Checkout et webhooks Aphrody sont validés en sandbox.
- Renseigner l'identité juridique Aphrody chez B2Brouter, obtenir ses accès API, puis qualifier sandbox/production et Flux 10.
- Exécuter les tests d'intégration sur Postgres et les services natifs, puis la recette des parcours métier.
- Compléter l'observabilité et la recette de reprise des jobs ; sauvegarde/restauration déjà vérifiée sur le VPS.

Les intégrations existantes sont documentées dans `AUTH.md`, `MAIL.md`, `PA.md`, `ARCHITECTURE.md` et
`DEPLOIEMENT.md`. Aucun déploiement ni création d'identifiants fournisseur n'est effectué par le diagnostic.

## Recette mail prête à exécuter

`bun scripts/test-mail.ts` utilise le SMTP et l'IMAP réels configurés. Il exige un relais authentifié en TLS,
envoie un seul message à l'adresse d'expédition elle-même, puis vérifie le Message-ID, le texte et une pièce
jointe par IMAP. Il ne lit que les messages arrivés depuis le début du test, ne les marque pas lus et ne les
supprime pas. Un envoi SMTP accepté sans réception confirmée reste un échec, après 45 secondes.

Les variables SMTP sont celles du relais. L'IMAP utilise `imap.mail.ovh.net:993` en TLS et les mêmes
identifiants, avec surcharges `AUTO_IMAP_HOTE`, `AUTO_IMAP_UTILISATEUR`, `AUTO_IMAP_MOT_DE_PASSE` possibles.
La recette est validée sur GreenMail avec SMTP/IMAP TLS (`bun test scripts/test-mail.test.ts`) et sur la
production OVH depuis Windows et le VPS. Le parcours de lien magique a également été reçu sur Gmail,
avec authentification SPF/DKIM/DMARC positive.

## Boîte personnelle unifiée et super-administration (lot du 25 octobre)

Sources prêtes à intégrer au déploiement global : migrations `024_courrier_unifie.sql` et `025_agents_admin.sql`,
écrans `/app/courrier` et `/app/administration`, OAuth mail distinct de la connexion Auto, IMAP Aphrody et envoi Resend.
Voir `COURRIER.md` pour les contrats, variables serveur et preuves de tests. Aucune identité juridique fictive
n'est créée pour ouvrir la messagerie personnelle sans entreprise.

Configuration requise : `AUTO_COURRIER_PROPRIETAIRE=yohanpierre15@gmail.com` et
`AUTO_SUPER_ADMIN_EMAILS=yohanpierre15@gmail.com,aphrody-coode@outlook.com`. Gmail est vérifié en base ; Outlook
ne l'est pas au dernier contrôle. La promotion globale exige la vérification : ne pas forcer le champ Outlook.
Le script `scripts/administration-provisionner.ts` crée deux clés agents nominatives, hachées en base et
écrites dans un fichier privé hors dépôt, après migration et configuration du super-administrateur.

Tests de ce lot : 8 tests ciblés, 84 assertions ; OpenAPI/planification 8 tests, 33 assertions ; E2E Chrome
9 assertions (lecture, recherche, pièce jointe, échappement, compte sans entreprise et mobile 390 px).
Typecheck global 328 fichiers sans erreur. Ces tests ne remplacent pas les consentements et la recette fournisseur.

Le premier lot est maintenant déployé par le chat de conteneurisation : release `20261024T232255Z-99038b58`,
API/worker/web sains, migrations 024/025/026 appliquées après préflight sur copie de production.
Le compte Gmail vérifié est super-admin, deux clés agents sont protégées en 0600 sur le VPS ; leur accès
administration HTTP 200 et le refus de lecture mail privée HTTP 401 sont vérifiés.
Aphrody est connectée : un message rédigé dans Auto, envoyé par Resend, reçu sur OVH puis affiché dans Auto
qualifie le parcours complet. Voir `COURRIER.md`. Les consentements Gmail/Outlook restent à accorder et tester.
Le retour de session OAuth dans la coque desktop native reste à qualifier séparément du navigateur/PWA.

Second lot natif : `026_connexion_appareil.sql`, client RFC8628 `auto-native`, page
`/app/verification-appareil?user_code=…`, code secret uniquement en mémoire et cookie HttpOnly posé par le
hook officiel Better Auth. Désactivé par défaut (`AUTO_CONNEXION_APPAREIL=1` requis après qualification).
API : 3 tests/25 assertions ; Chrome deux contextes isolés : 8 assertions ; conteneur Linux :
5 tests appareil/courrier et 47 assertions. Voir `APPAREILS.md` pour le contrat exact et la limite des preuves.

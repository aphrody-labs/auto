# Boîte personnelle unifiée et administration Auto

État du 25 octobre 2026 : premier lot déployé sur le VPS, Aphrody connectée et qualifiée de bout en bout.
Les consentements de lecture Gmail et Outlook ne sont pas encore accordés à Auto.

## Accès personnel

`/app/courrier` fonctionne avec une session Better Auth, même sans entreprise ni SIRET. Les tables
`courrier_compte`, `courrier_message`, `courrier_piece` et `courrier_oauth` de la migration 024 sont isolées
par utilisateur et namespace via RLS. Le namespace personnel vaut l'UUID utilisateur, distinct des tenants métier.
Les méthodes d'administration ne lisent pas ces tables et les clés agents ne sont pas des sessions humaines.

Le propriétaire configuré est `AUTO_COURRIER_PROPRIETAIRE`. Ses alias SSO explicitement présents dans
`AUTO_SUPER_ADMIN_EMAILS`, vérifiés et de rôle global admin, ouvrent le même espace personnel principal.
Les autres utilisateurs ont chacun leur espace. Une adresse non vérifiée n'est jamais promue implicitement.

## Connexions

- Gmail : scope `https://www.googleapis.com/auth/gmail.readonly`, accès hors ligne ; état aléatoire à usage unique
  valable dix minutes, PKCE S256, jetons AES-GCM liés à l'utilisateur. Première relève paginée, puis historique
  incrémental ; historique expiré 404 : reprise complète.
- Outlook : scopes `offline_access`, `User.Read`, `Mail.Read`, comptes personnels et professionnels ; delta Inbox,
  identifiants immuables et MIME pour les pièces jointes. Les curseurs restent sur Graph et sous `/v1.0/me/`.
- Aphrody : `auto@aphrody.com` via IMAP OVH 993 TLS, `EXAMINE` et `BODY.PEEK[]`, sans marquage lu ni suppression
  sur le serveur. Les identifiants OVH existants sont repris uniquement pour le propriétaire configuré.
- L'état lu est local à Auto. Le courrier est présenté en texte, sans HTML actif ni chargement d'images distantes.
- Les envois sont faits avec Resend, expéditeur `Auto <auto@notifications.aphrody.com>`, réponse sur
  `auto@aphrody.com`, et conservés dans le dossier « Envoyés avec Resend ».

Les clients OAuth existants sont réutilisés. Les retours sont les URI **déjà enregistrées** :

```
https://auto.aphrody.com/api/auth/callback/google
https://auto.aphrody.com/api/auth/callback/microsoft
```

Seuls les états préfixés `courrier_` sont traités par la messagerie ; les autres restent gérés par Better Auth.
Les connexions d'authentification à Auto ne sont pas une autorisation de lire les boîtes mail. Les consentements
fournisseurs doivent être accordés séparément. Gmail API est déjà activée dans le projet Google `aphrody`.

La relève est planifiée toutes les cinq minutes. Les lots de rattrapage sont réenfilés immédiatement,
traités par un worker courrier distinct avec bail de dix minutes et verrou de compte. Une déconnexion efface
les jetons enregistrés et conserve les messages déjà relevés. Aucune redirection HTTP distante n'est suivie avec
un jeton. Aucune clé n'est retournée dans les listes de comptes ou les erreurs.

## Super-administrateur et agents

La migration 025 ajoute des clés d'agents hachées SHA-256, avec propriétaire, nom, expiration et révocation.
`AUTO_SUPER_ADMIN_EMAILS` promeut uniquement les comptes **vérifiés** de cette liste au rôle global `admin`.
La console `/app/administration` est accessible sans entreprise. Les routes opérateur acceptent une session
super-administrateur ou un jeton agent valide, journalisent les accès agents et ne donnent aucun accès aux
boîtes personnelles. Créer ou révoquer un agent exige la session d'un humain super-administrateur.

Configuration non secrète requise sur le VPS, en complément des secrets SMTP/Resend/OAuth existants :

```dotenv
AUTO_COURRIER_PROPRIETAIRE=yohanpierre15@gmail.com
AUTO_SUPER_ADMIN_EMAILS=yohanpierre15@gmail.com,aphrody-coode@outlook.com
```

Au dernier contrôle de production, Gmail est vérifié, Outlook n'est pas marqué vérifié dans Auto. Ne pas
forcer ce champ pour contourner une vérification. Le courrier Outlook peut être connecté au compte Auto Gmail
par son consentement OAuth propre, indépendamment de son rôle d'authentification dans Auto.

Après migration et démarrage, `scripts/administration-provisionner.ts <fichier-prive>` crée les accès nominatifs
« Codex — administration Auto » et « Automatisations — administration Auto », expirant dans 365 jours.
Il n'affiche jamais leurs valeurs et refuse de remplacer un fichier existant. Utiliser un dossier hors dépôt
0700, un umask 077, puis vérifier le fichier 0600. Ne pas ajouter ces clés aux environnements des conteneurs API/web.

## Vérifications

Tests ciblés : 8 tests, 84 assertions (état OAuth privé/rejeu, PKCE, pagination et historique Gmail, rotation
du refresh token, delta/MIME/pièces Outlook et refus de curseurs hostiles, RLS comptes/messages/pièces,
administration et révocation agents).
8 tests OpenAPI/planification, 33 assertions supplémentaires. Typecheck global : 327 fichiers sans erreur.
E2E Chrome : compte personnel sans entreprise, lecture, recherche, téléchargement, texte hostile échappé,
mobile 390 px et refus de l'administration à un non-admin : 9 assertions.

Les envois et la réception Resend déjà qualifiés avant ce lot sont documentés dans `RESEND.md`.
Recette réelle du premier lot (`20261024T232255Z-99038b58`) :

- Connexion Google normale du propriétaire et affichage privé sans entreprise confirmés dans Chrome.
- Console super-admin accessible ; clés « Codex » et « Automatisations » actives, expirant le 25 octobre 2027.
  Fichier `vps:~/auto/credentials/admin-agents.env`, mode 0600, distinct des environnements API/worker/web.
- Clé Codex : `/v1/admin/tenants` HTTP 200 ; `/v1/courrier/messages` HTTP 401 ; `/v1/admin/agents` HTTP 403.
- Boîte `auto@aphrody.com` connectée par l'interface, première relève IMAP : quatre messages et pièces jointes.
- Envoi réel depuis le formulaire Auto via Resend, sujet de contrôle « Qualification boîte unifiée Auto
  2026-10-24T23:30:13.975Z ». Message affiché dans Envoyés, reçu sur OVH puis relevé et lu dans Auto.
  Après contrôle : cinq messages de réception et un message envoyé. Aucun envoi vers un tiers.

La recette Gmail/Outlook et celle des véritables coques natives restent à compléter. Le deuxième lot chiffre
aussi les futurs jetons OAuth Better Auth (`account.encryptOAuthTokens=true`), en complément du chiffrement
AES-GCM déjà actif sur les jetons propres aux comptes courrier. Better Auth 1.7.12 conserve la lecture des anciens
jetons de connexion en clair jusqu'à leur renouvellement ; aucun jeton n'est publié dans ces preuves.

## Coques natives : limite d'authentification distincte

Le navigateur/PWA conserve son cookie pendant le retour OAuth. La coque desktop Tauri ouvre les origines
externes dans le navigateur système : les cookies de ce navigateur ne sont pas ceux du WebView. Une connexion
Google effectuée dans ce navigateur ne prouve donc pas une connexion dans la coque. Ne pas injecter un jeton
dans l'URL et ne pas supprimer le contrôle de session du callback courrier.

Un WebView déjà connecté et un navigateur connecté au même compte Auto peuvent partager la configuration
mail côté serveur ; le WebView recharge les comptes toutes les 60 secondes. Cette condition doit être vérifiée
avant de qualifier la connexion mail native. La connexion initiale OAuth native reste un parcours à qualifier.

Le second lot implémente le plugin officiel Better Auth 1.7.12 `deviceAuthorization` (RFC 8628), son schéma
`026_connexion_appareil.sql`, l'interface code/approbation/poll et la pose du cookie HttpOnly via le hook officiel.
Il est désactivé par défaut jusqu'à sa qualification native : voir `APPAREILS.md`. API et Chrome à deux contextes
isolés sont testés, y compris expiration, refus, rejeu et consommation concurrente. Les essais dans les véritables
coques Windows/Android restent distincts du test navigateur.

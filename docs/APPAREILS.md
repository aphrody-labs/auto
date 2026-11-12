# Connexion navigateur des applications natives

Lot du 25 octobre 2026, Better Auth **1.7.12**, plugin officiel `deviceAuthorization` (RFC 8628).
Ce flux est désactivé par défaut. `AUTO_CONNEXION_APPAREIL=1` active les endpoints et le bouton natif.
La migration `026_connexion_appareil.sql` doit être appliquée avant activation.

## Contrat

- Client public autorisé : `auto-native` uniquement.
- `POST /api/auth/device/code` avec `{ "client_id": "auto-native" }` produit un code utilisateur de 8 caractères,
  un secret appareil d'au moins 40 caractères, un délai de 600 secondes et une cadence minimale de 5 secondes.
- URL de vérification : `/app/verification-appareil?user_code=CODE`. Seul le code utilisateur court est dans l'URL.
- L'application conserve le secret appareil **uniquement en mémoire**, sans URL, cookie JS ni localStorage.
- La page de vérification authentifiée affiche le compte Auto, le client et le code à comparer avec l'application.
  `GET /api/auth/device?user_code=CODE` lie la demande au compte connecté. La validation ou le refus est explicite.
- `POST /api/auth/device/approve` et `/deny` utilisent `{ "userCode": "CODE" }` (camelCase dans cette API).
- L'application appelle `/api/auth/device/token` en POST avec le grant RFC8628, le client et le secret appareil.
  Elle respecte `authorization_pending`, `slow_down`, le refus et l'expiration. Elle abandonne au bout de dix minutes.
- Après consommation atomique du code approuvé, le hook officiel `setSessionCookie` pose le cookie de session
  HttpOnly côté serveur. Le client recharge sa session, puis ouvre le chemin interne demandé.
  Le jeton Bearer standard de la réponse Better Auth n'est ni affiché, ni stocké, ni placé dans une URL.
- Le code ne fonctionne qu'une fois. Une autre session utilisateur ne peut approuver une demande déjà liée.
  Les codes expirés sont nettoyés lors d'une nouvelle demande.

RFC8628 utilise son secret appareil à usage unique ; il ne s'agit pas du flux authorization-code PKCE.
Le flux OAuth des boîtes Gmail et Outlook reste protégé séparément par PKCE S256 et son état de session.

## Coque Tauri

`window.__AUTO_NATIVE__ = true` est un indicateur d'affichage, sans droit natif ou privilège serveur.
La coque intercepte uniquement l'origine Auto et le chemin exact `/app/verification-appareil`, avec `user_code`.
Le bouton « Ouvrir le navigateur » navigue vers cette URL ; la coque ouvre le navigateur système et refuse
la navigation du WebView pour conserver son polling. Aucun secret appareil ni jeton de session n'est transmis
par cette ouverture. Le transfert de cookie est la réponse HTTPS reçue par le WebView, pas une copie entre navigateurs.

La bascule de production et les essais dans les véritables coques Windows/Android sont coordonnés dans le lot
de déploiement. Les tests Chrome ne suffisent pas à affirmer la qualification des binaires natifs.

## Preuves du code

- API : 3 tests, 25 assertions, dont client refusé, attente et ralentissement, session approbatrice liée,
  cookie HttpOnly, rejet des rejeux, refus, expiration et deux polls concurrents ne créant qu'une session.
- Chrome : deux contextes isolés, dont un sans session simulant l'indicateur natif ; validation dans l'autre
  contexte, puis cookie HttpOnly et accès réel `/v1/moi` dans le premier. 8 assertions ; aucun token URL/storage.
- Conteneur Linux Bun `fd9d7a224` : 5 tests API appareil/courrier, 47 assertions passent. Même résultat fonctionnel
  sur le runtime Windows `169d8c5ea`. Les validations de boîte privée restent applicables au nouveau client.

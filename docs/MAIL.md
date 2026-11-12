# Mail (lot L7)

Chaque tenant connecte sa boîte IMAP/SMTP. L'API relève les messages, classe les factures reçues et envoie
les devis et factures émis depuis cette boîte. Le SaaS envoie aussi ses mails transactionnels (invitations,
alertes) par le relais SMTP de l'opérateur.

| Élément                       | Emplacement                                            |
| ----------------------------- | ------------------------------------------------------ |
| SMTP, IMAP, MIME, chiffrement | `packages/mail` (`@auto/mail`)                         |
| Stockage                      | `packages/store/src/mail.ts`, migration `009_mail.sql` |
| Routes et relève              | `apps/api/src/modules/mail.ts`                         |
| Serveur de test               | service `greenmail` de `compose.yaml`                  |

## Choix : TypeScript sur `Bun.connect`

| Critère         | TypeScript (retenu)                                                                                                          | Rust (`lettre`, `async-imap`, `mail-parser`, `mail-builder`)                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Robustesse MIME | Construction maîtrisée (CRLF, QP, base64, RFC 2047/2231). Analyse limitée au besoin : en-têtes, texte, HTML, pièces jointes. | `mail-parser` couvre plus de cas tordus (charsets exotiques, messages malformés).                           |
| TLS             | `Bun.connect({ tls })` et `upgradeTLS` pour STARTTLS, avec la vérification de certificat du runtime.                         | rustls ou native-tls, à câbler par protocole.                                                               |
| Asynchrone      | Natif : l'attente réseau ne bloque pas la boucle d'événements de l'API.                                                      | `bun:ffi` est synchrone : il faudrait un runtime tokio dans la cdylib, un Worker ou un binaire `Bun.spawn`. |
| Testabilité     | `bun test` contre GreenMail, sans compilation.                                                                               | Compilation en conteneur et compilation croisée MinGW à chaque changement.                                  |
| Dépendances     | Aucune.                                                                                                                      | Une douzaine de crates (tokio, rustls, encodages) à ajouter au workspace partagé.                           |

Les crates Rust du dépôt restent des fonctions pures sans réseau ni état. Un client réseau asynchrone ne
rentre pas dans ce cadre. Le Rust sert quand même au classement : `extraireXml` (`auto-facturx`, par
`bun:ffi`) reconnaît un Factur-X. Si l'analyse MIME montre ses limites sur du courrier réel,
`mail-parser` pourra passer par `auto-ffi` comme fonction pure (octets → JSON), sans toucher au réseau.

## Boîte du tenant

- `PUT /v1/mail/boite` (droit `parametres`) prend `fournisseur?`, `adresse`, `nom?`, `utilisateur?`
  (par défaut l'adresse), `motDePasse`, `imap?`, `smtp?` (`{ hote, port, securite }`) et `dossier?`
  (`INBOX` par défaut). L'API teste IMAP (connexion, TLS, LOGIN, EXAMINE) et SMTP (EHLO, STARTTLS, AUTH),
  puis enregistre. Un échec renvoie 422 avec le détail de chaque protocole.
- Les identifiants (utilisateur et mot de passe) sont chiffrés au repos en AES-256-GCM. La clé est dérivée
  par HKDF-SHA-256 de `AUTO_CLE_MAITRE` (32 caractères au moins) avec le tenant en sel, et le tenant sert
  aussi de données associées. Un secret recopié chez un autre tenant ne se déchiffre donc pas. Le mot de passe
  n'est jamais renvoyé.
- `GET /v1/mail/boite` renvoie la configuration et l'état de relève, sans le secret. `POST /v1/mail/boite/test`
  refait le test de connexion. `DELETE /v1/mail/boite` déconnecte la boîte et garde les messages relevés.
- Les connexions en clair (`securite: "aucune"`) et les certificats non vérifiés ne sont acceptés qu'avec
  `AUTO_MAIL_DEV=1` (dev et tests).

### Préréglages des fournisseurs (`GET /v1/mail/fournisseurs`)

L'écran de connexion de boîte (lot UI) propose ces préréglages. Avec `fournisseur`, les serveurs sont
préremplis et chaque champ reste modifiable.

| `fournisseur`  | IMAP                            | SMTP                              | Remarque                                                       |
| -------------- | ------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `ovh-mxplan`   | `ssl0.ovh.net` 993 TLS          | `ssl0.ovh.net` 465 TLS            | Alias officiels `imap.mail.ovh.net`, `smtp.mail.ovh.net`       |
| `ovh-emailpro` | `pro1.mail.ovh.net` 993 TLS     | `pro1.mail.ovh.net` 587 STARTTLS  | Numéro de serveur `pro?` donné dans l'espace client            |
| `ovh-exchange` | `ex5.mail.ovh.net` 993 TLS      | `ex5.mail.ovh.net` 587 STARTTLS   | Serveur `ex?` donné dans l'espace client ; valeurs à confirmer |
| `google`       | `imap.gmail.com` 993 TLS        | `smtp.gmail.com` 465 TLS          | Mot de passe d'application (validation en deux étapes)         |
| `microsoft`    | `outlook.office365.com` 993 TLS | `smtp.office365.com` 587 STARTTLS | Microsoft passe à OAuth 2, que ce module ne gère pas encore    |
| `ionos`        | `imap.ionos.fr` 993 TLS         | `smtp.ionos.fr` 465 TLS           |                                                                |
| `orange`       | `imap.orange.fr` 993 TLS        | `smtp.orange.fr` 465 TLS          |                                                                |

Sources OVHcloud : [MX Plan, généralités](https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/mx-plan/email-generalities)
(IMAP 993 et SMTP 465 en SSL/TLS ; le guide ne mentionne pas de port 587) et
[E-mail Pro sur Outlook](https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/email-pro/outlook-windows-configuration)
(`pro?.mail.ovh.net`, IMAP 993 en SSL/TLS, SMTP 587 en STARTTLS). Pour Hosted Exchange, aucune page publique
consultée ne donne IMAP ni SMTP : les valeurs `ex?.mail.ovh.net` sont à confirmer dans l'espace client.

## Relève

`POST /v1/mail/releve` (droit `ecrire`) appelle `relever(sql, tenantId, publier)`, qui est exporté pour le
`Bun.cron` du worker. `releverTous` relève toutes les boîtes.

1. `EXAMINE` du dossier, en lecture seule : les messages ne sont pas marqués lus.
2. `UID SEARCH UID n+1:*`, où `n` est le dernier UID relevé. Si UIDVALIDITY a changé, la relève repart de 0.
   Au plus 50 messages par relève.
3. `UID FETCH … BODY.PEEK[]`. Chaque message est analysé et classé hors transaction.
4. Une seule transaction enregistre les métadonnées (`mail_recu`), les pièces jointes (`mail_piece`) et
   l'état de relève. La clé `(tenant, source, UIDVALIDITY, UID)` rend l'opération idempotente : une relève
   rejouée, concurrente ou faite après reconnexion de la boîte n'ajoute aucun doublon.
5. Après validation, l'API publie un événement par nouveau message : `mail.facture_recue` si une pièce PDF
   embarque un XML Factur-X, ou si un PDF est nommé « facture », « invoice » ou « avoir » (ou que le sujet
   l'est) ; sinon `mail.recu`. Le message publié comprend la liste des pièces, avec le drapeau `facturx`.

`GET /v1/mail/messages?classement=facture|autre` liste les messages reçus. `GET /v1/mail/pieces/:id` renvoie
une pièce jointe, avec son SHA-256 en ETag.

## Envoi d'un document

`POST /v1/documents/:id/envoyer` (droit `ecrire`) prend `a?`, `cc?`, `sujet?` et `message?`.
Le destinataire par défaut est l'e-mail de la fiche client.

- Le document doit être émis (pas un brouillon, pas annulé). La pièce jointe est l'exemplaire figé : Factur-X
  pour les factures, acomptes et avoirs, PDF pour les devis. Elle est nommée `<numéro>.pdf`.
- Le message est en `multipart/mixed`, avec une partie `multipart/alternative` (texte et HTML en
  quoted-printable UTF-8) puis le PDF en base64. Il porte les en-têtes `Date`, `Message-ID` (domaine de
  l'expéditeur), `MIME-Version`, et un sujet encodé selon la RFC 2047. Les sauts de ligne dans les en-têtes
  sont refusés (pas d'injection).
- L'envoi passe par le SMTP du tenant. L'audit reçoit `mail.envoyer` (destinataires, Message-ID, SHA-256 de
  la pièce). Un document au statut `emis` passe à `envoye`, et l'événement `document.statut` est publié.

## Envoi transactionnel du SaaS

Tous les lots passent par la même interface :

```ts
import { envoyeurDepuisEnv, type EnvoyeurMail } from "@auto/mail";

const mail: EnvoyeurMail = envoyeurDepuisEnv();
await mail.envoyer({ a: ["invite@exemple.fr"], sujet: "Invitation", texte: "…", html: "<p>…</p>" });
```

Le relais est préconfiguré pour la boîte OVHcloud MX Plan de l'opérateur (`contact@aphrody.com`, webmail
<https://mail.ovh.net/modern/>). Les identifiants viennent uniquement de l'environnement et ne sont jamais
dans le dépôt.

| Variable                 | Défaut                       |
| ------------------------ | ---------------------------- |
| `AUTO_SMTP_HOTE`         | `ssl0.ovh.net`               |
| `AUTO_SMTP_SECURITE`     | `tls` (`starttls`, `aucune`) |
| `AUTO_SMTP_PORT`         | 465 en `tls`, 587 sinon      |
| `AUTO_SMTP_UTILISATEUR`  | l'adresse de l'expéditeur    |
| `AUTO_SMTP_MOT_DE_PASSE` | aucun                        |
| `AUTO_SMTP_EXPEDITEUR`   | `Auto <contact@aphrody.com>` |

Sans `AUTO_SMTP_MOT_DE_PASSE` ni `AUTO_SMTP_HOTE`, les messages sont seulement journalisés en console hors
production, et `envoyeurDepuisEnv` lève une erreur en production. Un `AUTO_SMTP_HOTE` sans mot de passe
désigne un relais local sans authentification. Pour les tests, `envoyeurMemoire()` garde les messages en
mémoire.

## Tests

```sh
docker compose up -d greenmail     # SMTP 3025, SMTPS 3465, IMAP 3143, IMAPS 3993
bun test packages/mail apps/api/src/modules/mail.test.ts
```

GreenMail tourne avec l'authentification désactivée : chaque test se sert de boîtes jetables. Les tests
d'intégration sont ignorés si GreenMail ne renvoie pas son message d'accueil. Le refus d'un certificat
auto-signé est testé dans un processus à part : sur le runtime 1.4.6, un échec de poignée de main TLS après
un appel à `crypto.subtle` fait parfois planter le processus. Pour la même raison, `Flux` n'appelle jamais
`end()` dans le rappel `handshake`.

## Limites

- Pas d'OAuth 2 (XOAUTH2) : Microsoft 365 et Gmail sans mot de passe d'application ne sont pas pris en charge.
- STARTTLS est implémenté mais pas testé en intégration, car GreenMail ne le propose pas. Seul le TLS implicite
  est testé.
- Les messages envoyés ne sont pas copiés dans le dossier « Envoyés » (`APPEND`).
- La relève n'est pas encore planifiée : `Bun.cron` et le worker relèvent du lot L9.
- `mail.recu` et `mail.facture_recue` ne figurent pas encore dans `TypeEvenement` (`evenements.ts`, lot
  outbox). Le module les publie au moyen d'un transtypage.
- Les pièces jointes sont stockées en `bytea`, en attendant le stockage S3 du plan.

# Resend transactionnel Aphrody

État du 25 octobre 2026 : équipe existante renommée **Aphrody**, domaine
`notifications.aphrody.com` vérifié par Resend, région Ireland `eu-west-1`, Forge actif,
TLS **Enforced**. Réception Resend désactivée. Aucun abonnement payant activé.
Le domaine racine était revendiqué par une autre équipe Resend : aucun transfert ni révocation effectué.

## DNS Cloudflare

Zone `aphrody.com`, enregistrements DNS only ajoutés :

| Type  | Nom                               | Destination                 |
| ----- | --------------------------------- | --------------------------- |
| TXT   | `resend._domainkey.notifications` | clé DKIM fournie par Resend |
| CNAME | `rsend.notifications`             | `rsend-euw1.forge.rmta.net` |
| CNAME | `send.notifications`              | `send.forge.rmta.net`       |

Les MX et le SPF racine OVH sont conservés. Les réponses vont à `auto@aphrody.com`.

## Application

`packages/mail/src/resend.ts` appelle l'API HTTPS sans SDK et conserve texte, HTML, CC,
Reply-To et pièces jointes. Timeout de 20 secondes, redirections refusées pour protéger la clé.
Le message est validé par le constructeur MIME existant avant transmission.
Pas de repli SMTP automatique après une erreur ambiguë, pour éviter un double envoi.
SMTP reste le fournisseur par défaut et peut être resélectionné explicitement.

Variables serveur, hors dépôt :

```dotenv
AUTO_MAIL_FOURNISSEUR=resend
AUTO_RESEND_CLE_API=<clé dédiée, Sending access, notifications.aphrody.com uniquement>
AUTO_RESEND_EXPEDITEUR=Auto <auto@notifications.aphrody.com>
AUTO_RESEND_REPONDRE_A=auto@aphrody.com
```

La clé dédiée `Aphrody Auto — VPS production` est créée après confirmation humaine,
avec **Sending access** limité à `notifications.aphrody.com`. Elle est conservée hors dépôt dans
`~/.auto/resend-production.env` (ACL privée), `vps:~/auto/credentials/resend-production.env` (0600),
et Google Secret Manager `AUTO_RESEND_CLE_API`, version 1. Aucun secret n'est écrit dans cette documentation.

API et worker de production exécutent `auto-app:resend-20261025`, image dérivée strictement de
`auto-app:arrivages-final-20261025`, avec copie des seuls fichiers Resend et diagnostic.
Le web et la recette Stripe ne sont pas modifiés. Les montages arrivages et le SMTP OVH sont conservés.
Les conteneurs `auto-api-before-resend`, `auto-worker-before-resend` et `prod.env.before-resend`
permettent le retour arrière. Après déploiement : API healthy, worker actif sans redémarrage, santé publique HTTP 200.
Pour revenir au fournisseur SMTP : resélectionner `AUTO_MAIL_FOURNISSEUR=smtp` puis recréer les conteneurs concernés.

## Qualification

`bun --env-file=<environnement-protégé> scripts/test-resend.ts` envoie un seul mail à la boîte
OVH configurée, vérifie son arrivée IMAP, le sujet, un marqueur unique et une pièce jointe.
L'identifiant API et les Message-ID demandé/reçu sont distincts afin de détecter leur réécriture.
Le test ne marque pas les messages lus et ne les supprime pas.

Qualification réelle du 25 octobre 2026 depuis le VPS :

- Envoi Resend `01a1700c-0b3d-7c03-9abd-6d95f1dd6800`, réception OVH UID 260 en **3579 ms**,
  texte et pièce jointe identiques.
- Message-ID demandé `<01a1700c-0a5b-7438-8331-118286ef6e12@notifications.aphrody.com>`,
  réécrit par SES en `<010201a1700c0d55-98f997f9-dd69-4d8a-b35e-51d3b53d7948-000000@eu-west-1.amazonses.com>`.
- Chemin réel de l'application : POST public `/api/auth/sign-in/magic-link` retourne HTTP 200,
  puis le mail est reçu dans la **boîte de réception Gmail** du propriétaire, pas seulement accepté par l'API.
  Message Gmail `1a1700d32dd73452`, sujet « Votre lien de connexion à auto », expéditeur
  `Auto <auto@notifications.aphrody.com>`, Reply-To `auto@aphrody.com`.
  En-têtes Gmail : **SPF pass, DKIM pass, DMARC pass**, transport **TLS 1.3**.
  Le lien et le jeton d'authentification ne sont ni journalisés ni publiés.
- Dashboard Resend : les deux messages affichent **Delivered**, dont l'envoi d'authentification
  `01a1700d-2f09-7c1e-9b3f-394e79613c1d`.

Vérification ciblée : 8 tests, 34 assertions ; typecheck natif de 11 fichiers, lint et format passent.

Documentation consultée avec Context7 : [domaines](https://resend.com/docs/api-reference/domains/create-domain),
[envoi](https://resend.com/docs/api-reference/emails/send-email),
[idempotence](https://resend.com/docs/dashboard/emails/idempotency-keys).

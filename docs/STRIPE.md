# Stripe : abonnement et facturation

L'API appelle l'API REST Stripe par `fetch` (sans SDK) : `packages/billing/src/stripe.ts`. Les routes
sont dans `apps/api/src/modules/abonnement.ts`, l'état dans la migration `011_abonnement.sql`.
Contact facturation de l'opérateur : contact@aphrody.com.

## Configuration

État du 25 octobre 2026 : la configuration active utilise exclusivement le nouveau compte **Aphrody**
(`acct_1UUDExJjg4RzOszD`), dans l'organisation Aphrody. Sa sandbox dédiée
(`acct_1UUDFkQpL4EotU2M`) alimente `recette-auto.aphrody.com`, dans une pile isolée sur le VPS.
Checkout, paiement fictif, webhooks et abonnement Business y sont vérifiés. La vérification de l'entreprise
reste nécessaire pour autoriser les accès et encaissements de production.
`scripts/stripe-provisionner.ts` provisionne le catalogue, la TVA, le portail et le webhook sans créer
de client ni de paiement. Le fichier de sortie contient le secret webhook et doit rester hors dépôt.

```sh
bun --env-file=<secrets-hors-depot> scripts/stripe-provisionner.ts <configuration-hors-depot>
# --production requiert une clé live et un compte autorisé à encaisser.
```

Le script conserve les identifiants existants lors d'une reprise avec le même fichier de configuration.

Stripe CLI 1.55.1 est installé sur Windows et le VPS. La commande serveur
`~/auto/outils/stripe-aphrody` (également `~/.local/bin/stripe-aphrody`) utilise la clé Aphrody
de sandbox à accès complet, conservée dans `~/auto/credentials/stripe-aphrody-admin-test.env` (0600).
Sous Windows : `~/.auto/stripe-aphrody.ps1`. Ces commandes ne ciblent pas le compte historique.
Le plugin officiel `stripe@openai-curated` est installé et activé pour Codex (version `0722921d`,
vérifiée par `stripe agent setup --client codex --status --json` avec le véritable CLI Codex).
Sa connexion MCP OAuth reste distincte de l'installation ; aucun outil Stripe connecté n'est encore
disponible dans la conversation active. Ne pas présenter la clé de sandbox comme un accès live.

La clé d'organisation « Aphrody — administration VPS » est préparée avec accès complet dans le
Dashboard. Sa création n'est pas confirmée : Stripe a exigé une vérification du propriétaire et envoyé
un lien à son adresse Gmail. Aucun secret `sk_org` n'a été obtenu ni installé. La vérification du
propriétaire pour créer une clé est distincte de la vérification juridique permettant d'encaisser.
Les retours Checkout/portail visent `/app/parametres`, la page réellement servie par le front.
Les webhooks traitent les résiliations classiques (`cancel_at_period_end`) et flexibles (`cancel_at`),
comme vérifié sur le vrai portail de test. La date de fin programmée est conservée sans retirer le plan actif.

| Variable                                                      | Rôle                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                                           | clé secrète (`sk_test_…` en test)                                         |
| `STRIPE_WEBHOOK_SECRET`                                       | secret de signature de l'endpoint (`whsec_…`)                             |
| `STRIPE_PRIX_PRO_MENSUEL`, `STRIPE_PRIX_PRO_ANNUEL`           | prix Stripe (`price_…`) du plan Pro                                       |
| `STRIPE_PRIX_BUSINESS_MENSUEL`, `STRIPE_PRIX_BUSINESS_ANNUEL` | prix Stripe du plan Business                                              |
| `STRIPE_TAUX_TVA`                                             | taux de TVA Stripe (`txr_…`, 20 %, exclusif) ajouté aux abonnements       |
| `STRIPE_API_VERSION`                                          | facultatif : version épinglée (en-tête `Stripe-Version`)                  |
| `STRIPE_API_BASE`                                             | facultatif : base de l'API (faux serveur des tests)                       |
| `AUTO_TENANT_OPERATEUR`                                       | uuid du tenant qui émet les factures de l'abonnement                      |
| `AUTO_EMAIL_OPERATEUR`                                        | contact facturation porté sur ces factures (défaut `contact@aphrody.com`) |
| `AUTO_URL_APP`                                                | base des URL de retour du Checkout et du portail                          |

Dans le tableau de bord Stripe (mode test) :

1. Produits « auto Pro » et « auto Business », chacun avec un prix mensuel et un prix annuel, HT,
   aux montants de `docs/TARIFS.md` (`tax_behavior` exclusif).
2. Un taux de TVA de 20 % exclusif (`STRIPE_TAUX_TVA`) : la facture Stripe est alors TTC et son
   montant payé égale le TTC de la facture émise par l'application (contrôlé, sinon 422).
3. Portail client activé (moyen de paiement, changement de plan entre les quatre prix, résiliation).
4. Le tenant opérateur est un compte auto ordinaire (inscription), avec SIRET et TVA de l'éditeur.

## Routes

| Route                          | Accès        | Rôle                                                       |
| ------------------------------ | ------------ | ---------------------------------------------------------- |
| `GET /v1/abonnement/plans`     | public       | plans, prix HT, quotas                                     |
| `GET /v1/abonnement`           | `lire`       | plan souscrit, plan effectif, statut, consommation du mois |
| `POST /v1/abonnement/checkout` | `parametres` | `{ plan, periodicite }` → `{ url }` d'une Checkout Session |
| `POST /v1/abonnement/portail`  | `parametres` | `{ url }` du portail client                                |
| `POST /v1/abonnement/webhook`  | signé Stripe | réception des événements                                   |

Le Checkout crée au besoin le client Stripe (`metadata.tenant_id`, clé d'idempotence par tenant), en
mode `subscription`, avec `client_reference_id` et `subscription_data.metadata.tenant_id` : chaque
événement est relié à son tenant sans table de correspondance. Essai de 30 jours
(`trial_period_days`) à la première souscription Pro.

## Webhooks à déclarer

Endpoint `https://<api>/v1/abonnement/webhook`, événements :

- `checkout.session.completed` : identifiants Stripe, plan, statut `trialing` ou `active` ;
- `customer.subscription.created`, `customer.subscription.updated` : plan (d'après le prix), statut,
  fin d'essai et de période, résiliation en fin de période ;
- `customer.subscription.deleted` : statut `canceled`, retour aux quotas Gratuit ;
- `invoice.paid` : la facture de l'abonnement est **émise par le tenant opérateur** (brouillon,
  numérotation, Factur-X figé et contrôlé, comme `POST /v1/documents/:id/emettre`), puis soldée par
  un paiement carte ; une facture à 0 € (essai) n'est pas émise ;
- `invoice.payment_failed` : statut `past_due`.

Sécurité et rejeu :

- signature `Stripe-Signature` vérifiée selon la documentation Stripe : HMAC-SHA256 de
  `<t>.<corps brut>` avec le secret de l'endpoint, comparé en temps constant à chaque `v1`,
  horodatage à ±300 s ; sinon 400 ;
- chaque événement est inscrit dans `stripe_evenement` (clé primaire = id Stripe) dans la
  transaction qui l'applique : un rejeu répond `rejeu` sans effet ; un échec annule tout (réponse
  non 2xx) et Stripe renvoie l'événement ;
- une facture Stripe ne donne qu'une facture émise, même reçue sous deux événements ;
- un événement d'abonnement plus ancien que le dernier appliqué est ignoré (`perime`) ;
- un événement dont le client Stripe ne correspond pas au tenant est écarté (`client_incoherent`).

`stripe_evenement` est une table opérateur : hors RLS, aucun droit pour le rôle `auto_app`.
`abonnement` et `consommation` sont sous RLS forcée comme les autres tables métier.

## Quotas

`appliquerQuotas(sql, routes)` (hook branché dans `creerApp`) enveloppe les points d'entrée listés
dans `REGLES` : émission d'une facture ou d'un acompte (factures du mois, stockage) et création
d'employé. Le compteur des factures est tenu par le déclencheur `consommation_facture`, dans la
transaction d'émission. Les autres lots appellent `exigerQuota(sql, tenantId, ressource)` ou
`consommerAppelsLlm(sql, tenantId)`, ou ajoutent leur route à `REGLES` ; le lot mail branche sa
jauge par `definirJauge("boites_mail", …)`.

## Tester avec la CLI Stripe

```sh
stripe login
stripe listen --forward-to localhost:3000/v1/abonnement/webhook   # affiche le whsec_… à mettre dans STRIPE_WEBHOOK_SECRET
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
```

Les événements de `stripe trigger` n'ont pas de `metadata.tenant_id` : ils sont journalisés avec le
résultat `tenant_inconnu`. Pour un parcours complet, appeler `POST /v1/abonnement/checkout`, payer
avec la carte de test `4242 4242 4242 4242`, et laisser `stripe listen` relayer les événements.

Les tests automatisés (`apps/api/src/modules/abonnement.test.ts`) n'utilisent aucune clé réelle :
un faux serveur Stripe en `Bun.serve` reçoit les appels REST, et les webhooks sont signés avec
`signerStripe`.

## Limites

- Pas de changement de plan depuis l'application : il passe par le portail client Stripe.
- Les factures émises par l'opérateur ne sont pas encore transmises par sa plateforme agréée (lot L6).
- Le stockage compte les exemplaires figés (`fichier`) ; les pièces reçues (lot L8) s'y ajouteront.

## Paiement en ligne des factures (compte de l'entreprise)

Distinct de l'abonnement : ici, l'argent va sur le compte Stripe **de l'entreprise cliente d'auto**, jamais sur celui
de l'opérateur. Chaque entreprise colle sa propre clé secrète (`sk_…` ou `rk_…`) dans Paramètres, Paiement en ligne.

- Code : `packages/services/src/encaissement.ts`, routes `apps/api/src/modules/encaissement.ts`, migration
  `016_encaissement.sql`. La clé est vérifiée chez Stripe (`GET /v1/account`) puis chiffrée (AES-256-GCM, clé dérivée
  du tenant) ; seuls ses quatre derniers caractères sont affichés.
- Parcours : bouton « Lien de paiement » sur une facture émise, lien signé valable 30 jours (`/facture/<jeton>`),
  Checkout Stripe pour le reste dû, retour sur la page qui relit la session chez Stripe.
- Garanties : le paiement n'est enregistré que si Stripe confirme `paid` en euros, pour la bonne facture et le bon
  tenant, une seule fois (référence `stripe:<session>`, index unique), en mode « carte ». L'événement
  `paiement.enregistre` part avec `canal: "en_ligne"`.
- Tests : `apps/api/src/encaissement.test.ts` et `apps/web/e2e/paiement-en-ligne.test.ts` utilisent un faux Stripe
  (`AUTO_STRIPE_API`). Un paiement réel en mode test demande une clé `sk_test_…` d'un compte Stripe.

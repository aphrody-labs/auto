# Plateforme agréée (PA)

Recherche du 22/10/2026. auto est une **solution compatible** : il n'est pas immatriculé et passe par une
PA, au nom de chaque entreprise cliente (mandat). Réception obligatoire depuis le 01/09/2026, émission
au 01/09/2027 pour les PME et micro-entreprises.

## Liste officielle

- Source de référence : [impots.gouv.fr, liste des plateformes agréées immatriculées](https://www.impots.gouv.fr/liste-des-plateformes-agreees-immatriculees)
  (immatriculation définitive) et [immatriculées sous réserve](https://www.impots.gouv.fr/liste-des-plateformes-agreees-immatriculees-sous-reserve).
  **Non lue directement** : le site était en maintenance lors de la consultation, et seule l'introduction de la page était accessible.
- Reprise nominative de la liste officielle par [LégiFiscal (15/06/2026)](https://www.legifiscal.fr/actualites-fiscales/4536-facturation-electronique-137-plateformes-agreees.html) :
  137 PA immatriculées et 14 en attente d'immatriculation définitive. Immatriculation définitive pour
  B2BRouter (12/12/2025), IOPOLE (11/12/2025), SUPER PDP (22/12/2025), SAGE (22/12/2025), TIIME PDP,
  PENNYLANE et QONTO.
- Jeu de données [data.gouv.fr](https://www.data.gouv.fr/datasets/liste-des-plateformes-agreees-pour-la-facturation-electronique)
  (XLSX, mis à jour le 06/08/2026). Il est publié par la FNAE, pas par la DGFiP.
- Premières publications : 101 PA en janvier 2026 ([FFB](https://www.ffbatiment.fr/actualites-batiment/actualite-ba/facturation-electronique-liste-101-plateformes-agreee-publiee)).

## API publiques

| PA        | Documentation publique                                                                                                                                                                        | Constat                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2Brouter | **Oui** : [guides](https://docs.b2brouter.net/en/developers/overview/), [référence OpenAPI](https://b2brouter.readme.io/reference/get-invoice), [index](https://b2brouter.readme.io/llms.txt) | Factures émises et reçues, import de fichier, `mark_as`, annuaire (Peppol et Annuaire DGFiP), webhooks signés, ledgers DGFiP (Flux 10), bac à sable par clé `test_`. Offre « solution compatible » en marque blanche ou grise ([page](https://www.b2brouter.net/fr/api-facturation-electronique/)). |
| Iopole    | Annoncée (« sandbox gratuite et documentation complète », [Foxeet](https://foxeet.fr/contenu/plateforme-agreee-api-iopole-facturation-electronique))                                          | Portail développeur introuvable par recherche publique : non vérifié.                                                                                                                                                                                                                               |
| Super PDP | Section `/documentation` sur [superpdp.tech](https://www.superpdp.tech/)                                                                                                                      | Page non lisible sans navigateur : contenu non vérifié.                                                                                                                                                                                                                                             |
| Sage      | Page commerciale [API PA](https://www.sage.com/fr-fr/dematerialisation/facture-electronique/api-plateforme-agreee/)                                                                           | Aucune référence technique publique trouvée.                                                                                                                                                                                                                                                        |
| Pennylane | API publique de gestion                                                                                                                                                                       | Un utilisateur y relève l'absence d'appels pour la PA ([forum](https://pennylane.readme.io/discuss/69d505a46fe19774b15b8519)).                                                                                                                                                                      |

## Choix : B2Brouter

- Immatriculation définitive (12/12/2025), d'après la reprise LégiFiscal de la liste officielle.
- Seule PA de l'échantillon dont la référence d'API est publique et complète : URL, en-têtes, schémas,
  codes d'erreur et format de signature des webhooks.
- Modèle prévu pour un éditeur tiers : un compte par entreprise cliente, avec la clé API du compte.
- Bac à sable sans contrat : une clé `test_` sur `https://api.b2brouter.net`, ou le staging `https://api-staging.b2brouter.net`.

### Correspondance utilisée (`packages/pa/src/b2brouter.ts`)

| Besoin                       | Appel B2Brouter (API `2026-06-26`)                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentification             | en-têtes `X-B2B-API-Key`, `X-B2B-API-Version`                                                                                                                                                                               |
| Dépôt Factur-X               | `POST /accounts/{compte}/invoices/import?send_after_import=true&issued=true` (`application/pdf`)                                                                                                                            |
| Statut d'une facture         | `GET /invoices/{id}` (`state`, `state_updated_at`)                                                                                                                                                                          |
| Statut posé par l'entreprise | `POST /invoices/{id}/mark_as` (`state`, `reason`)                                                                                                                                                                           |
| Factures reçues              | `GET /accounts/{compte}/invoices?type=ReceivedInvoice&updated_at_from=…`, puis `GET /invoices/{id}/as/original`                                                                                                             |
| Annuaire                     | `GET /directory/0002/{siren}` : 202 avec `polling_url` jusqu'à 200 ou 404                                                                                                                                                   |
| E-reporting                  | Désactivé (503) : l'API Auto reçoit des totaux agrégés, alors que le pipeline natif B2Brouter part des factures détaillées ; l'autre voie exige un XML Flux 10 v3.2 déjà validé et `POST /accounts/{compte}/ledgers/import` |
| Webhooks                     | `X-B2Brouter-Signature: t=<unix>,s=<hex>`, HMAC-SHA256 de `t.corps` ; événements `issued_invoice.state_change`, `received_invoice.created`                                                                                  |

Correspondance des états avec les statuts du cycle de vie :

| États B2Brouter                       | Statut             | Code |
| ------------------------------------- | ------------------ | ---- |
| `new`, `sending`, `issued`            | déposée            | 200  |
| `sent`                                | déposée            | 200  |
| `registered`                          | reçue              | 202  |
| `received`, `downloaded`              | mise à disposition | 203  |
| `read`                                | prise en charge    | 204  |
| `accepted`                            | approuvée          | 205  |
| `annotated`                           | en litige          | 207  |
| `refused`                             | refusée            | 210  |
| `allegedly_paid`, `payment_processed` | paiement transmis  | 211  |
| `paid`                                | encaissée          | 212  |
| `error`, `invalid`                    | rejetée            | 213  |

### Non vérifié (à qualifier en bac à sable avant d'activer B2Brouter)

- **Import.** Le [guide France actuel](https://docs.b2brouter.net/en/developers/guides-by-country/france/dgfip-e-invoicing-and-e-reporting/)
  confirme Factur-X en `application/pdf`. Le type MIME et les correspondances `sent`, `registered`, `read`
  ont été corrigés et testés le 24 octobre ; reste la recette sur le compte réel du fournisseur.
- **Annuaire.** L'exemple de la documentation utilise le schéma `9920`. Le schéma `0002` (SIRENE, ISO 6523) est une hypothèse. La réponse ne nomme pas la PA de réception du destinataire.
- **E-reporting.** B2Brouter documente deux voies : générer Flux 10 depuis les données détaillées des factures, ou déposer
  un XML `<Report>` conforme au XSD officiel v3.2 via le [guide Flux 10](https://docs.b2brouter.net/fr/developers/use-cases-by-country/submit-flux10-ereporting-file/).
  L'API Auto ne reçoit pour l'instant que des totaux et ne peut donc utiliser aucune de ces deux voies. L'ancien XML simplifié
  ne répond pas au contrat ; son envoi reste bloqué, même en bac à sable.
- **Mandat.** Aucune API n'est publiée pour le mandat. Celui-ci est enregistré chez auto (`pa_connexion.mandat`) et porté contractuellement par le compte B2Brouter de l'entreprise.
- **Pas de `received_invoice.state_change`.** Les statuts des factures reçues (refus côté acheteur) ne sont pas encore traités.

## Statuts du cycle de vie (XP Z12-012)

Codes 200 à 214 ([Quadient](https://www.quadient.com/fr/blog/cycle-vie-facture-electronique-statuts)) :

| Code | Statut                  |
| ---- | ----------------------- |
| 200  | Déposée                 |
| 201  | Émise                   |
| 202  | Reçue                   |
| 203  | Mise à disposition      |
| 204  | Prise en charge         |
| 205  | Approuvée               |
| 206  | Approuvée partiellement |
| 207  | En litige               |
| 208  | Suspendue               |
| 209  | Complétée               |
| 210  | Refusée                 |
| 211  | Paiement transmis       |
| 212  | Encaissée               |
| 213  | Rejetée                 |
| 214  | Visée                   |

Les statuts 200, 210, 212 et 213 sont obligatoires. Le statut 212 n'est transmis que si la TVA est
exigible à l'encaissement. Le texte AFNOR de la norme n'a pas été consulté (document payant).

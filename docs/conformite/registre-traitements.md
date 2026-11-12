# Registre des traitements

> **À faire valider par un juriste.** Modèle établi au 2026-10-22 d'après le fonctionnement du produit.

Responsable : [raison sociale de l'éditeur], [adresse], [SIREN]. Contact : contact@aphrody.com.
Délégué à la protection des données : [nom ou « non désigné »], contact@aphrody.com.

L'éditeur est **responsable de traitement** pour la gestion de ses clients (comptes, abonnement) et
**sous-traitant** (art. 28) pour les données que ses clients saisissent dans le service (leurs clients,
leurs salariés).

## A. Traitements dont l'éditeur est responsable

### A1. Comptes utilisateurs et sécurité

| Rubrique      | Contenu                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Finalité      | Création de compte, authentification, rôles, invitations, double authentification                           |
| Base légale   | Exécution du contrat (art. 6.1.b)                                                                           |
| Personnes     | Utilisateurs des entreprises clientes                                                                       |
| Données       | Email, hash du mot de passe (Argon2), rôle, secret TOTP chiffré, hash des codes de secours, sessions (hash) |
| Destinataires | Personnel habilité de l'éditeur ; hébergeur                                                                 |
| Durée         | Durée du compte ; sessions 30 jours ; invitations 7 jours ; effacement à la suppression du tenant           |
| Sécurité      | Hash SHA-256 des jetons, Argon2 des mots de passe, AES-256-GCM des secrets 2FA, RLS, journal d'audit        |

### A2. Abonnement et facturation des clients de l'éditeur

| Rubrique      | Contenu                                                           |
| ------------- | ----------------------------------------------------------------- |
| Finalité      | Gestion de l'abonnement, facturation, recouvrement                |
| Base légale   | Contrat ; obligation légale (conservation comptable)              |
| Données       | Raison sociale, SIREN, adresse, contact de facturation, paiements |
| Destinataires | Prestataire de paiement (voir sous-traitants)                     |
| Durée         | Durée du contrat, puis 10 ans pour les pièces comptables          |

### A3. Exploitation et sécurité du service

| Rubrique    | Contenu                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| Finalité    | Supervision, diagnostic, détection d'incidents                                                                  |
| Base légale | Intérêt légitime (art. 6.1.f) : sécurité et disponibilité du service                                            |
| Données     | Journaux techniques : route (motif), méthode, statut, durée, identifiant opaque du tenant ; pas d'IP ni d'email |
| Durée       | 12 mois maximum [à fixer]                                                                                       |

### A4. Préremplissage Sirene

| Rubrique    | Contenu                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| Finalité    | Préremplir la fiche entreprise à partir du SIREN                                              |
| Base légale | Exécution du contrat ; données publiques (répertoire Sirene, INSEE)                           |
| Données     | SIREN, dénomination, adresse du siège, NAF ; nom du dirigeant pour un entrepreneur individuel |
| Source      | recherche-entreprises.api.gouv.fr (aucune donnée transmise hormis le SIREN recherché)         |

## B. Traitements opérés pour le compte des clients (sous-traitance)

### B1. Facturation et gestion commerciale

| Rubrique  | Contenu                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| Finalité  | Devis, factures Factur-X, avoirs, paiements, relances, transmission à une plateforme agréée                  |
| Personnes | Clients et prospects du client (personnes morales et physiques)                                              |
| Données   | Identité, adresse, email, SIRET, TVA, montants, historique de paiement                                       |
| Durée     | Fixée par le client ; pièces comptables 10 ans après clôture de l'exercice, même après suppression du compte |

### B2. Gestion du personnel

| Rubrique  | Contenu                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finalité  | Fiches salariés, absences, congés                                                                                                                  |
| Personnes | Salariés du client                                                                                                                                 |
| Données   | Nom, prénom, email, poste, contrat, dates, temps de travail, salaire, absences (le motif peut révéler une donnée de santé : saisie libre à éviter) |
| Accès     | Droit `rh` uniquement (owner, admin)                                                                                                               |
| Durée     | Fixée par le client ; effacement à la suppression du tenant                                                                                        |

### B3. Automatisation

| Rubrique | Contenu                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| Finalité | Workflows déclenchés par des événements (émission, paiement, absence, invitation) |
| Moyens   | n8n hébergé par l'éditeur, base séparée ; webhooks signés HMAC                    |
| Données  | Contenu des événements (document émis, montant, identifiants)                     |

## Mesures de sécurité communes (art. 32)

Hébergement dans l'Union européenne ; isolation par tenant (RLS Postgres forcée) ; chiffrement TLS en
transit ; secrets chiffrés au repos ; piste d'audit chaînée SHA-256 ; documents émis immuables ;
sauvegardes chiffrées avec rotation et restauration testée ; archivage objet à verrou ; double
authentification ; jetons stockés hachés ; principe du moindre privilège (rôle `auto_app`).

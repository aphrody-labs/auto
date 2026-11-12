# Carte de recon

Périmètre : cœur de boucle = devis -> facture (Factur-X) -> envoi -> relance -> encaissement ; avoir pour corriger. Web d'abord (mobile = responsive). Cible : indépendants et TPE françaises.
Hors périmètre v1 : comptabilité/bancaire, paie, télédéclaration URSSAF, gestion de projet.

## 1. Inventaire des écrans

États : V vide, C chargement, R rempli, E erreur, P permission refusée.

| ID  | Écran                        | Accès                    | Objet                                                   | Composants clés                                         | États                              |
| --- | ---------------------------- | ------------------------ | ------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| S01 | Inscription / connexion      | /connexion               | créer un compte                                         | formulaire, recherche SIREN                             | E                                  |
| S02 | Onboarding entreprise        | après S01                | identité légale (SIRET, TVA, franchise, IBAN, mentions) | stepper, SIRET validé                                   | E                                  |
| S03 | Tableau de bord              | /                        | encours, en retard, encaissé, à faire                   | cartes KPI, liste « à traiter », graphique mensuel      | V, C, R                            |
| S04 | Liste des factures           | /factures                | filtrer, trier, actions                                 | tableau, filtres statut, recherche, badge               | V, C, R, E                         |
| S05 | Liste des devis              | /devis                   | idem + conversion                                       | tableau, badge                                          | V, C, R                            |
| S06 | Éditeur de document          | /documents/nouveau, /:id | lignes, TVA, mentions, aperçu                           | éditeur de lignes, totaux, aperçu PDF, sélecteur client | brouillon, émis (lecture seule), E |
| S07 | Détail document              | /documents/:id           | timeline, PDF, paiements, actions                       | en-tête statut, historique, boutons contextuels         | R, P                               |
| S08 | Envoi                        | modale depuis S07        | e-mail + pièce jointe Factur-X                          | formulaire, aperçu                                      | E                                  |
| S09 | Avoir                        | depuis S07               | avoir total/partiel                                     | éditeur pré-rempli                                      | E                                  |
| S10 | Clients                      | /clients                 | répertoire                                              | tableau, recherche                                      | V, R                               |
| S11 | Fiche client                 | /clients/:id             | coordonnées, historique, encours                        | formulaire, liste de documents                          | R                                  |
| S12 | Catalogue                    | /catalogue               | articles réutilisables                                  | tableau, formulaire                                     | V, R                               |
| S13 | Paramètres facturation       | /parametres/facturation  | modèles, numérotation, mentions, relances               | formulaires, aperçu                                     | R                                  |
| S14 | Équipe et rôles              | /parametres/equipe       | membres, rôles                                          | tableau, invitation                                     | P                                  |
| S15 | Journal d'audit              | /parametres/audit        | vérification de la chaîne                               | liste, bouton vérifier                                  | R                                  |
| S16 | Page publique devis/paiement | lien client              | accepter, refuser, signer, payer                        | aperçu, boutons                                         | C, E                               |
| S17 | Jetons API                   | /parametres/api          | clés                                                    | tableau, création                                       | V, R                               |

## 2. Flux

- F01 Première facture : S01 -> S02 -> S06 -> S07 -> S08. Cible : 6 clics avec client existant.
- F02 Devis vers facture : S05 -> S07 (accepté) -> Convertir -> S06 pré-rempli -> émettre. 3 clics. Bords : devis expiré ou refusé.
- F03 Acompte puis solde : devis accepté -> acompte (386) -> facture de solde avec déduction.
- F04 Correction : facture émise -> S09 avoir -> nouvelle facture. Aucune modification d'une facture émise.
- F05 Relance : facture échue -> relance auto/manuelle -> paiement -> payé.
- F06 Paiement manuel : S07 -> Marquer payée (date, moyen).
- F07 Signature client d'un devis : S16 -> accepté -> notification.
- F08 Vérification d'intégrité : S15 -> /v1/audit/verification.
- F09 Intégration : S17 -> jeton -> /v1/documents.

## 3. Composants

Bouton (primaire, secondaire, danger, fantôme ; repos, survol, focus, actif, désactivé, chargement) ; champ texte/montant (erreur, aide) ; combobox client ; sélecteur de date ; tableau (tri, sélection, vide, squelette) ; badge de statut ; éditeur de lignes ; carte KPI ; modale ; toast ; stepper ; onglets ; timeline ; aperçu PDF ; barre de filtres ; pagination ; menu d'actions ; bandeau d'avertissement (franchise TVA, mentions manquantes).

## 4. Modèle inféré confronté à `@auto/domain`

| Entité observée                                                      | Équivalent auto                                                                   | Écart / action                                                                                              | Confiance |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------- |
| Devis, facture, avoir, proforma                                      | `Type` : devis, facture, acompte, avoir                                           | proforma absent (could)                                                                                     | haute     |
| Vues À traiter / À venir / En retard / Encaissées                    | `Statut` : brouillon, emis, envoye, accepte, refuse, depose, rejete, paye, annule | « en retard » doit être dérivé (échéance dépassée et non payé), pas stocké ; ajouter « partiellement payé » | haute     |
| Lignes                                                               | `Ligne`                                                                           | remise par ligne/globale absente (should)                                                                   | haute     |
| Client / émetteur                                                    | `Partie`                                                                          | pas d'identité persistante : table `client` à prévoir                                                       | haute     |
| Catalogue                                                            | absent                                                                            | entité `article` (should)                                                                                   | moyenne   |
| Modèles de document (logo, couleur, langue, délais, compte bancaire) | absent                                                                            | `modele` par tenant                                                                                         | haute     |
| Conditions, pénalités, indemnité 40 EUR                              | `conditionsPaiement`, `penalitesRetard`, `INDEMNITE_RECOUVREMENT_CENTS`           | couvert                                                                                                     | haute     |
| Franchise TVA                                                        | `franchiseTva`, `MENTION_FRANCHISE`                                               | couvert                                                                                                     | haute     |
| Devis -> facture, avoir lié                                          | `origine`, `devisVersFacture`, `avoirTotal`                                       | avoir partiel absent (must)                                                                                 | haute     |
| Paiement                                                             | absent                                                                            | entité `paiement` (must)                                                                                    | haute     |
| Relances                                                             | absent                                                                            | `regle_relance`, `relance_envoyee` (should)                                                                 | moyenne   |
| Récurrence                                                           | absent                                                                            | could                                                                                                       | moyenne   |
| Signature de devis                                                   | `accepte` seul                                                                    | preuve (horodatage, empreinte) à ajouter (should)                                                           | moyenne   |
| Audit chaîné, numérotation sans trou, RLS                            | présents (store, tenancy)                                                         | différenciant : à exposer en S15                                                                            | haute     |

## 5. Non clonable

Agrément plateforme agréée (immatriculation DGFiP, e-reporting) : raccordement à une PA partenaire ; agrégation bancaire (DSP2) ; télédéclaration URSSAF ; signature électronique qualifiée ; marques et visuels des concurrents.

## 6. Dimensionnement

17 écrans, 9 flux, 6 nouvelles entités (client, article, modele, paiement, regle_relance, relance_envoyee). Taille : L pour la v1 complète, M pour la tranche F01 + F02 + F04.
Parties dures : 1) éditeur de lignes à totaux exacts en centimes (domaine déjà prêt) ; 2) envoi Factur-X + raccordement PA ; 3) relances planifiées et rapprochement des paiements.
Suite : `replica-architect` sur la tranche F01/F02/F04.

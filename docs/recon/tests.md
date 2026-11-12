# Plan de test et rapports de bugs, apps/web et packages/ui

Build : main @ 774fce9 + correctifs de ce lot. Chrome headless, 375 et 1440 px, thèmes clair et sombre.
Automatisé : `apps/web/e2e/*.test.ts` (base Postgres jetable via `testDb()`, API `creerApp`, web `demarrerWeb`).

## Plan

| Flux                         | Cas                                                                                                                               | Automatisation                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| F01 Inscription              | H1 parcours SIREN, entreprise, compte créé. E1 e-mail invalide. E2 SIREN inconnu. N1 e-mail déjà pris.                            | H1, E1 : parcours.test.ts. E2, N1 : à vérifier   |
| F02 Devis, facture, émission | H1 devis, émission, conversion en facture, totaux remise/TVA. E1 champs vides. E2 emoji et accents. E3 double clic.               | H1 : parcours.test.ts. E1 à E3 : à vérifier      |
| F03 Paiement                 | H1 paiement partiel puis solde. N1 montant vide ou texte. N2 montant > reste dû. E1 facture soldée : formulaire retiré.           | paiement-relance.test.ts                         |
| F04 Relance                  | H1 palier et canal, relance consignée. E1 facture soldée : pas de relance.                                                        | paiement-relance.test.ts (H1)                    |
| F05 Factures reçues          | H1 liste filtrée, anomalie, validation.                                                                                           | recues.test.ts                                   |
| F06 Employés et congés       | H1 ajout employé, demande de congé, validation.                                                                                   | parcours.test.ts                                 |
| F07 Imports et exports       | H1 aperçu, correspondance, import, erreurs de ligne.                                                                              | parcours.test.ts (import) ; exports : à vérifier |
| F08 Paramètres et thème      | H1 couleur de marque. H2 bascule clair/sombre, mémorisation, avant JS.                                                            | parcours.test.ts, accessibilite.test.ts          |
| F09 Connexion                | N1 mauvais mot de passe. N2 champs vides. N3 retour `//evil` ignoré. N4 session expirée. E1 focus clavier.                        | publiques.test.ts                                |
| F10 Isolation                | N1 document d'un autre compte : 404, aucune fuite.                                                                                | paiement-relance.test.ts                         |
| F11 Pages publiques          | H1 accueil, tarifs, mentions, confidentialité, connexion, inscription : contraste, noms, libellés, cibles 24 px, débordement, h1. | publiques.test.ts                                |
| F12 États vides et erreurs   | N1 route inconnue. N2 document introuvable.                                                                                       | publiques.test.ts                                |
| Transverse                   | Écrans connectés en 4 combinaisons largeur/thème.                                                                                 | accessibilite.test.ts                            |

À vérifier (non automatisé) : réseau lent ou hors ligne, deux onglets, fuseaux horaires et changement d'heure, lecteur d'écran réel, envoi réel des e-mails de relance.

## Bugs

### BUG-001 : le reste dû et la liste des paiements ne se rafraîchissent pas après un paiement partiel

- Severity: S2
- Flow / case: F03 / F03-H1
- Screen: fiche document (`/app/documents/:id`)
- Build: 774fce9 Browser / device: Chromium headless, 1280 px

Steps

1. Émettre une facture de 1 200 EUR TTC, ouvrir sa fiche.
2. Saisir 500 dans « Montant (€) », cliquer « Enregistrer le paiement ».

Expected: « Reste dû : 700,00 € » et la ligne du paiement apparaissent.
Actual: l'API répond 201, mais la fiche affiche toujours « Reste dû : 1 200,00 € » et « Aucun paiement enregistré » jusqu'au rechargement (le chargement des paiements ne dépendait que de l'id et du statut, inchangé tant que la facture n'est pas soldée).
Evidence: paiement-relance.test.ts « paiement : montant invalide refusé, partiel puis solde ».
Suspected cause: `useDonnees(..., [doc.id, doc.statut])` sans rechargement explicite.
Status: fixed (apps/web/src/client/ecrans/detail.tsx, `p.recharger()` dans `payer`)

### BUG-002 : l'écran « Page introuvable » n'a pas de titre h1

- Severity: S3
- Flow / case: F12 / F12-N1
- Screen: `/app/*` inconnu
- Build: 774fce9 Browser / device: Chromium, 375 px

Steps

1. Connecté, ouvrir `/app/inconnu`.

Expected: un h1 (repère de navigation, titre d'onglet cohérent).
Actual: seulement un h2 dans l'état vide, titre d'onglet inchangé.
Evidence: audit « aucun titre h1 ». Test publiques.test.ts « écrans introuvables ».
Status: fixed (apps/web/src/client/app.tsx, `PageIntrouvable` : h1 visuellement caché + `useTitrePage`)

### BUG-003 : document introuvable présenté comme une erreur de chargement avec « Réessayer »

- Severity: S3
- Flow / case: F12 / F12-N2, F10-N1
- Screen: `/app/documents/:id`
- Build: 774fce9 Browser / device: Chromium, 375 px

Steps

1. Ouvrir `/app/documents/<id inexistant ou d'un autre compte>`.

Expected: état « introuvable » explicite, retour à la liste.
Actual: « Chargement impossible / introuvable » avec un bouton « Réessayer » qui ne peut jamais réussir.
Status: fixed (apps/web/src/client/ecrans/detail.tsx, état vide « Document introuvable » + lien « Retour aux factures »)

### À vérifier

- Les réponses 404 hors `/app` (`/nope`) sont du texte brut « Page introuvable » sans page habillée (serveur, hors périmètre de ce lot).
- Aucune anomalie de contraste, de nom, de libellé, de cible 24 px ou de débordement sur les écrans connectés et pages publiques, 375/1440 px, clair/sombre (audit automatisé vert).

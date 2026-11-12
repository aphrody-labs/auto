# Tarifs

Prix hors taxes (TVA 20 % en sus), en euros. Source de vérité : `packages/billing/src/plans.ts`
(exposée par `GET /v1/abonnement/plans`). Contact facturation : contact@aphrody.com.

| Plan     | Mensuel HT | Annuel HT               | Essai    |
| -------- | ---------- | ----------------------- | -------- |
| Gratuit  | 0          | 0                       | —        |
| Pro      | 14         | 140 (deux mois offerts) | 30 jours |
| Business | 39         | 390 (deux mois offerts) | —        |

## Quotas

| Ressource                 | Gratuit | Pro   | Business |
| ------------------------- | ------- | ----- | -------- |
| Factures émises par mois  | 10      | 200   | illimité |
| Employés (fiches actives) | 2       | 10    | 50       |
| Stockage (exemplaires)    | 1 Go    | 20 Go | 200 Go   |
| Appels LLM par mois       | 20      | 500   | 5 000    |
| Boîtes mail connectées    | 0       | 2     | 10       |

- Une facture ou un acompte compte dans le mois (heure de Paris) de son émission ; devis et avoirs
  ne comptent pas, un avoir n'est jamais bloqué.
- Quota atteint : réponse **402** `{ "erreur": "quota atteint : 10 factures émises par mois sur le plan Gratuit", "details": [...] }`.
- Abonnement résilié ou impayé définitif (`canceled`, `unpaid`) : retour aux quotas Gratuit, sans
  perte de données. Pendant les relances de paiement Stripe (`past_due`), le plan reste ouvert.
- L'essai de 30 jours ne s'applique qu'à la première souscription Pro du tenant.

## Positionnement (prix du marché, `docs/CONCURRENTS.md`, vérifiés le 2026-10-22)

- **Entrée payante du marché, 9 à 10 € HT** : Abby Start 9, Tiime Initial 9,99, Shine Start 9,
  Qonto Basic 9, Indy Plus 9 (non vérifié). **Milieu de gamme, 15 à 24 €** : Abby Pro 15, Henrri
  Smart 17, Tiime Smart 17,99, Shine Plus 20, Pennylane Essentiel 24. **Haut de gamme TPE, 25 à
  49 €** : Tiime Business 24,99, Evoliz Essentielle 29, Abby Business 33, Shine Business 45, Evoliz
  Avancée 49 ; Pennylane Premium 79.
- **Gratuit** : aligné sur Tiime Free, Abby Basique, Shine Free et Henrri Pro (offres à 0 €).
  Limité à 10 factures par mois : suffit pour tester et pour un très petit volume, sans boîte mail ni
  agent au-delà de 20 appels.
- **Pro à 14 €** : sous le milieu de gamme (15 à 24 €) mais au-dessus de l'entrée à 9 €, parce qu'il
  inclut ce que les offres à 9 € réservent souvent aux formules hautes : Factur-X figé et validé, la
  plateforme agréée, l'API publique (réservée aux formules Business chez Qonto et Tiime), les
  relances, l'audit chaîné. Moins cher que Pennylane Essentiel (24) et Tiime Smart (17,99).
- **Business à 39 €** : entre Abby Business (33) et Shine Business (45), sous Evoliz Avancée (49) et
  Pennylane Premium (79) ; factures illimitées, RH jusqu'à 50 employés, 10 boîtes mail, 5 000 appels
  LLM.
- **Annuel = 10 mois** : remise de 16,7 %, plus lisible que les remises par code (Henrri) ou par
  engagement pluriannuel (Axonaut). Tiime facture l'annuel au prix de douze mois.
- Essai de 30 jours sur Pro, comme la durée la plus longue observée (Evoliz, selon les sources) ;
  Axonaut propose 15 jours.

Les prix des concurrents changent souvent : revoir ce positionnement à chaque mise à jour de
`docs/CONCURRENTS.md`.

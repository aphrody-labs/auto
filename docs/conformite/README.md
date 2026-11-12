# Conformité

> **À faire valider par un juriste.** Ces documents sont des modèles rédigés à partir du fonctionnement
> réel du produit ; ils ne constituent pas un avis juridique. Les mentions entre crochets sont à compléter.

Opérateur : [raison sociale de l'éditeur], contact et exercice des droits : **contact@aphrody.com**.

| Document                                                     | Objet                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| [Registre des traitements](registre-traitements.md)          | Art. 30 RGPD : traitements de l'éditeur et du sous-traitant |
| [Sous-traitants](sous-traitants.md)                          | Sous-traitants ultérieurs, localisation, garanties          |
| [Accord de traitement (DPA)](dpa.md)                         | Art. 28 RGPD : contrat entre le client et l'éditeur         |
| [CGU](cgu.md)                                                | Conditions d'utilisation du service                         |
| [CGV](cgv.md)                                                | Conditions de vente de l'abonnement                         |
| [Mentions légales](mentions-legales.md)                      | LCEN art. 6                                                 |
| [Politique de confidentialité](politique-confidentialite.md) | Information des personnes (art. 13 et 14 RGPD)              |

## Règles mises en œuvre dans le code

- **Isolation** : chaque entreprise (tenant) est isolée par la sécurité au niveau des lignes de Postgres
  (`docs/ARCHITECTURE.md`, invariants).
- **Export** (portabilité, art. 20) : `GET /v1/conformite/export`, archive `tar.gz` avec un JSON par
  table, les exemplaires figés en PDF, un manifeste avec les SHA-256 ; aucun secret (hash de mot de
  passe, jetons, secret 2FA).
- **Suppression** (effacement, art. 17) : `POST /v1/conformite/suppression` par le owner, avec le nom
  exact de l'entreprise et son mot de passe ; délai de grâce de 30 jours, annulable
  (`DELETE /v1/conformite/suppression`). À l'échéance (`executerSuppressionsEchues`, tâche quotidienne) :
  comptes, membres, invitations, brouillons, produits, salariés et absences, clients non facturés sont
  effacés ; les fiches clients facturés sont pseudonymisées.
- **Conservation légale** : les pièces comptables (factures, acomptes, avoirs émis, exemplaires
  Factur-X, paiements, relances, piste d'audit, compteurs) sont conservées **10 ans à compter de la
  clôture de l'exercice** (art. L123-22 du Code de commerce ; le délai fiscal de 6 ans de l'art. L102 B
  du LPF est couvert). Une facture n'est pas pseudonymisée : ses mentions, nom du client compris, sont
  obligatoires (art. L441-9 C. com., art. 242 nonies A annexe II CGI) et l'obligation légale fonde leur
  conservation (art. 17.3.b RGPD). Elles ne sont plus reliées à aucun compte. Au 1er janvier suivant la
  fin de conservation (`purgerConservationsEchues`), le tenant est effacé définitivement ; c'est la seule
  exception à l'immuabilité (fonction SQL `purge_autorisee`).
- **Données RH** : supprimées avec le tenant ; leurs durées propres (registre du personnel 5 ans après
  le départ, bulletins de paie) relèvent de l'employeur, qui exporte ses données avant la suppression.
- **Archivage** : `POST /v1/conformite/archivage` copie les exemplaires figés dans un seau S3 à verrou
  d'objet (rétention par défaut 11 ans, mode COMPLIANCE en production) ; l'empreinte relue est comparée.
- **Sauvegardes** : `bun scripts/sauvegarde.ts` (pg_dump, AES-256-GCM, rotation) et
  `bun scripts/restauration.ts` ; restauration testée sur une base jetable.
- **Journaux et métriques** : un journal JSON par requête (route en motif, statut, durée, tenant opaque),
  `GET /metrics` Prometheus ; ni email, ni IP, ni contenu.
- **Chiffrement au repos** : secrets 2FA et sauvegardes chiffrés par AES-256-GCM, clé dérivée (HKDF) de
  `AUTO_CLE_MAITRE`.

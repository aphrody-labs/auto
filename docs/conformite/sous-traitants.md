# Sous-traitants ultérieurs

> **À faire valider par un juriste.** Liste tenue à jour ; tout ajout est notifié aux clients 30 jours à
> l'avance (voir le [DPA](dpa.md)). Contact : contact@aphrody.com.

| Sous-traitant                  | Prestation                                            | Données concernées                     | Localisation | Garanties                                  | Statut                     |
| ------------------------------ | ----------------------------------------------------- | -------------------------------------- | ------------ | ------------------------------------------ | -------------------------- |
| OVHcloud (OVH SAS, Roubaix)    | Hébergement des serveurs, Postgres, stockage objet S3 | Toutes                                 | France (UE)  | Contrat art. 28, ISO 27001, HDS non requis | prévu                      |
| [Prestataire d'envoi de mails] | Invitations, envoi des factures, relances             | Email du destinataire, contenu du mail | [UE]         | [contrat art. 28]                          | à choisir (lot mail)       |
| [Plateforme agréée (PA)]       | Transmission des factures électroniques               | Factures et leurs mentions             | France       | Immatriculation DGFiP                      | à choisir (lot PA)         |
| [Prestataire de paiement]      | Encaissement des abonnements                          | Contact de facturation, paiements      | [UE]         | PCI DSS, contrat art. 28                   | à choisir (lot abonnement) |

## Ne sont pas des sous-traitants

- **n8n** : logiciel hébergé par l'éditeur sur ses propres serveurs (base séparée), sans transfert.
- **Modèles d'IA** (`llama-server`) : exécutés sur l'infrastructure de l'éditeur, sans transfert.
- **API Recherche d'entreprises** (DINUM, données INSEE) : source publique interrogée par SIREN ; aucune
  donnée du client n'est transmise.

Aucun transfert hors de l'Union européenne n'est prévu. Un transfert éventuel serait encadré par une
décision d'adéquation ou des clauses contractuelles types.

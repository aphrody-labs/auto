# Mise en service : factures fournisseurs, chantiers et paiements

Contenu du dossier :

| Fichier                                   | Rôle                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Classeur_Factures_Fournisseurs.xlsx`     | Journal des factures, suivi des paiements, tableau de bord, exports comptables                    |
| `Workflow_n8n_Factures_Fournisseurs.json` | Workflow n8n : lecture des scans par Claude, ajout au Journal, rangement, récapitulatif quotidien |

## 1. Le classeur

1. Placez le classeur dans **OneDrive** (le nœud Excel de n8n passe par Microsoft Graph).
2. Ouvrez-le dans Excel : les formules se calculent à l'ouverture.
3. Lisez l'onglet **Légende**.
4. Remplacez les données d'exemple (colonne _Source_ = `EXEMPLE`) :
   - onglets **Fournisseurs** et **Chantiers** : vos référentiels ;
   - onglets **Journal** et **Paiements** : supprimez les lignes d'exemple (clic droit sur la ligne du tableau > Supprimer > Lignes du tableau).

Circuit d'une facture : `Journal` (saisie ou n8n) > `Suivi` (calculs) > `Tableau_de_bord`. Un règlement se saisit dans `Paiements` en choisissant la **Clé facture** dans la liste.

## 2. Le workflow n8n

Prérequis (n8n 2.x) :

1. Définir la variable d'environnement `NODES_EXCLUDE=[]`, puis redémarrer n8n. Sans cela, les nœuds _Local File Trigger_ et _Execute Command_ ne se chargent pas.
2. Créer trois credentials :
   - **Header Auth** : nom `x-api-key`, valeur = votre clé API Anthropic ;
   - **Microsoft Excel OAuth2** ;
   - **SMTP** (facultatif, pour les e-mails).
3. Dans le partage réseau, créer `A_traiter`, `Traitees` et `Erreurs`.
4. n8n doit pouvoir lire et écrire dans ce partage. Si n8n tourne dans Docker, montez le dossier en volume et mettez `systeme` = `linux` dans le nœud _Paramètres_.

Importer le fichier JSON (menu `...` > Import from file), puis :

1. Nœud **Nouveau scan** : saisir le chemin de `A_traiter`.
2. Nœud **Paramètres** : `racine` = dossier parent des trois sous-dossiers, `systeme`, `emailAlerte`.
3. Nœud **Claude : extraire la facture** : choisir le credential Header Auth.
4. Nœuds **Ajouter au Journal Excel** et **Lire la feuille Suivi** : choisir le credential, le classeur, la feuille et la table (`tblJournal`).
5. Activer les nœuds e-mail une fois SMTP configuré.
6. Tester avec un scan, puis publier le workflow.

## 3. Ce que fait le workflow

- **Bloc A** : un scan arrive dans `A_traiter`. Claude lit le PDF ou l'image. Le code vérifie HT + TVA = TTC et les champs obligatoires. La ligne est ajoutée au Journal. Le fichier est rangé dans `Traitees/<chantier>/<année>`, ou dans `Erreurs` en cas de doute (la ligne est alors marquée _À VÉRIFIER_).
- **Bloc B** : chaque matin à 8 h, un e-mail liste les factures en retard, à payer sous 7 jours, en litige ou à vérifier. Rien n'est envoyé s'il n'y a rien à signaler.

## 4. Points d'attention

- **Confidentialité** : les factures sont envoyées à l'API Claude pour lecture. Vérifiez que cela convient à vos obligations (RGPD, clients, fournisseurs).
- **Coût** : chaque facture lue consomme des jetons de l'API.
- **Code chantier** : la référence lue sur la facture ne correspond pas toujours à vos codes. Dans ce cas la facture est classée `A_AFFECTER` : corrigez le code chantier dans le Journal.
- **Fournisseur** : reconnu par SIRET, puis par nom exact. Sinon, il apparaît comme `À CRÉER` : ajoutez-le dans l'onglet Fournisseurs.
- **Un fichier à la fois** : le workflow traite un scan par exécution (un déclenchement par fichier déposé).
- **Ce qui n'a pas été testé** : le workflow n'a pas été exécuté dans une instance n8n, ni le classeur ouvert dans Excel. Les formules ont été vérifiées avec LibreOffice, le code JavaScript avec Node. Faites un premier essai sur 2 ou 3 factures réelles.

# Accord de traitement des données (DPA, art. 28 RGPD)

> **À faire valider par un juriste.** Modèle annexé aux CGV.

Entre **le Client** (responsable de traitement), entreprise abonnée au service auto, et
**[raison sociale de l'éditeur]** (sous-traitant), contact : contact@aphrody.com.

## 1. Objet

Le sous-traitant traite, pour le compte du Client, les données personnelles saisies dans le service :
clients et prospects (facturation), salariés (gestion du personnel), utilisateurs invités.

## 2. Description du traitement

| Élément   | Contenu                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| Nature    | Hébergement, stockage, calcul, génération de documents, transmission                |
| Finalités | Facturation électronique, gestion commerciale, gestion du personnel, automatisation |
| Personnes | Clients, prospects, salariés et utilisateurs du Client                              |
| Données   | Voir le [registre](registre-traitements.md), section B                              |
| Durée     | Durée du contrat, puis conditions de l'article 9                                    |

## 3. Obligations du sous-traitant

Le sous-traitant :

1. traite les données sur instruction documentée du Client (le paramétrage du service vaut instruction) ;
2. garantit la confidentialité : personnel habilité, soumis à une obligation de confidentialité ;
3. met en œuvre les mesures de l'article 7 ;
4. ne recourt à un sous-traitant ultérieur qu'avec l'autorisation générale du Client, en l'informant
   30 jours avant tout changement ([liste](sous-traitants.md)) ; le Client peut s'y opposer et résilier ;
5. aide le Client à répondre aux demandes d'exercice des droits (export complet, rectification dans
   l'interface, suppression) ;
6. aide le Client pour la sécurité, les analyses d'impact et la notification des violations ;
7. tient à disposition les informations nécessaires aux audits, une fois par an, avec un préavis de
   30 jours, aux frais du Client ;
8. informe le Client si une instruction lui paraît contraire au RGPD.

## 4. Violation de données

Notification au Client **sans délai injustifié et au plus tard 48 heures** après en avoir pris
connaissance, avec la nature de la violation, les catégories et le nombre approximatif de personnes,
les conséquences probables et les mesures prises.

## 5. Localisation

Données hébergées dans l'Union européenne (France). Aucun transfert hors UE sans accord écrit et
garanties appropriées.

## 6. Obligations du Client

Le Client fonde ses traitements sur une base légale, informe les personnes concernées, ne saisit pas de
données sensibles inutiles (notamment dans les motifs d'absence) et gère les droits de ses utilisateurs.

## 7. Mesures de sécurité

Isolation des données de chaque client au niveau des lignes (RLS Postgres) ; chiffrement TLS ;
secrets chiffrés au repos (AES-256-GCM) ; mots de passe hachés (Argon2) ; double authentification
disponible ; piste d'audit chaînée et documents émis immuables ; sauvegardes chiffrées quotidiennes avec
rotation et restauration testée ; archivage objet à verrou ; journaux techniques sans données
personnelles ; moindre privilège.

## 8. Export

Le Client exporte à tout moment l'ensemble de ses données (`GET /v1/conformite/export`, archive JSON et
PDF).

## 9. Fin du contrat

À la demande de suppression (délai de grâce de 30 jours) ou au terme du contrat, le sous-traitant efface
les données, à l'exception des pièces comptables que le Client est tenu de conserver 10 ans (art.
L123-22 C. com.) : elles sont conservées, détachées de tout compte, jusqu'au terme de ce délai, puis
effacées. Les sauvegardes sont effacées par rotation (14 jours) [à ajuster].

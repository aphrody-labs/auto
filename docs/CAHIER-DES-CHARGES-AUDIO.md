# Cahier des charges extrait de `var/goal.ogg`

Cette note reformule le contenu de l’enregistrement fourni par le propriétaire du projet. La transcription automatique brute est conservée dans `.cache/goal-transcription.log` ; les noms propres et quelques mots de l’audio restent incertains.

## Besoin exprimé

L’entreprise de BTP reçoit des devis et des factures, sur papier ou par courriel. Les documents sont aujourd’hui traités et suivis principalement dans Excel. L’application doit récupérer les documents depuis le serveur de fichiers et les courriels autorisés, en extraire les informations utiles, puis les classer dans des espaces distincts : comptabilité fournisseurs, comptabilité clients, analytique par chantier, bons de livraison et confirmations de commande.

Elle doit aussi retrouver et archiver les documents dans les dossiers réseau, limiter chaque espace aux personnes concernées, et permettre de travailler les données sous forme de tableaux proches des usages Excel. Les classeurs doivent pouvoir être exportés en PDF.

L’entreprise compte jusqu’à cinq personnes. L’accès au réseau et aux documents doit leur éviter de chercher manuellement les factures par date ou de vérifier si chaque pièce a déjà été archivée. L’automatisation prépare et classe les informations pour revue par l’équipe.

## Transcription automatique brute

Le texte ci-dessous provient d’une reconnaissance vocale automatique ; il peut contenir des erreurs de mots ou de noms propres.

> J’ai fait une petite recherche, du coup en gros, là ce qu’il faut, c’est ce que je l’ai trouvé qui est en bloc en haut mais en gros, donc ils ont un serveur en OVH en local, ils ont un serveur avec leur fichier dedans.
>
> Le truc sur lequel on travaille, c’est quand il reçoit un devis ou une facture, soit il le scanne ou alors il le sort par mail et là il le met dans la base de données du coup, et là il va aller saisir automatiquement les factures et les devis.
>
> Et extraire les documents, extraire les informations et les séparer dans le tableau Excel, voilà donc le tableau Excel avec plusieurs compartiments pour que ça reste visible, c’est pour ça que j’ai séparé.
>
> Surtout par rapport à la compta, pour la compta, il faudra séparer en une page, enfin un espace comptabilité fournisseur, un espace comptabilité client et un espace comptabilité analytique chantier et après un espace bon de livraison et un espace confirmation commande, vu que c’est à chaque fois des informations et des documents différents.
>
> Et surtout ce n’est pas les mêmes personnes qui vont travailler sur ça. La compta est séparée en plusieurs catégories et ce n’est pas les mêmes personnes qui font les différentes parties de la compta.
>
> Et après du coup, il y a aussi le fait qu’avec l’accès au réseau, elle puisse retrouver n’importe quel dossier dans le workflow tout simplement vu qu’elle a accès à l’ensemble des documents.
>
> Comme ça il n’y a plus besoin de chercher des factures ou des trucs avec la date ou même si elles ne sont pas archivées, elle va arriver à les voir quand même.
>
> Là il y a toutes les infos, dans l’entreprise du coup ils peuvent être cinq maximum. Je crois que c’est bon. Et du coup ils font tout sur Excel, absolument tout sur Excel.
>
> Donc là tout ce qu’on va pouvoir dire à Alia, tous les outils, tous ces moments, full Excel. Et après du coup pouvoir convertir les fichiers Excel en PDF.
>
> J’ai coupé là.

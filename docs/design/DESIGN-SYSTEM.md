# Design system « auto »

Direction : sobre, dense, lisible, de confiance (finance B2B). Style plat à bordures fines, sans verre dépoli ni dégradés (le style Glassmorphism proposé par l'outil de recherche a été écarté : contraste instable, inadapté à des tableaux de chiffres). Original : aucune couleur, police ni logo de Pennylane ou d'Abby.

Source unique : `packages/ui/src/tokens.ts` (`@auto/ui`), aligné sur Material 3 : les couleurs sont les rôles `--md-sys-color-*` que `@aphrody/m3-tokens` dérive de la graine de marque #0F6B5C (schéma `tonalSpot`, clair et sombre). Succès et avertissement sont des couleurs personnalisées M3 tirées de leurs propres graines. `tokens.css` en est généré (`bun packages/ui/src/gen.ts`) et un test vérifie l'identité exacte. Les composants consomment les alias `--auto-*` (ou directement les rôles `--md-sys-color-*`), jamais d'hexadécimal brut ; il n'existe pas de palette parallèle.

## Couleurs (contrastes WCAG vérifiés par `tokens.test.ts`)

| Jeton            | Rôle M3                                   | Clair   | Sombre  | Usage                               |
| ---------------- | ----------------------------------------- | ------- | ------- | ----------------------------------- |
| fond             | `surface`                                 | #f5fbf7 | #0e1513 | arrière-plan de page                |
| surface          | `surface-container-lowest`                | #ffffff | #090f0e | cartes, tableaux                    |
| surface-alt      | `surface-container-high`                  | #e3eae6 | #252b29 | en-têtes de tableau, survol         |
| bordure          | `outline-variant`                         | #bec9c5 | #3f4946 | séparateurs (décoratif)             |
| bordure-controle | `outline`                                 | #6f7976 | #89938f | champs, cases (seuil 3:1)           |
| texte            | `on-surface`                              | #171d1b | #dee4e0 | texte principal                     |
| texte-attenue    | `on-surface-variant`                      | #3f4946 | #bec9c5 | texte secondaire (seuil 4,5:1)      |
| primaire         | `primary`                                 | #056b5b | #84d6c2 | action principale                   |
| sur-primaire     | `on-primary`                              | #ffffff | #00382f | texte sur primaire                  |
| focus            | `primary`                                 | #056b5b | #84d6c2 | anneau 2 px + décalage 2 px, >= 3:1 |
| danger           | `error`                                   | #ba1a1a | #ffb4ab | erreurs, suppression                |
| sur-danger       | `on-error`                                | #ffffff | #690005 | texte sur danger                    |
| succes           | couleur personnalisée M3 (graine #1E8E3E) | #37693d | #9dd49e | confirmations                       |
| avertissement    | couleur personnalisée M3 (graine #B26A00) | #855317 | #fcb974 | alertes (mentions manquantes)       |

Règles : un seul bouton primaire par écran ; la couleur ne porte jamais seule le sens (statut = pictogramme + libellé) ; survol, pression et focus passent par les calques d'état M3 (opacité du rôle `on-*` sur le conteneur), pas par des couleurs supplémentaires ; le thème sombre est le schéma sombre M3 de la même graine.

### Statuts (badge : `on-*-container` sur `*-container`, >= 4,5:1 testé)

| Statut                    | Libellé                     | Pictogramme                           | Rôle M3                              | Clair (texte / fond) |
| ------------------------- | --------------------------- | ------------------------------------- | ------------------------------------ | -------------------- |
| brouillon                 | Brouillon                   | pencil                                | neutre (`surface-container-highest`) | #3f4946 / #dee4e0    |
| emis                      | Émise                       | file-check                            | `primary-container`                  | #005144 / #a0f2de    |
| envoye                    | Envoyée                     | send                                  | `tertiary-container`                 | #2b4a5f / #c8e6ff    |
| accepte, paye             | Acceptée, Payée             | circle-check, banknote                | succès (container)                   | #1e5027 / #b8f0b8    |
| refuse, rejete, en_retard | Refusée, Rejetée, En retard | circle-x, triangle-alert, clock-alert | `error-container`                    | #93000a / #ffdad6    |
| depose                    | Déposée                     | upload                                | avertissement (container)            | #693c00 / #ffdcbd    |
| annule                    | Annulée                     | ban                                   | neutre (`surface-container-highest`) | #3f4946 / #dee4e0    |

`en_retard` est dérivé (échéance dépassée et non payé), il n'existe pas dans `Statut` du domaine.

## Typographie (polices libres, licence OFL)

- Titres : Plus Jakarta Sans 600/700. Corps et données : Inter 400/500/600, `font-variant-numeric: tabular-nums` sur tous les montants, numéros et dates.
- Échelle : 12 / 14 / 16 / 18 / 24 / 32 px ; corps 16 px (tableaux denses 14 px), interligne 1,5 (titres 1,25). Longueur de ligne 60-75 caractères.
- Auto-hébergement des polices (`font-display: swap`), pas de CDN tiers (RGPD).
- Montants alignés à droite, format `Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })`.

## Espacement, rayons, ombres, mouvement

- Espacement base 4 px : 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Densité « tableau de bord » : lignes de tableau 40 px, gouttière 16 px (24 px en bureau).
- Rayons (jetons M3 `--md-sys-shape-corner-*`) : 4 extra-small (badges, cases), 8 small (champs, boutons), 12 medium (cartes, modales), full (pastilles).
- Ombres (élévation M3 `--md-sys-elevation-level1..3`) : sm (cartes au repos), md (menus), lg (modales). Bordure fine préférée à l'ombre en surface.
- Mouvement (jetons M3 `--md-sys-motion-*`) : 150 ms short3 (retour d'état, sortie), 200 ms short4 (entrée), courbe `easing-standard`, transform et opacité seulement ; 0 ms sous `prefers-reduced-motion`.
- Points de rupture : classes de fenêtre M3 de `@aphrody/m3-tokens/breakpoints` (600, 840, 1200, 1600) ; mise en page testée dès 375 px. Conteneur max 1200 px. Z-index : 0, 10 (collant), 20 (menu), 40 (modale), 100 (toast).
- Cibles tactiles >= 44 px sur mobile (minimum absolu 24 px sur bureau). Icônes : Lucide (libre), trait 1,5 px, tailles 16/20/24.

## Composants et états

États communs : repos, survol (fond surface-alt), focus-visible (anneau focus), actif, désactivé (opacité 0,5, `aria-disabled`), chargement (bouton désactivé + indicateur), erreur.

### Tableau de factures (S04, S05)

- Colonnes : numéro, client, date, échéance, montant TTC (droite, tabulaire), statut (badge), actions. En-têtes `<th scope>` ; tri avec `aria-sort`.
- États : squelette (>1 s), vide (texte + bouton « Créer une facture »), erreur (message + « Réessayer »), sélection (barre d'actions en masse), ligne en retard (badge + date d'échéance en `danger`).
- Mobile : lignes en cartes empilées, jamais de défilement horizontal de la page. Virtualisation au-delà de 50 lignes.

### Éditeur de facture (S06)

- Structure : en-tête (émetteur, client, dates), lignes, bloc totaux collant, aperçu PDF en panneau latéral (>= 1024 px) ou onglet.
- Ligne : désignation, quantité, unité, PU HT, TVA (0 / 2,1 / 5,5 / 10 / 20 %), total HT. Ajouter (bouton visible), supprimer (confirmation avec annulation), réordonner (poignée + boutons haut/bas au clavier).
- Totaux : HT, TVA par taux, TTC, calculés par `@auto/domain` (centimes entiers) ; jamais recalculés côté composant.
- Franchise TVA : bandeau d'information avec la mention art. 293 B ; colonnes TVA masquées.
- Mentions manquantes : bandeau avertissement + résumé d'erreurs focalisable listant chaque champ.
- Émis : lecture seule, action unique « Créer un avoir ». Brouillon : enregistrement automatique, confirmation avant fermeture avec modifications non sauvegardées.

### Statuts

Badge pilule : pictogramme 16 px + libellé 14 px/500, fond et texte du tableau ci-dessus. Statut lisible aussi par lecteur d'écran (`Statut : En retard`). Changement de statut annoncé via région `aria-live="polite"`.

### Formulaire client (S11)

- Libellés visibles au-dessus, aide persistante, astérisque + « obligatoire » pour les requis, validation à la sortie du champ, erreur sous le champ liée par `aria-describedby`.
- SIREN/SIRET : saisie masquée par groupes, vérification Luhn (domaine `siretValide`), préremplissage via `/v1/siren/:siren` avec indicateur de chargement ; `autocomplete` adapté (email, tel, adresse).
- États du champ : repos (bordure-controle), focus, rempli, erreur (bordure danger + icône + texte), lecture seule (fond surface-alt, distinct du désactivé).
- Soumission : bouton en chargement, toast de succès (3-5 s, `aria-live`, sans vol de focus) ; échec : résumé d'erreurs focalisé.

### Tableau de bord (S03)

- Quatre cartes KPI : encours, en retard, encaissé du mois, devis en attente. Valeur 24 px tabulaire, libellé 14 px, variation avec pictogramme (pas la couleur seule).
- Liste « à traiter » (retards, brouillons anciens) avec action directe ; graphique mensuel en barres avec légende, infobulles accessibles au clavier, alternative tableau, palette distinguable sans la couleur (motifs).
- États : squelette, vide guidé (« Créez votre première facture »), erreur avec nouvelle tentative.

### Autres

Bouton (primaire, secondaire, danger, fantôme), modale (focus piégé, Échap, retour du focus), toast, onglets, menu d'actions (ouvre au clavier), stepper d'onboarding (retour possible), timeline de document, pagination.

## Accessibilité (obligatoire)

Contraste AA testé automatiquement ; navigation clavier complète, lien d'évitement, hiérarchie de titres, focus jamais masqué par l'en-tête collant, `prefers-reduced-motion` et `prefers-color-scheme` respectés, texte redimensionnable à 200 % sans perte, pas de défilement horizontal à 375 px.

## Utilisation

```css
@import "@auto/ui/tokens.css";
.bouton-primaire {
  background: var(--auto-primaire);
  color: var(--auto-sur-primaire);
}
```

```ts
import { palettes, statuts, contraste } from "@auto/ui";
```

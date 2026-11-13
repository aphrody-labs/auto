# Chrome Web Store Listing — auto : factures fournisseurs

> Last Updated: 2026-10-22

## Store Listing

**Extension Name**
auto : factures fournisseurs

**Short Description** (≤ 132 caractères)
Envoie en un clic droit une facture PDF ou Factur-X à auto, et affiche les factures fournisseurs à vérifier.

**Detailed Description**

Récupérez vos factures fournisseurs là où elles se trouvent, sans les télécharger ni les ranger à la main : un clic droit sur le lien de la facture, et elle arrive dans auto.

Ce que fait l'extension :
Envoi en un clic droit d'une facture PDF ou XML (Factur-X, CII) depuis l'espace client d'un fournisseur, un portail ou un lien reçu par email.
Lecture automatique : une facture électronique Factur-X est lue directement ; une facture PDF classique est analysée et mise de côté si un champ doit être contrôlé.
Doublons reconnus : une facture déjà envoyée n'est pas enregistrée deux fois.
Compteur sur l'icône : le nombre de factures à vérifier dans auto, mis à jour toutes les 15 minutes.
Instance au choix : auto.aphrody.com ou votre serveur auto auto-hébergé.

Comment l'utiliser :

1. Dans auto, ouvrez Paramètres puis Jetons API et créez un jeton.
2. Cliquez sur l'icône de l'extension, collez le jeton et choisissez « Enregistrer et tester ».
3. Sur un site, faites un clic droit sur le lien d'une facture et choisissez « Envoyer la facture à auto ». Une notification confirme l'envoi.

Confidentialité : l'extension ne lit pas les pages que vous visitez et n'enregistre pas votre historique. Elle ne télécharge que le fichier que vous désignez, et l'envoie uniquement à votre instance auto. Votre jeton reste sur votre appareil. L'accès à un autre site n'est demandé qu'au moment où vous envoyez une facture hébergée sur ce site.

Aide et contact : contact@aphrody.com.

**Category**
Productivity

**Single Purpose**
Envoyer les factures fournisseurs trouvées sur le web vers le compte auto de l'utilisateur et afficher celles qui restent à vérifier.

**Primary Language**
Français

## Graphics & Assets

| Asset            | Dimensions  | Status | Filename                                                   |
| ---------------- | ----------- | ------ | ---------------------------------------------------------- |
| Store Icon       | 128×128 PNG | Ready  | `dist/icons/icon-128.png` (généré par `bun run build`)     |
| Screenshot 1     | 1280×800    | Ready  | `store/capture-1.png` (généré par `bun run captures`)      |
| Screenshot 2     | 1280×800    | Ready  | `store/capture-2.png`                                      |
| Screenshot 3     | 1280×800    | Ready  | `store/capture-3.png` (test `apps/web/e2e/recues.test.ts`) |
| Small Promo Tile | 440×280     | Ready  | `store/promo-440x280.png`                                  |

### Screenshot Notes

1. Popup connectée : « Acheteur SARL : 3 facture(s) à vérifier. » et le lien vers les factures reçues.
2. Popup à configurer : adresse de l'instance et jeton API.
3. Écran « Factures reçues » d'auto : une facture validée, une facture à vérifier avec son anomalie, boutons Valider et Rejeter.

Le menu contextuel et la notification système ne se capturent pas en navigateur sans interface : à ajouter à la main
si souhaité (capture d'écran de Chrome au moment du clic droit).

## Permissions Justification

| Permission                                 | Type                      | Justification                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                | permissions               | Quand l'utilisateur choisit « Envoyer la facture à auto » dans le menu du clic droit, l'extension télécharge le fichier de facture de la page en cours avec les droits de connexion de l'utilisateur sur ce site (espaces clients fournisseurs). Aucun accès sans ce clic. |
| `contextMenus`                             | permissions               | Ajoute l'entrée « Envoyer la facture à auto » au clic droit sur un lien, et sur une facture PDF ou XML ouverte dans le navigateur.                                                                                                                                         |
| `storage`                                  | permissions               | Conserve sur l'appareil l'adresse de l'instance auto, le jeton API de l'utilisateur et le dernier nombre de factures à vérifier.                                                                                                                                           |
| `alarms`                                   | permissions               | Met à jour toutes les 15 minutes le compteur de factures à vérifier affiché sur l'icône.                                                                                                                                                                                   |
| `notifications`                            | permissions               | Confirme chaque envoi (facture enregistrée, à vérifier, déjà reçue) ou en explique l'échec ; sans cela, l'action du clic droit serait silencieuse.                                                                                                                         |
| `https://auto.aphrody.com/*`               | host_permissions          | Envoi des factures et lecture du compteur sur le service auto, avec le jeton de l'utilisateur.                                                                                                                                                                             |
| `https://*/*`                              | optional_host_permissions | Demandée site par site, au moment où l'utilisateur envoie une facture hébergée sur un autre site que la page ouverte, ou quand il configure une instance auto auto-hébergée. Jamais demandée en bloc.                                                                      |
| `http://localhost/*`, `http://127.0.0.1/*` | optional_host_permissions | Instance auto installée sur le poste de l'utilisateur (auto-hébergement, essais).                                                                                                                                                                                          |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes

| Data Type                    | Collected?                                      | Transmitted Off-Device?                                                                         | Purpose                                                 | Shared with Third Parties? |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| Personally identifiable info | No                                              | No                                                                                              |                                                         | No                         |
| Health info                  | No                                              | No                                                                                              |                                                         | No                         |
| Financial info               | Yes : factures choisies par l'utilisateur       | Yes : vers l'instance auto de l'utilisateur uniquement                                          | Enregistrer la facture fournisseur dans sa comptabilité | No                         |
| Authentication info          | Yes : jeton API auto                            | No (reste sur l'appareil ; envoyé seulement comme en-tête d'authentification à l'instance auto) | Authentifier les envois                                 | No                         |
| Personal communications      | No                                              | No                                                                                              |                                                         | No                         |
| Location                     | No                                              | No                                                                                              |                                                         | No                         |
| Web history                  | No                                              | No                                                                                              |                                                         | No                         |
| User activity                | No                                              | No                                                                                              |                                                         | No                         |
| Website content              | Yes : le seul fichier désigné par l'utilisateur | Yes : vers l'instance auto                                                                      | Enregistrer la facture                                  | No                         |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**
https://auto.aphrody.com/confidentialite (section « Extension Chrome »). À faire valider par un juriste avant soumission, comme les autres documents de `docs/conformite/`.

## Distribution

**Visibility**: Unlisted jusqu'à la sortie de préproduction, puis Public
**Regions**: France, Belgique, Luxembourg, Suisse (utilisateurs francophones de la facturation électronique française)

## Developer Info

**Publisher Name**
Aphrody

**Contact Email**
contact@aphrody.com

**Support URL / Email**
contact@aphrody.com

**Homepage URL**
https://auto.aphrody.com

## Version History

| Version | Date       | Résumé                                                                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0   | 2026-10-22 | Première version : envoi par clic droit (lien ou page PDF/XML), compteur des factures à vérifier, réglages de l'instance et du jeton. |

## Publishing Readiness

- [x] Manifest V3, permissions minimales (`activeTab`, accès aux autres sites demandé au cas par cas)
- [x] Icônes 16, 32, 48, 128 générées aux bonnes dimensions (test `construire.test.ts`)
- [x] Paquet : `bun run paquet` → `dist/auto-extension-<version>.zip` (seulement les fichiers de `dist/`, sans sources ni `CHROMEWEBSTORE.md`)
- [x] Testée chargée dans Chrome : dépôt d'une facture Factur-X, doublon, badge (`e2e/extension.test.ts`)
- [x] Politique de confidentialité publiée
- [ ] Validation juridique de la politique et identité légale complète de l'éditeur
- [x] Captures 1280×800 et vignette 440×280 (`bun run captures`, `store/`)
- [ ] Compte développeur Chrome Web Store (frais d'inscription uniques) et soumission

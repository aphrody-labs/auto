# Plan UI d'auto : piles Rust natives et web

Évaluation du 2026-11-12, sans réécriture. Surfaces actuelles : `apps/web` (React, Tailwind 4, Material 3, servi par
`Bun.serve`), `apps/desktop` (Tauri, WebView), `apps/extension` (Chrome MV3), build Android par Tauri. Étoiles et
dernier push relevés sur l'API GitHub le jour même ; miroirs locaux : `third_party/dioxus`,
`third_party/dioxus-labs/{blitz,parley,vello}`, `third_party/gpui-component`.

## Couverture et maturité

| Projet             | Rôle                                        | Plates-formes                                                           | Version (miroir)   | Étoiles | Dernier push | Licence           |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------- | ------------------ | ------: | ------------ | ----------------- |
| dioxus             | framework réactif (RSX, signaux, fullstack) | web (wasm), SSR, desktop et mobile (WebView), natif via blitz           | 0.8.0-alpha.3      |  39 731 | 2026-11-11   | MIT ou Apache-2.0 |
| blitz              | moteur HTML/CSS natif (Stylo, Taffy)        | Windows, macOS, Linux, Android ; iOS en cours                           | 0.3.0-beta.4       |   4 450 | 2026-11-12   | MIT ou Apache-2.0 |
| taffy              | mise en page flexbox, grid, block           | toutes (bibliothèque pure)                                              | stable             |   3 774 | 2026-11-11   | MIT               |
| vello              | rendu 2D GPU (wgpu, compute)                | toutes où wgpu tourne, web par WebGPU                                   | 0.11.0             |   4 490 | 2026-11-11   | MIT ou Apache-2.0 |
| parley             | mise en forme et édition de texte           | toutes (bibliothèque pure)                                              | 0.12.0             |     785 | 2026-11-12   | MIT ou Apache-2.0 |
| anyrender          | abstraction de rendu 2D (vello, skia, CPU)  | toutes                                                                  | -                  |     119 | 2026-11-12   | Apache-2.0        |
| dioxus-components  | composants accessibles (style shadcn)       | celles de dioxus                                                        | -                  |     355 | 2026-10-24   | Apache-2.0        |
| gpui-kit           | composants GPUI (ex gpui-component), 75+    | Windows, macOS, Linux ; web en wasm32                                   | 0.9.1              |  20 467 | 2026-11-12   | Apache-2.0        |
| gpui-fast          | GPUI extrait de Zed, publié seul            | Windows, macOS, Linux (Vulkan), web                                     | 0.1.14 (crates.io) |     593 | 2026-11-12   | Apache-2.0        |
| nsh (Native Shell) | UI déclarative rendue en vues natives       | iOS 15+, Android 8+, macOS 14+, Windows 10, Linux GTK 4, web, GPUI, TUI | -                  |   2 601 | 2026-11-12   | Apache-2.0        |

## Adéquation par surface

| Surface d'auto                   | Dioxus (web, WebView, blitz)                                                             | gpui-kit / gpui-fast                                                   | nsh                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Tableau de bord web              | bon : wasm + SSR, mais réécrit React, Material 3 et la suite Craft (wasm déjà)           | faible : rendu canvas en wasm, SEO, accessibilité web et liens limités | moyen : sortie HTML, jeune côté web                               |
| Application de bureau            | bon en WebView (même code que le web) ; blitz encore en bêta pour les formulaires denses | très bon : natif, rapide, éditeurs, tableaux virtualisés, AccessKit    | moyen : vues natives par OS, backend GPUI en développement        |
| Mobile (iOS, Android)            | moyen : WebView par dioxus-mobile ; blitz Android utilisable, iOS non                    | absent                                                                 | très bon : UIKit et Android views, intégrable dans une app native |
| Extension navigateur             | moyen : wasm possible, mais le popup HTML actuel est plus simple                         | inadapté                                                               | inadapté                                                          |
| Écrans d'automatisation (graphe) | bon : canvas vello ou SVG, état partagé avec le web                                      | très bon : canvas GPU, performances d'éditeur                          | moyen : primitives canvas                                         |

## Recommandation

1. Web : garder la pile actuelle (React, Tailwind, M3) ; aucun gain à réécrire le tableau de bord tant que le moteur Rust
   d'automatisation n'existe pas.
2. Bureau : prototyper un client gpui-kit (sur gpui-fast) pour la boîte de réception, les factures et l'éditeur de
   workflows, au-dessus de l'API HTTP existante ; il remplacerait Tauri là où la WebView limite (listes longues, OCR).
3. Mobile : évaluer nsh pour une app de capture (photos de factures, notifications), seul candidat natif iOS et Android.
4. Dioxus et blitz : à suivre ; choix à revoir quand blitz sort de bêta et quand dioxus 0.8 est stable. Taffy, parley et
   vello restent utiles comme bibliothèques (mise en page et rendu des PDF et du graphe), quel que soit le framework.
5. Toute surface suit la règle Design-First du dépôt (cahier des charges et `DESIGN.md` avant le code).

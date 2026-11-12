## Objet

<!-- Ce que change la PR et pourquoi. Lier l'issue : Fixes #… -->

## Vérifications

- [ ] `bun run gates` passe (Postgres démarré)
- [ ] `bun run gates:rust` passe si du Rust est modifié
- [ ] `bun run validate:facturx` passe si la facturation ou Factur-X est touchée
- [ ] Nouvelle migration : numérotée, idempotente, politiques RLS incluses
- [ ] Aucun secret, aucune donnée client réelle

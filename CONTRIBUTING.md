# Contribuer

## Environnement

- Runtime [Aphrody](https://aphrody.app) (fork de Bun) : `bun check`, `bun lint` et `bun fmt` sont natifs.
- Postgres de dev : `docker compose up -d postgres` (port 5433), puis `bun run migrate`.
- Rust : compilé et testé dans le conteneur Linux (`scripts/cargo.sh`).

## Règles

- Code, commentaires, commits et documentation en français.
- Une branche par sujet, PR fusionnée en squash ; message de commit à l'impératif décrivant le résultat.
- Les gates passent avant toute PR : `bun run gates`, et `bun run gates:rust` si du Rust change.
- Migrations SQL : nouveau fichier numéroté dans `packages/store/migrations/`, jamais de modification d'une migration appliquée, RLS sur toute table de tenant.
- Pas de secret ni de donnée client réelle dans le dépôt, les tests ou les issues.

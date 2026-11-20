# auto

Merged into [`aphrody-dev/ay`](https://github.com/aphrody-dev/ay) on 2026-11-19 and archived. Nothing is maintained here.

| Former path | Path in ay |
| :--- | :--- |
| `apps/{cli,desktop,extension,server,ui}` | `apps/auto-{cli,desktop,extension,server,ui}` |
| `packages/{client,domain,i18n,native,platform,services,store}` | `packages/auto-<name>` |
| `src/index.ts` (`@aphrody/auto`) | `packages/auto` |
| `crates/*` | `crates/auto-sdk` (the former crates are its features) and `crates/auto-ffi` |
| `auto.toml`, `wrangler.jsonc`, `.env.production.example` | `apps/auto-server/` |
| `scripts/*` | `tools/auto-*.ts` |
| `locales/fr` | `locales/fr` |
| `docs/`, README, CONTRIBUTING, SECURITY, NOTICE, LICENSE | `docs/auto/` |
| `.github` | `.github/workflows/auto.yml`, `.github/ISSUE_TEMPLATE`, `.github/PULL_REQUEST_TEMPLATE/auto.md` |
| `third_party/better-auth` | `third_party/better-auth` (submodule, `submodules.toml`) |

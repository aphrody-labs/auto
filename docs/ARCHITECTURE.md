# Architecture

Auto separates business logic, persistence, cryptography, and UI into composable libraries and deployable binaries.

## Dual Runtime Modes (`AUTO_MODE`)

| Responsibility              | `serverless` (Cloudflare Workers)              | `self-hosted` (Bun / Rust binary)         |
| --------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Global Auth, Tenants, Users | Cloudflare D1 (`DB`)                           | Local SQLite (`auto.sqlite`)              |
| Per-Company Isolation       | `CompanyDO` Durable Object SQLite              | Scoped SQLite (`withCompany`)             |
| Realtime WebSocket Sync     | `CompanyDO` Hibernatable WebSockets            | Bun `ServerWebSocket` fan-out             |
| Scheduled Jobs & Retries    | `CompanyDO::alarm()` & `AutomationWorkflow`    | In-process interval dispatcher            |
| Binary Storage              | R2 (`aphrody-assets` under `auto/assets/`)     | Local `data/blobs/` directory             |
| Release Artifacts           | R2 (`aphrody-releases` under `auto/releases/`) | HTTP proxy or R2 bucket                   |
| Cryptographic Auth & PDFs   | Rust `auto-ffi` WASM (`auto_ffi_bg.wasm`)      | Native Rust (`aphrody_auto` / `auto-ffi`) |

## Synchronization Protocol

1. Every write records an entry in `_changes` tagged with a Hybrid Logical Clock (`<wall_ms_hex>-<counter_hex>-<site>`).
2. Gapless document numbering incorporates the origin site (`INV-2026-0001` on cloud, `INV-<site>-2026-0001` on offline edge sites) to avoid number collisions during disconnected edits.
3. Reconnecting peers exchange operations over `/v1/sync` WebSocket or `/api/sync/pull` + `/api/sync/push` HTTP fallback.

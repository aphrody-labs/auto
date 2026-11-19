# Auto

Core products (crates, API/architecture/compliance/deployment/SDK docs) are merged into [`aphrody-labs/ay`](https://github.com/aphrody-labs/ay) (`crates/auto-*`, `docs/imported/auto`); this repository keeps the apps and TypeScript packages, which build against the `crates/` copy until they move.

Unified billing, Factur-X compliance, HR, workflow automation, and workspace software delivered as a single LTO Rust binary (`auto`), embeddable libraries (`aphrody_auto`, `auto_auth`, `auto_ffi`, `@aphrody/auto`), Cloudflare Workers edge bundle, Web UI, and 120 FPS GPUI desktop app.

## Architecture

- **Rust Core & Single Binary (`crates/`)**
  - `auto-auth`: Modern Rust Better Auth engine (Argon2id + Scrypt compatibility, ChaCha20-Poly1305 encrypted vaults, Ed25519 JWKS/JWT, TOTP RFC 6238, ES256 P-256 Passkeys, RBAC, OAuth2 PKCE, SQLite store, Axum router).
  - `auto-model`, `auto-i18n`, `auto-docs`, `auto-facturx`, `auto-sheets`, `auto-files`, `auto-knowledge`, `auto-client`, `auto-theme`: Native domain, PDF/A-3b Factur-X, DOCX/XLSX/PPTX, RAG chunking, HLC sync, and Material 3 design tokens.
  - `auto-ffi`: C ABI (`cdylib` + `staticlib` + `include/auto.h`) and `wasm32-unknown-unknown` WASM module for Cloudflare Workers, Browsers, and Bun.
  - `auto-sdk` (`aphrody-auto`): Embeddable Rust SDK library and unified `auto` executable (`serve`, `lb`, `mcp`, `auth`, `pdf`, `facturx`, `docx`, `chunk`, `desktop`).
- **TypeScript Workspace (`packages/`)**
  - `@aphrody/auto-i18n`, `@aphrody/auto-platform`, `@aphrody/auto-domain`, `@aphrody/auto-native`, `@aphrody/auto-store`, `@aphrody/auto-services`, `@aphrody/auto-client`.
- **Applications (`apps/`)**
  - `apps/server`: Single server targeting Cloudflare Workers (`DB` D1, `CompanyDO` SQLite DO, `AutomationWorkflow`, R2 prefix storage, `ASSETS`) and Bun self-hosted SQLite/WebSocket mode (`AUTO_MODE=serverless|self-hosted`).
  - `apps/ui`: NSH 0.6.0 web interface built cleanly to `apps/ui/dist/web/`.
  - `apps/desktop`: Standalone GPUI desktop workspace (`gpui-kit 0.10.0` + `gpui-fast`).
  - `apps/cli`: `auto-cli` tool and MCP stdio bridge.
  - `apps/extension`: Chrome Manifest V3 invoice clipper.

## Quick Start

```sh
# Run TypeScript tests and typechecks
bun install
bun check
bun test

# Run Rust workspace tests and clippy
bun scripts/cargo.ts test --workspace
bun scripts/cargo.ts clippy --workspace --all-targets -- -D warnings

# Build Wasm FFI module and Bun AOT binary
bun run build:native
bun run build:aot

# Start self-hosted server or native Rust L7 load balancer
bun run server --port 3000
bun scripts/cargo.ts run --bin auto -- lb --listen 127.0.0.1:8080 --upstreams http://127.0.0.1:3000
```

Configuration is declarative via `auto.toml` and environment variables (`AUTO_MODE`, `AUTO_HOST`, `AUTO_PORT`, `AUTO_DB_PATH`, `AUTO_UPSTREAMS`, `AUTO_URL_APP`).

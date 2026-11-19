# API Reference

All routes share identical contracts across Cloudflare Workers (`AUTO_MODE=serverless`) and Bun (`AUTO_MODE=self-hosted`). Inspect the OpenAPI 3.1 document at `GET /v1/openapi.json`.

## Authentication & Discovery

- `GET /health` — Server status, active mode (`serverless` | `self-hosted`), auth backend, and version.
- `GET /.well-known/jwks.json` — Ed25519 (EdDSA) public JSON Web Key Set.
- `GET /.well-known/oauth-authorization-server` — OAuth 2.1 metadata for MCP clients.
- `ALL /api/auth/*` — Better Auth session, sign-up, sign-in, 2FA TOTP, passkeys, API keys, and organizations.
- `POST /api/auth/rust/hash` | `POST /api/auth/rust/verify` — Rust Argon2id/Scrypt password primitives.
- `GET /v1/auth/jwt` — Issue short-lived Ed25519 bearer JWT for the active company.

## Commercial, HR & Operations (`/v1/*`)

- `GET/POST /v1/companies`, `GET /v1/me`
- `GET/POST /v1/documents`, `GET/PUT /v1/documents/:id`, `POST /v1/documents/:id/issue`, `POST /v1/documents/:id/status`, `POST /v1/documents/:id/credit-note`, `GET /v1/documents/:id/pdf`, `GET /v1/documents/:id/xml`, `GET/POST /v1/documents/:id/payments`, `POST /v1/documents/:id/einvoice`
- `GET/POST /v1/customers`, `PUT /v1/customers/:id`, `GET/POST /v1/products`, `GET/POST /v1/suppliers`, `GET/POST /v1/projects`, `GET /v1/projects/:id/folder`
- `GET/POST /v1/employees`, `GET /v1/employees/:id/leave`, `POST /v1/absences`
- `GET /v1/reminders`, `GET /v1/audit/verify`, `GET /v1/compliance/fec`, `POST /v1/ingest`, `GET /v1/received-invoices`, `GET/POST /v1/studio`, `POST /v1/studio/:id/op`, `GET /v1/search`
- `GET/POST /v1/automations`, `POST /v1/automations/import-n8n`, `POST /v1/automations/:id/run`
- `POST /mcp` — JSON-RPC 2.0 MCP tool endpoint.
- `POST /api/sync/pull`, `POST /api/sync/push`, `GET /v1/sync` (WebSocket HLC sync).

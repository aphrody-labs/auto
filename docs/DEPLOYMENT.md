# Deployment & Load Balancing

Configuration lives in `auto.toml` with environment variable overrides (`AUTO_MODE`, `AUTO_HOST`, `AUTO_PORT`, `AUTO_DB_PATH`, `AUTO_UPSTREAMS`, `AUTO_LB_STRATEGY`, `AUTO_URL_APP`). No secrets, IPs, or IDs belong in git.

## Cloudflare Workers (`AUTO_MODE=serverless`)

1. Apply D1 global schema: `bun x wrangler d1 execute auto --remote --file=packages/store/migrations/001_global.sql`
2. Configure Worker secrets (`AUTO_MASTER_KEY`, `BETTER_AUTH_SECRET`) via `wrangler secret put`.
3. Build UI (`apps/ui/dist/web/`) and WASM (`bun run build:native`).
4. Deploy single Worker: `bun x wrangler deploy`.

## Self-Hosted & Multi-Node Fleet (`AUTO_MODE=self-hosted`)

Start multiple replicas (`auto serve` or `auto-server`) behind the Rust L7 load balancer:

```sh
auto serve --host 127.0.0.1 --port 3001 --db /var/lib/auto/replica1.sqlite
auto serve --host 127.0.0.1 --port 3002 --db /var/lib/auto/replica2.sqlite
auto lb --listen 0.0.0.0:8080 --upstreams http://127.0.0.1:3001,http://127.0.0.1:3002 --strategy consistent_hash
```

Peers synchronize over `/v1/sync` WebSockets using HLC delta convergence, and edge sites interoperate bidirectionally with Cloudflare `CompanyDO`.

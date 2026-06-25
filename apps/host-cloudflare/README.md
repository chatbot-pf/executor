# @executor-js/host-cloudflare

Executor as a single Cloudflare Worker. The fourth app on the shared
`ExecutorApp.make` facade (alongside cloud, self-host, and local) — same code
paths, different injected providers:

| Seam         | Cloudflare provider                                              |
| ------------ | ---------------------------------------------------------------- |
| **identity** | Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) — no app login |
| **db**       | D1 (SQLite) by default; Neon/Postgres via Hyperdrive (opt-in)    |
| **engine**   | QuickJS-WASM, in-Worker (no extra binding)                       |
| **mcp**      | Access-JWT auth + the shared in-process session store            |
| **account**  | `/account/me` from the Access principal (members/keys → Access)  |
| **web**      | the shared multiplayer SPA (Workers Static Assets)               |

Single-tenant: every Access-verified principal belongs to the one configured
org. Members and credentials are managed in Cloudflare Access, not in-app.

## Surfaces

- `GET /` — the shared Executor web UI (Sources, Connections, Secrets,
  Policies) — the same shell as cloud/self-host, built by `vite build` into
  `dist/` and served via Workers Static Assets (`single-page-application`
  fallback for client routes).
- `/api/*` — the full Executor API (scopes, sources, secrets, account, …).
- `/mcp` — streamable-HTTP MCP with an `execute` tool.

`run_worker_first` in `wrangler.jsonc` keeps `/api/*` + `/mcp` on the Worker;
everything else is the SPA. Every API/MCP route is gated by the Access JWT (401
without). The SPA's auth context reads `/api/account/me`.

## Deploy

```bash
bunx wrangler login
bun run deploy:setup    # apps/host-cloudflare — provisions D1 + secret + deploys
```

`deploy:setup` (scripts/deploy.sh) is idempotent: it creates/reuses the
`executor` D1 database, writes its id into `wrangler.jsonc`, generates +
uploads `EXECUTOR_SECRET_KEY`, and deploys. It then prints the one manual step.

### The one manual step — Cloudflare Access

The Worker returns 401 until it's behind a Cloudflare Access application. In the
Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted**
2. Application domain: `executor-cloudflare.<your-subdomain>.workers.dev`
3. Add an Access policy (e.g. _Emails ending in `@yourcompany.com`_)
4. Copy the Application **Audience (AUD)** tag, then:
   ```bash
   bunx wrangler deploy \
     --var ACCESS_AUD:<aud> \
     --var ACCESS_TEAM_DOMAIN:<your-team>.cloudflareaccess.com
   ```
   (or set them in `wrangler.jsonc` and redeploy)

Now visiting the Worker prompts an Access login; the Worker validates the issued
JWT on every request. MCP clients present an Access JWT or
`Cf-Access-Client-Id`/`-Secret` service-token headers.

## Local development

```bash
# .dev.vars
EXECUTOR_SECRET_KEY=dev-secret-key-0123456789abcdef
ENABLE_DEV_AUTH=true     # bypass Access; every request is a fixed dev admin

bun run build            # vite build -> dist/ (the SPA)
bunx wrangler dev --local   # serves the SPA + Worker API together
```

`bun run dev:web` runs the Vite dev server (HMR) for UI work; point its API at a
running `wrangler dev` if you need live data.

`ENABLE_DEV_AUTH` is a dev-only escape hatch — never set it in a deployed
environment (it disables the Access gate).

## Neon Postgres (opt-in; D1 is the default)

D1 (SQLite) is the default db seam — zero external dependencies, auto-provisioned
by `wrangler deploy`, co-located with the Worker. That is the right default for
this single-tenant template. Swap to Neon Postgres over Cloudflare Hyperdrive
when you need real interactive transactions, no bound-parameter cap, large
values without the ~1-2MB D1 ceiling, or to scale past D1's 10GB limit. The
Worker auto-selects Postgres when a Hyperdrive binding is present — no code
change (see `src/db/index.ts`).

```bash
# 1. Create a Neon project (https://neon.tech) and copy its connection string.
# 2. Create a Hyperdrive config pointing at it:
bunx wrangler hyperdrive create executor-pg \
  --connection-string="postgresql://USER:PASS@EP.neon.tech/neondb?sslmode=require"
# 3. In wrangler.jsonc, uncomment the "hyperdrive" block and set "id" to the id
#    printed above. (Leave the d1_databases block; it just goes unused.)
# 4. Deploy. The schema is provisioned automatically on first boot (runtime
#    ensure, same code path as D1), so there is no separate migration step.
bun run deploy
```

Local dev against Postgres (PGlite stands in for Neon, no Docker):

```bash
bun run dev:db    # PGlite over a socket at postgresql://…@127.0.0.1:5433/postgres
bun run dev       # wrangler dev reads HYPERDRIVE.localConnectionString
```

The R2 `BLOBS` bucket stays useful under Postgres (large blob offload) and is
optional either way. Migrating existing data from a live D1 deployment to
Postgres is out of scope — a fresh Postgres database starts empty.

## Notes

- The QuickJS engine WASM is vendored into `src/quickjs-engine.wasm` (Workers
  forbid runtime WASM compilation; it must be statically imported). Refresh it
  after bumping the engine with `bun run vendor-wasm`.
- MCP sessions live in-process (one isolate owns a session). The cross-isolate
  upgrade is a Durable Object behind the same `McpSessionStore` seam.
- When Cloudflare's dynamic Worker Loader leaves closed beta, the QuickJS code
  substrate swaps for the dynamic-worker executor behind the `engine` seam — a
  one-Layer change.

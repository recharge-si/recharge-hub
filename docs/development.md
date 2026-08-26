# Development

## Prerequisites

- Node.js 22.12 or newer (`engine-strict` is enabled)
- Docker with Compose
- A Shopify Partner account and development store
- PowerShell, Bash, or another shell capable of running npm scripts

No development command or test may call a live MetaKocka company. Use recorded
fixtures. Live verification requires explicit approval and the designated test
company described in `docs/metakocka-verification.md`.

## First-time setup

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run setup
```

PowerShell equivalent for the copy:

```powershell
Copy-Item .env.example .env
```

Generate a unique encryption key and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Changing `ENCRYPTION_KEY` makes existing encrypted Shopify sessions and
MetaKocka credentials unreadable. Never reuse a production key in development.

Link the one tracked Shopify configuration, then pull credentials for processes
that run outside the Shopify CLI:

```bash
npm run config:link
npm run env -- pull
```

When linking asks for a configuration filename, choose `shopify.app.toml`.
Accepting a generated handle-based filename creates a second config that can
silently override webhook, API-version, and token-exchange settings. Avoid
`shopify app dev --reset` unless intentionally selecting or creating another
Partner app.

## Run locally

```bash
npm run dev
```

The Shopify CLI executes `shopify.web.toml`, applies migrations, and starts both
the React Router server and the pg-boss worker through `scripts/dev.mjs`.
Buttons that enqueue work require the worker.

To run the processes separately:

```bash
npm run dev:web
npm run dev:worker
```

The CLI injects Shopify values into its own dev process. A standalone worker,
script, or Compose service reads `.env`, so rerun `npm run env -- pull` after
linking a different app. A stale `SHOPIFY_API_SECRET` makes every webhook fail
HMAC verification and can look like an application regression.

## Environment variables

`src/adapters/config/env.server.ts` is the only application reader of
`process.env`. `.env.example` contains placeholders only.

| Variable                                            | Required | Purpose                                                              |
| --------------------------------------------------- | -------: | -------------------------------------------------------------------- |
| `SHOPIFY_API_KEY`                                   |      yes | Shopify public app key; injected by CLI in normal dev                |
| `SHOPIFY_API_SECRET`                                |      yes | Shopify app secret; never commit it                                  |
| `SHOPIFY_APP_URL`                                   |      yes | Absolute public/tunnel URL                                           |
| `SCOPES`                                            |      yes | Comma-separated Shopify scopes, kept aligned with `shopify.app.toml` |
| `DATABASE_URL`                                      |      yes | Host-process PostgreSQL connection                                   |
| `ENCRYPTION_KEY`                                    |      yes | 32 random bytes encoded as Base64                                    |
| `SHOP_CUSTOM_DOMAIN`                                |       no | Custom shop domain accepted by Shopify auth                          |
| `SENTRY_DSN`                                        |       no | Error reporting; blank disables Sentry                               |
| `SENTRY_ENVIRONMENT`                                |       no | Environment label sent to Sentry                                     |
| `LOG_LEVEL`                                         |       no | pino level; defaults to `info`                                       |
| `PORT`                                              |       no | Web port; defaults to `3000`                                         |
| `APP_DOMAIN`                                        |  Compose | Public hostname used by Caddy                                        |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |  Compose | Database container and app connection values                         |

`HOST` and `FRONTEND_PORT` are Shopify CLI/Vite integration variables and are
normally injected rather than stored in `.env`.

## Commands

| Command                | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Shopify CLI development session: web and worker       |
| `npm run dev:web`      | React Router server only                              |
| `npm run dev:worker`   | Worker in watch mode only                             |
| `npm run setup`        | Generate Prisma client and deploy existing migrations |
| `npm run build`        | Build web and worker production artifacts             |
| `npm run start`        | Run built web server                                  |
| `npm run start:worker` | Run built worker                                      |
| `npm run typecheck`    | Generate route types and run TypeScript               |
| `npm run lint`         | ESLint, including architecture boundaries             |
| `npm test`             | Full Vitest suite once                                |
| `npm run test:watch`   | Vitest watch mode                                     |
| `npm run config:link`  | Link `shopify.app.toml` to a Partner app              |
| `npm run env -- pull`  | Pull linked Shopify environment values                |
| `npm run deploy`       | Deploy Shopify app configuration/extensions           |

## Database and migrations

- Modify `prisma/schema.prisma` and create a new migration for each logical
  change. Never edit an applied migration.
- `npm run setup` deploys existing migrations; it does not author one.
- Check state with `npx prisma validate` and `npx prisma migrate status`.
- Prisma generation replaces its query-engine binary. On Windows, stop web and
  worker processes first if generation fails with `EPERM` on
  `query_engine-windows.dll.node`.

Most tests use mocked boundaries. The concurrency-sensitive guards are the
exception and run against a real database under `tests/db/` — see Validation
below. Remaining gaps are tracked in `docs/project-status.md`.

## Validation

For every code change:

```bash
npm run typecheck
npm run lint
npx vitest run
npm run build
```

When relevant, also run:

```bash
npx prisma validate
docker compose config --quiet
```

The test suite discovers `tests/**/*.test.ts`. Unit tests live under
`tests/unit/`; the fixture-driven vertical slice lives under
`tests/integration/`; recorded external payloads live under `tests/fixtures/`.

`tests/db/` runs against a **real PostgreSQL**, because the guarantees it checks
— the per-order reconciliation lock, the `count_code` claim, the payment
ledger's unique index — are properties of conditional updates and unique
indexes, and a mocked database would be a mock of the thing under test. It picks
up `DATABASE_URL` from `.env` (or `TEST_DATABASE_URL`), and **skips itself with
a visible reason when neither is reachable**, so a checkout with no Compose
stack still passes. Start the database first to include it:

```bash
docker compose up -d postgres
npx prisma migrate deploy
npx vitest run
```

`SKIP_DB_TESTS=1` forces the skip, which is what a CI job without a database
should set.

Each database test file creates its own shop with a random domain and deletes it
afterwards; every table is tenant-scoped with `ON DELETE CASCADE`, so it cannot
touch another tenant's rows.

## Production Compose

```bash
docker compose up -d
```

Compose builds one image, runs one migration container, then starts `web`,
`worker`, PostgreSQL, and Caddy. Set a strong `POSTGRES_PASSWORD`, set
`APP_DOMAIN` to the public hostname, and provide real application secrets
outside Git. Caddy is the only ingress; `/healthz` checks PostgreSQL and the
queue without calling MetaKocka.

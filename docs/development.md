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

### Starting from a clean state

Three levels, smallest first. Pick the smallest one that answers the question,
because the larger two also throw away the Shopify sessions and the migration
history you were probably not trying to test.

**One store, keeping the database.** Disconnect on
`/app/settings/metakocka`, confirmed by typing the company ID. It erases every
row this app holds for that store, keeps the Shopify session, and restarts
guided setup. Nothing is sent to MetaKocka. This is the one to reach for when
the question is "what does a merchant see on a fresh install", and it is the
only one of the three a merchant can do themselves.

**Every store, keeping the container.** Drops and rebuilds the schema from the
migrations:

```bash
npx prisma migrate reset --force
```

It drops the schema in `DATABASE_URL` — `public` — and reapplies every
migration. The `pgboss` schema is created by the worker and lives outside it,
so queued jobs survive a reset and reference stores that no longer exist. They
are harmless (every handler treats a missing row as nothing to do), but to be
rid of them too:

```bash
docker compose exec postgres psql -U recharge_hub -d recharge_hub \
  -c 'DROP SCHEMA IF EXISTS pgboss CASCADE'
```

The worker recreates it on next start. Sessions go with the schema, so the app
re-authenticates the next time it is opened in the Shopify admin.

**Everything, including the container's disk.** Removes the `pgdata` volume, so
nothing at all survives — schema, pgboss, and any manual state:

```bash
docker compose down -v
docker compose up -d postgres
npx prisma migrate deploy
```

`down -v` also removes the Caddy volumes, which means a new TLS certificate on
next start. Harmless locally; do not run it against anything shared.

Most tests use mocked boundaries. The concurrency-sensitive guards are the
exception and run against a real database under `tests/db/` — see Validation
below. Remaining gaps are tracked in `docs/project-status.md`.

## Manual Shopify tests

Three things cannot be tested from here, and the reason is deliberate: the
connector does not request `write_orders`, because synchronising Shopify into
MetaKocka never writes to a Shopify order. Asking for the scope purely to make
testing easier would be permission the product does not use. So these are done
by hand in the Shopify admin, against the dev store.

Before each: note the order number, and open the order in this app so you can
press **Check with Shopify** rather than waiting a quarter of an hour.

### Order edit

1. Shopify admin, order -> **Edit** -> change a line quantity (2 -> 3), save.
2. In this app, open the order and press **Check with Shopify**.
3. In MetaKocka, open the sales order named on the order page. Verify:
   - the line quantity is now 3;
   - it is the **same** document number as before, not a second one;
   - `sum_all` moved by one unit price;
   - any payment already on it is still there.
4. Repeat with **add a product** and with **remove a product**. After each,
   verify the same document changed and no second document appeared.

If the order is already paid, this needs *Update it even after the payment has
been recorded* in the advanced order settings (Orders, then Settings); without
it the app reports the difference and deliberately leaves the document alone.

### Partial payment

1. On an unpaid order, Shopify admin -> **Collect payment** -> a partial amount.
2. Check with Shopify. In MetaKocka verify the sales order shows **that amount**
   paid, not the order total.
3. On the app's order page, the Payments section should list one payment and an
   outstanding balance equal to the rest.
4. Collect the remainder. Check with Shopify again. Verify MetaKocka now shows
   **two** payments summing to the order total, and the first one is unchanged.
5. Press Check with Shopify once more and verify nothing moved: same two
   payments, same total.

For a split order, verify each document shows its own share and that the shares
add up to what was collected - never the full amount on each.

### Refund

1. Shopify admin -> **Refund** a part of the order.
2. Check with Shopify. Verify on the app's order page:
   - Payments shows Received unchanged, Refunded the amount, Outstanding
     adjusted;
   - the order is **not** reported as fully in step;
   - an exception says a credit note is needed in MetaKocka.
3. In MetaKocka verify the sales order's payment is **unchanged**. This is
   correct: the receipt records what was actually received, and the refund is a
   credit note. Nothing shrinks a recorded payment.
4. Issue the credit note in MetaKocka, then resolve the exception in the app.

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

The production VM has too little memory to build the image next to PostgreSQL,
so the image is built on a workstation, pushed to Docker Hub as
`time4action/recharge-hub`, and only pulled on the server. `docker-compose.yml`
has no `build:` for that reason; `APP_IMAGE` in `.env` overrides the tag.

### Build and push (workstation)

```bat
docker login
scripts\build-and-push.bat --latest
```

Tag flags are shared by `scripts\build.bat`, `scripts\push.bat` and
`scripts\build-and-push.bat`, and combine:

| Flag         | Tag                           |
| ------------ | ----------------------------- |
| *(none)*     | `latest`                      |
| `--latest`   | `latest`                      |
| `--dev`      | `dev`                         |
| `--sha`      | short git commit hash         |
| `--tag NAME` | `NAME` (repeatable)           |

`build.bat --latest --sha` tags one build twice; `push.bat --latest --sha`
pushes both.

### Server

Once: install Docker, point DNS at the VM, open ports 80 and 443, clone the
repository (Compose needs `docker-compose.yml` and `ops/Caddyfile`), and copy
`.env.example` to `.env`. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_APP_URL`, `APP_DOMAIN` (the public hostname), a strong
`POSTGRES_PASSWORD`, and `ENCRYPTION_KEY`. Keep a copy of `ENCRYPTION_KEY`
somewhere safe: without it the stored MetaKocka secrets cannot be read.

```bash
docker compose pull
docker compose up -d
```

Compose runs one migration container, then starts `web`, `worker`, PostgreSQL,
and Caddy. Caddy is the only ingress and obtains the certificate itself;
`/healthz` checks PostgreSQL and the queue without calling MetaKocka.

Each release is the same two commands. To run a non-`latest` tag, set
`APP_IMAGE=time4action/recharge-hub:dev` in `.env`.

`shopify.app.toml` must carry the deployed origin in `application_url` and
`auth.redirect_urls`; run `npm run deploy` after changing it so webhooks are
registered against the new host.

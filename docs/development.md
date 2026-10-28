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
docker compose -f docker-compose.dev.yml up -d postgres
npm run setup
```

`docker-compose.yml` is the production stack; local development only needs the
database from `docker-compose.dev.yml`.

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

## Local development against a separate app

`shopify.app.toml` is the production configuration of a single-merchant app and
has `automatically_update_urls_on_dev = false`, so `shopify app dev` would not
be able to point the live app at a tunnel. For local work create a second
Partner app (any name, e.g. "Recharge Hub dev") and link it into its own file:

```bash
npx shopify app config link --config dev   # writes shopify.app.dev.toml
npx shopify app env pull --config dev
npm run dev -- --config dev
```

`shopify.app.dev.toml` is ignored by Git. Never run `npm run deploy` with the
dev config selected against the production app.

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
| `SCOPES`                                            |      yes | Comma-separated Shopify scopes, kept aligned with `shopify.app.toml`. `read_discounts` was added for sale campaigns on 2026-09-19; the locale, translation, markets and content read scopes for translations on 2026-09-20 (docs/translations.md § Required scopes); the merchant approves them on next open |
| `DATABASE_URL`                                      |      yes | Host-process PostgreSQL connection                                   |
| `ENCRYPTION_KEY`                                    |      yes | 32 random bytes encoded as Base64                                    |
| `SHOP_CUSTOM_DOMAIN`                                |       no | Custom shop domain accepted by Shopify auth                          |
| `OPENAI_API_KEY`                                    |       no | The one server-side key AI translation uses (docs/translations.md § The provider). Never shown, stored or logged; blank disables AI translation and every other feature still works |
| `OPENAI_TRANSLATION_MODEL`                          |       no | The OpenAI model to translate with; defaults to `gpt-4.1-mini`. Costs are estimated only for models in `src/domain/translations/pricing.ts` |
| `EXPORT_PORTAL_URL`                                 |       no | The export portal's origin, for the Sources area (docs/sources.md). Per deployment; the per-store API key is pasted into the app. Blank leaves the Sources pages saying the portal is not configured; everything else works |
| `RIG_AI_MODEL`, `RIG_AI_MAX_CONCURRENT`, `RIG_AI_DAILY_CALLS`, `RIG_AI_TIMEOUT_MS` |       no | The rig builder's model calls through claude-pool (docs/rig-builder.md): model alias (default `sonnet`), concurrent calls (3), calls per shop per UTC day (500), time budget of one explain in ms (20000). Blank means the default; without the pool the builder works in plain mode |
| `RIG_BUILD_PER_MINUTE`, `RIG_BUILD_PER_HOUR`         |       no | Rate limit of the public `build` and `verify` routes per caller (60 and 600) |
| `CLAUDE_POOL_DIR_HOST`                              |  Compose | Host directory of claude-pool accounts, mounted read-only into `web` at `/run/claude-pool` (default `./data/claude-pool`). `CLAUDE_POOL_*` themselves are set in `docker-compose.yml` |
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
| `npm run build:e2e`    | Build the e2e app and worker into `build-e2e/`        |
| `npm run test:e2e`     | `build:e2e`, then the Playwright suite                |
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

**Everything, including the container's disk.** Removes the `pgdata_dev`
volume, so nothing at all survives — schema, pgboss, and any manual state:

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d postgres
npx prisma migrate deploy
```

Do not run this against the production stack: there the database is a bind
mount under `data/postgres` and is not removed by `down -v` in any case.

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

`tests/db/tax-repository.test.ts` needs the Compose database like the rest of
`tests/db/`: it replays the tax migration's backfill for one throwaway tenant
and asserts the old global `tax_percent` becomes the home rate and its
mappings without loss.

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
docker compose -f docker-compose.dev.yml up -d postgres
npx prisma migrate deploy
npx vitest run
```

`SKIP_DB_TESTS=1` forces the skip. CI does not set it: the `check` job has its
own PostgreSQL service and runs `tests/db/` against freshly applied migrations.

Each database test file creates its own shop with a random domain and deletes it
afterwards; every table is tenant-scoped with `ON DELETE CASCADE`, so it cannot
touch another tenant's rows.

## End-to-end tests

`tests/e2e/` drives the app in a real browser (Playwright, Chromium) against
**fake Shopify and fake MetaKocka**, with the real web server, the real worker
and a real PostgreSQL. Nothing leaves the machine: no Shopify store, no
MetaKocka company, no tunnel, no secrets.

```bash
docker compose -f docker-compose.dev.yml up -d postgres   # or any PostgreSQL
npx playwright install chromium                           # once
npm run test:e2e                                          # build:e2e, then the suite
npx playwright test sales                                 # one spec, reusing build-e2e/
npx playwright show-report                                # traces and screenshots
```

### How it is put together

- **`npm run build:e2e`** builds the web app and the worker into `build-e2e/`
  with one module swapped: `~/adapters/shopify/shopify.server` becomes
  `tests/e2e/app/shopify.server.ts` (a Vite alias in `vite.config.ts`, an
  esbuild plugin in `tests/e2e/support/build.ts`). The signed-in shop is the
  one the `e2e_shop` cookie names, and Admin GraphQL is answered by the fake
  services. The production `build/` never contains that module — there is no
  runtime switch that could be left on — and the module refuses to load
  without `E2E_FAKE_SERVICES_URL`.
- **The network guard** (`tests/e2e/app/network-guard.ts`), installed by that
  module, rewrites `https://main.metakocka.si` to the fake services and
  **refuses every other non-loopback request**, so OpenAI, the export portal,
  Shopify and a live MetaKocka are unreachable from an e2e run whatever the
  code under test does.
- **The fake services** (`tests/e2e/fake-services/`) keep an in-memory store and
  company per shop. Shopify handlers are keyed by GraphQL operation name (every
  query in `src/adapters/shopify` is named), MetaKocka handlers by endpoint
  path. A call with no handler is answered with an error **and fails the
  test**, so a page that starts asking for something new says so.
- **The stack** (`tests/e2e/support/stack.ts`, started by Playwright's
  `webServer`) runs `prisma migrate deploy` on the e2e database and starts the
  fake services, the worker and `react-router-serve`. The e2e database is
  `E2E_DATABASE_URL`, or `.env`'s `DATABASE_URL` with `_e2e` appended to the
  database name; it must end in `_e2e`. Nothing is reset or dropped.
- **App Bridge** is replaced in the browser by
  `tests/e2e/support/app-bridge-stub.js`: toasts land in `#e2e-toasts`, and
  `<ui-save-bar>` shows its buttons inline so a spec can press Save. Polaris is
  the real `polaris.js`. Page-header actions (`slot="primary-action"`) are what
  the admin moves into its title bar; outside the admin they are not rendered,
  so a spec presses them with `dispatchEvent("click")`.

### Writing a spec

Import `test` and `expect` from `tests/e2e/support/test.ts`. Every test gets
its own `shop` — a fresh tenant, its own fake store, the cookie — so specs run
in parallel. After the test the fixture waits for the shop's pg-boss jobs to
settle, fails on any job that failed, fails on an uncaught page error and on an
unhandled fake call, and deletes the shop (everything cascades from it).

- `shop.resetServices({ shopify, metakocka })` sets the fake store and company
  (schemas in `tests/e2e/fake-services/state.ts`); `shop.services()` reads them
  back, which is how a spec checks what the worker wrote.
- `seedConnectedShop` (`tests/e2e/support/seed.ts`) starts from a shop that
  finished setup, built with the app's own repository calls;
  `seedCatalogueSnapshot` adds the sale-campaign catalogue.
- `shop.settleJobs()` waits for the background work an action queued.
- Polaris form controls live in shadow DOM: `getByLabel` and `getByRole` reach
  text fields, checkboxes and buttons; this app's `Dropdown` keeps its value in
  a hidden `input[name=…]`.
- A new page under `/app` belongs in `tests/e2e/specs/pages.spec.ts`. When a
  spec fails on "no handler for X", add a handler that answers in Shopify's or
  MetaKocka's real shape — never invent fields.

The specs: `smoke` (a new shop), `setup` (guided setup end to end, including
the jobs Finish queues), `stock` (Sync stock now writes MetaKocka stock to
Shopify), `exceptions` (Resolve and Ignore), `sales` (activate writes sale
prices, End restores them) and `pages` (every parameterless page renders for a
set-up shop).

## Production Compose

The production VM has too little memory to build the image next to PostgreSQL,
so the image is built by CI, pushed to GitHub Container Registry as
`ghcr.io/recharge-si/recharge-hub`, and only pulled on the server. `docker-compose.yml`
has no `build:` for that reason; `APP_IMAGE` in `.env` overrides the tag.

### Continuous deployment

`.github/workflows/deploy.yml` (workflow `ci`) runs `check` and `e2e` →
`deploy` → `verify`.

`check` runs on every pull request and every push to `main`: `npm ci`,
`npm run typecheck`, `npm run lint`, `npx prisma migrate deploy` against a
throwaway PostgreSQL service, `npm test` (including `tests/db/`), and
`npm run build`. A newer push to a pull request cancels its running check.
Runs on `main` are queued rather than cancelled, so pushes are checked and
deployed strictly in order and an older commit never lands over a newer one.

`e2e` runs beside `check` on the same events: `npm run test:e2e` against its
own PostgreSQL service (`ci_e2e`). The Playwright report — a trace and a
screenshot for every failure — is uploaded as the `playwright-report` artifact
whether the run passes or not.

`deploy` runs only on a push to `main`, only after `check` and `e2e` pass, and
one at a time (concurrency group `deploy-prod`). It builds the image on GitHub Actions
with the commit SHA baked in as `APP_VERSION` (and the
`org.opencontainers.image.revision` label), pushes it tagged with the full
commit SHA and `latest`, then SSHes to the VM as the `deploy` user and, in
`/data/stack/apps/recharge-hub`:

1. records the image the running `web` container uses;
2. logs in to `ghcr.io` with the job's own `GITHUB_TOKEN` (valid only while the
   job runs; logged out again on exit, so the VM stores no registry
   credential), runs `docker compose pull migrate web worker` (up to three attempts) and
   `docker compose up -d --remove-orphans` with `APP_IMAGE` exported to the
   new SHA (the shell variable wins over `.env`);
3. waits up to 60 seconds for `http://127.0.0.1:3192/healthz` to answer 200;
4. checks that `web` reports `APP_VERSION` equal to the commit SHA and that
   `worker` is running on the same image.

If the migration, the health check, or the commit check fails, it prints the
`migrate` and `web` logs and rolls `web` and `worker` back to the recorded image
with `docker compose up -d --no-deps web worker`, then fails the run either way.
The SSH session is capped at 15 minutes and each job has a timeout.

`verify` then requests `/healthz` on the public URL (through DNS, TLS and the
host nginx) with retries for up to about a minute. The URL defaults to
`https://recharge-hub.time-4-action.com`; set the `PRODUCTION_URL` repository
variable to change it. `/healthz` deliberately reports no version, so the
commit is checked on the server in step 4, not here.
Rollback does not undo a migration that was applied: a deploy whose migration
succeeded but whose code is broken goes back to old code on the new schema, so
keep migrations additive (expand first, remove columns in a later release).

It only swaps images: changes to `docker-compose.yml`, `ops/`, or `.env` on the
server are still applied by hand with `git pull` in the checkout. To go back to
an older release by hand, re-run that commit's workflow run, or run
`export APP_IMAGE=ghcr.io/recharge-si/recharge-hub:<sha>` and `docker compose up -d` on
the server (after a `docker login ghcr.io`, the package is private).

The image is pushed and pulled with the workflow's own `GITHUB_TOKEN`
(`packages: write` on the deploy job), so there is no registry secret; the
`org.opencontainers.image.source` label in the Dockerfile links the package to
this repository. SSH secrets, as organization secrets (environment or
repository secrets on `production` would work too):

| Secret               | Value                                               |
| -------------------- | --------------------------------------------------- |
| `PROD_DEPLOY_HOST`        | The VM's hostname or IP                             |
| `PROD_DEPLOY_SSH_KEY`     | Private key whose public half is in `deploy`'s `authorized_keys` |
| `PROD_DEPLOY_FINGERPRINT` | The VM's SSH host key fingerprint, the `SHA256:…` part. The deploy action's Go SSH client prefers the ECDSA host key, so use `ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub` (the ED25519 one fails with "host key fingerprint mismatch") |

The `deploy` user must be in the `docker` group, be able to read the checkout,
and have `curl` available.

Grant that access without touching `data/postgres`. The database directory
belongs to the container's `postgres` user (uid 70 in the alpine image) with
mode `0700`; a recursive `chown`/`chmod`/`setfacl` over the checkout takes it
away, and postgres then fails every connection with `could not open file
"global/pg_filenode.map": Permission denied` (2026-10-05). Give `deploy` the
checkout itself and `.env`, not its contents recursively. To repair it:

```bash
cd /data/stack/apps/recharge-hub
sudo chown -R 70:70 data/postgres
sudo chmod 700 data/postgres
docker compose restart postgres
```

Dependabot (`.github/dependabot.yml`) opens at most one grouped pull request a
month each for npm minor/patch updates and for GitHub Actions; they pass through
`check` like any other pull request.

### Server

Once: install Docker, point DNS at the VM, and clone the repository. The
production checkout lives at `/data/stack/apps/recharge-hub`; everything the
stack persists is written under `data/` inside it — `data/postgres` is the
database — so the checkout directory is the whole deployment.

```bash
sudo mkdir -p /data/stack/apps
sudo chown "$USER" /data/stack/apps
git clone <repository> /data/stack/apps/recharge-hub
cd /data/stack/apps/recharge-hub
mkdir -p data/postgres
cp .env.example .env
```

Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, a strong
`POSTGRES_PASSWORD`, and `ENCRYPTION_KEY` in `.env`; `WEB_PORT` (default
`3192`) is the loopback port the web container is published on. Keep a copy of
`ENCRYPTION_KEY` somewhere safe: without it the stored MetaKocka secrets cannot
be read.

```bash
docker compose config --quiet   # validates the file and .env
docker compose pull
docker compose up -d
```

Compose runs one migration container, then starts `web`, `worker`, and
PostgreSQL. `web` listens on `127.0.0.1:${WEB_PORT}` only; the host's nginx
terminates TLS and proxies to it. `/healthz` checks PostgreSQL and the queue
without calling MetaKocka.

The bind mounts carry the `Z` SELinux label, which AlmaLinux and RHEL need for
containers to write host directories. Back up the database with `pg_dump`, not
by copying `data/postgres` while it runs:

```bash
docker compose exec postgres pg_dump -U recharge_hub -Fc recharge_hub > backup.dump
```

#### nginx

`ops/nginx/recharge-hub.conf` is the site file, shaped like the other
`*.time-4-action.com` sites on the host: HTTP redirects to HTTPS, HTTPS uses the
shared `/etc/nginx/snippets/ssl-t4a.conf` certificate snippet and proxies to
the `WEB_PORT` upstream with `X-Forwarded-Proto` set. It adds no frame headers
of its own because the app emits the Shopify `frame-ancestors` policy per
request.

`react-router-serve` does not trust `X-Forwarded-Proto`, so the server sees
`http://` requests while browsers send `Origin: https://…`. React Router
rejects such actions as cross-site (400 "Bad Request" on every form post), so
`react-router.config.ts` lists the host of `application_url` in
`allowedActionOrigins`. Moving the app to another domain means updating
`shopify.app.toml` before the image is built.

```bash
sudo setsebool -P httpd_can_network_connect 1   # SELinux: let nginx reach 127.0.0.1:3192
sudo cp ops/nginx/recharge-hub.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

#### Caddy instead of nginx

On a VM with nothing on ports 80/443, `docker compose --profile caddy up -d`
adds Caddy as the ingress: it obtains the certificate for `APP_DOMAIN` itself
and stores it under `data/caddy`. Create `data/caddy/data` and
`data/caddy/config` first. Do not run both.

`shopify.app.toml` must carry the deployed origin in `application_url` and
`auth.redirect_urls`; run `npm run deploy` after changing it so webhooks are
registered against the new host.

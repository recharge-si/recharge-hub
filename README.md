# Fulfilment orchestrator

A public Shopify app that sits between a merchant's Shopify store and their
MetaKocka ERP, and owns two decisions no existing connector makes: which supply
source fulfils each order line, and how much stock is safe to publish.

`docs/BUILD_SPEC.md` is the build specification and the source of truth. This
file only covers how to run what exists.

## Status

The app includes the embedded Shopify shell, MetaKocka connection and settings,
the SKU registry and catalogue sync, order intake and allocation, MetaKocka
sales-order writes, payment/order-state synchronization, inventory sync,
reconciliation jobs, the operations dashboard, and the exceptions workflow.

Some specification items and design decisions remain open. The current list is
in `docs/agent/NOT_DONE.md`; items that require a human decision or a test-company
probe are in `docs/agent/TODO-HUMAN.md`.

## Requirements

- Node 22.12 or newer
- Docker, for Postgres
- A Shopify Partner account and a development store

## Local development

```bash
npm install
cp .env.example .env
```

Generate the master key that encrypts secrets at rest and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Start Postgres and apply the schema:

```bash
docker compose up -d postgres
npx prisma migrate deploy
```

Link the app to your Partner account, then run it. The CLI injects
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL` into the dev
server itself, and rewrites `application_url` in `shopify.app.toml` to the
tunnel URL on every run:

```bash
npm run config:link
npm run dev
```

When `config:link` asks for a configuration file name, answer
**`shopify.app.toml`**. Accepting the default creates a second file named after
the app handle, and that file then takes precedence, silently dropping the
compliance webhooks, token exchange and pinned API version from the config
Shopify actually receives. Keep exactly one config file.

Avoid `shopify app dev --reset` unless you mean it: it re-runs app selection and
will happily create a second Partner app, leaving you with two apps and two
config files that disagree about which one the store has installed.

To run a process outside `shopify app dev` (the worker, the Compose stack, a
script), the Shopify values have to be in `.env` instead. Pull them after
linking, and again any time you link to a different app:

```bash
npm run env -- pull
```

Stale values here are worth watching for: a `SHOPIFY_API_SECRET` belonging to a
deleted or different app makes every webhook fail HMAC verification with a 401,
which looks like a code fault and is not.

`npm run dev` starts the web server **and** the job worker together
(`scripts/dev.mjs`). Both have to be running: every sync button queues a job,
and with no worker the jobs pile up in Postgres looking like a broken button.

The script prints a `[dev] starting web: ...` line for each process. If you ever
see the worker start but not the web server, and the CLI reports
`ECONNREFUSED` against `localhost:<port>`, the runner is the problem, not the
app. Fall back to two terminals:

```toml
# shopify.web.toml
dev = "npm exec prisma migrate deploy && npm exec react-router dev"
```

```bash
npm run dev          # terminal 1
npm run dev:worker   # terminal 2
```

To run either on its own: `npm run dev:web`, `npm run dev:worker`.

## When the Prisma client needs regenerating

`npm install` generates it. After changing `prisma/schema.prisma`:

```bash
npm run setup
```

Generation rewrites the query engine binary, and on Windows that fails with
`EPERM ... rename query_engine-windows.dll.node` if any other Node process still
has the engine loaded. Stop the worker and any stray dev server first. This is
why `prisma generate` is deliberately not part of `shopify app dev`.

## Checks

```bash
npm run typecheck
npm run lint
npm test
```

`npm run lint` enforces the import direction from `docs/BUILD_SPEC.md` section 5:
`domain/` imports nothing from the other tiers, `web/` never imports `jobs/`.
It also fails on a clock read inside `domain/`.

## Production

One image, two processes, on one Linux VM:

```bash
docker compose up -d
```

That starts `postgres`, a one-shot `migrate`, `web`, `worker` and `caddy`. Set
`APP_DOMAIN` in `.env` to the public hostname and Caddy obtains a Let's Encrypt
certificate for it. `web` is not published directly; Caddy is the only ingress.

Liveness and readiness: `GET /healthz` checks Postgres and the job queue, and
deliberately does not touch MetaKocka.

## Layout

```
src/
  domain/      pure logic, no I/O, no imports from the other tiers
  adapters/    shopify, metakocka, db, queue, crypto, observability
  jobs/        pg-boss handlers and schedules
  web/         React Router routes and s-* component UI
prisma/
tests/
ops/           Caddyfile
```

## Things worth knowing before changing code

- **The UI is Polaris and App Bridge web components** (`s-*`), not Polaris React.
- **The App Bridge script lives in `<head>` of `root.tsx`**, not in a route body.
  This is why the app does not use the library's `AppProvider`; see
  `src/web/components/app-bridge-navigation.tsx`.
- **Offline tokens are encrypted at rest.** `PrismaSessionStorage` is wrapped by
  `EncryptedSessionStorage`. Changing `ENCRYPTION_KEY` invalidates every stored
  token, and shops will silently re-authenticate through token exchange.
- **Webhooks never do work in the request.** They verify the HMAC, enqueue, and
  return 200. Handlers run once per Shopify webhook id.
- **No page load may await MetaKocka.** Render from Postgres, refresh in the
  background.

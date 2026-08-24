# Fulfilment orchestrator

A public Shopify app that sits between a merchant's Shopify store and their
MetaKocka ERP, and owns two decisions no existing connector makes: which supply
source fulfils each order line, and how much stock is safe to publish.

`CLAUDE.md` is the build specification and the source of truth. This file only
covers how to run what exists.

## Status

**M1, skeleton, complete.** Token exchange, App Bridge, compliance webhooks,
Postgres and pg-boss under Compose, health endpoint, error reporting.

Not built yet: the MetaKocka connection (M2), the SKU registry (M3), order
intake and allocation (M4). See `CLAUDE.md` section 13 for the build order.

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

`config:link` offers to write a second config file named after the app handle.
Decline it, or fold anything it adds back into `shopify.app.toml` and delete it:
two configs means the settings you edited may not be the ones Shopify has.

To run a process outside `shopify app dev` (the worker, a script), the Shopify
values have to be in `.env` instead. Pull them once:

```bash
npm run env -- pull
```

The worker is a second process and does not start with `npm run dev`:

```bash
npm run dev:worker
```

## Checks

```bash
npm run typecheck
npm run lint
npm test
```

`npm run lint` enforces the import direction from `CLAUDE.md` section 5:
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

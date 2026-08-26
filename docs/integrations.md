# Integrations

This document describes integration ownership and code entry points. Product
requirements remain in `docs/BUILD_SPEC.md`. Observed MetaKocka behavior and
probe evidence belong in `docs/metakocka-verification.md`.

## Data ownership and direction

| Data                                     | Direction today             | Owner / implementation                                      |
| ---------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| Orders and order changes                 | Shopify → app → MetaKocka   | Webhooks plus scheduled Shopify reconciliation              |
| Sales-order payment state                | Shopify → app → MetaKocka   | Gateway mapping and per-document payment claims             |
| SKU catalogue match                      | Shopify + MetaKocka → app   | `sync-catalogue` registry read                              |
| MetaKocka product names/prices on opt-in | Shopify → MetaKocka         | `sync-products`; merchant-controlled and off by default     |
| Inventory for `mk_to_shopify` locations  | MetaKocka → Shopify         | Physical `amount` to Shopify `on_hand`                      |
| Inventory for `shopify_to_mk` locations  | Shopify → MetaKocka         | Complete-warehouse `sync_stock` write                       |
| Fulfilment-order placement               | Planned app → Shopify       | Queue exists; no consumer yet                               |
| Tracking                                 | Planned MetaKocka → Shopify | Blocked: verified sales-order payload has no tracking field |

Missing directions and product decisions are tracked in
`docs/project-status.md` rather than implied here.

## Shopify

### Configuration and authentication

- `shopify.app.toml` is the single Partner-app configuration and webhook source.
- `shopify.web.toml` tells the CLI how to start the local web/worker pair.
- `src/adapters/shopify/shopify.server.ts` configures token exchange, encrypted
  Prisma session storage, App Store distribution, scopes, and the pinned Admin
  API version.
- `tests/unit/api-version.test.ts` prevents the SDK client and webhook version
  from drifting apart.

The app uses GraphQL Admin API only. App Bridge and Polaris scripts are loaded
from Shopify's CDN in `src/web/root.tsx`; the UI uses `s-*` web components.

### Webhooks

Shopify webhook routes are thin files under `src/web/routes/webhooks.*`. Shared
authentication lives in `src/web/lib/webhook.server.ts`. Request work is
persisted/enqueued and returned quickly; handlers live under `src/jobs/handlers/`.

Subscribed topics include install/scope events, required compliance topics,
order create/update/paid/cancel/delete/edit, and refunds. Shopify order webhooks
are supplemented by a 15-minute Admin API reconciliation because delivery is
best-effort.

### Inventory safety

`src/adapters/shopify/inventory.ts` owns inventory queries and mutations. It
requires optimistic `changeFromQuantity` values, applies idempotency directives,
activates missing levels, batches writes, and refuses a location not owned by
this app.

## MetaKocka

### Credentials and client boundary

MetaKocka uses a company id and full-access secret key on every request. The app
stores the key with AES-256-GCM through
`src/adapters/crypto/secrets.server.ts`; it is never returned to the browser or
logged. Optional webhook secret and `sync_stock` API user email live with the
same per-shop credential.

`src/adapters/metakocka/client.ts` owns HTTP transport, timeout, error envelopes,
and Zod response parsing. Endpoint paths are explicit in `endpoints.ts` because
the API has incompatible `json/` and non-`json/` families. `sync_stock` has a
third base URL and a dedicated adapter.

### Important observed constraints

- One sales order has one warehouse and profit centre; split allocation creates
  one document per supply source.
- MetaKocka does not enforce `count_code` uniqueness. Never retry an ambiguous
  write without resolving whether it succeeded.
- An unknown warehouse mark is silently replaced by the company default, so
  mappings are validated against the cached warehouse register.
- Document updates replace the whole document. Payment and edit paths replay a
  complete recorded body and read it back.
- Product lines are catalogue references. Sending `unit` can create a product
  accidentally, so order lines deliberately omit it.
- Stock `sync_stock` removes omitted products and can report success for a
  no-op, so the adapter sends and verifies a complete list.
- The only MetaKocka webhook is a stock-change nudge with limited retries;
  scheduled reconciliation remains mandatory.

Do not extend this list from memory. Verify a new field or endpoint against the
official API and, when needed, the designated test company; record the evidence
before building on it.

### Webhook

`src/web/routes/webhooks.metakocka.$shop.stock.tsx` verifies HMAC-SHA1 over the
raw request body using `src/adapters/metakocka/webhook.ts`, returns MetaKocka's
required JSON acknowledgement, and queues inventory sync. Authentication
failures deliberately have one indistinguishable response.

## PostgreSQL and pg-boss

Prisma application data and pg-boss queues share PostgreSQL so order intake can
persist state and enqueue allocation in one transaction. Queue names and retry
policies live in `src/adapters/queue/queues.ts`; producer helpers live in
`boss.server.ts`; consumers and schedules register in `src/jobs/worker.ts`.

## Observability

- `src/adapters/observability/logger.server.ts` configures structured pino logs
  with secret and PII redaction.
- `src/adapters/observability/sentry.server.ts` initializes optional Sentry
  reporting and strips sensitive context.
- `EventLog` is the durable merchant-visible audit trail. Logs and Sentry are
  operational diagnostics and do not replace it.

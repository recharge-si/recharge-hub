# Architecture

This document maps the implementation that exists today. Product requirements
and the target architecture live in `docs/BUILD_SPEC.md`; known gaps between the
target and current code live in `docs/project-status.md`.

## Runtime shape

The repository builds one image and runs two Node.js processes against one
PostgreSQL database:

```text
Shopify admin and webhooks
          |
          v
  React Router web process -----> PostgreSQL <----- pg-boss worker
          |                            |                 |
          |                            |                 +--> MetaKocka
          |                            |                 +--> Shopify Admin API
          +--> enqueue only -----------+

Caddy is the only production ingress and proxies to the web process.
```

- `web` renders the embedded app, authenticates Shopify requests, verifies
  webhook signatures, persists request state, and enqueues work.
- `worker` owns queue consumers, schedules, long-running integration calls, and
  graceful job shutdown.
- Prisma owns application tables in `public`; pg-boss owns its own `pgboss`
  schema.

## Source boundaries

| Area            | Responsibility                                                                             | May depend on                   |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| `src/domain/`   | Pure allocation, money, order-state, product-template, and supply-default rules            | Domain only                     |
| `src/adapters/` | External boundaries: Shopify, MetaKocka, Prisma, queues, crypto, logs, Sentry, environment | Domain                          |
| `src/jobs/`     | Application orchestration and pg-boss handlers                                             | Domain and adapters             |
| `src/web/`      | React Router loaders/actions, webhook endpoints, and embedded UI                           | Domain and adapters, never jobs |

ESLint enforces these import directions. External payloads are parsed at their
adapter boundary, normally with Zod. `domain/` cannot read the clock or use
randomness; callers inject time and inputs.

## Important flows

### Order intake and ERP write

1. Shopify order webhook routes authenticate through
   `src/web/lib/webhook.server.ts`.
2. `orders/create` persists the order and queues `allocate-order` in one
   transaction.
3. `src/jobs/handlers/allocate-order.ts` maps persisted state into the pure
   allocator under `src/domain/allocation/` and stores the plan.
4. One `write-metakocka-order` job per supply source builds and claims a
   deterministic document before calling MetaKocka.
5. Later order events and the scheduled reconciler converge payment and order
   state through `sync-order-state`.

MetaKocka has no idempotency key and accepts duplicate `count_code` values. The
database claim in `src/adapters/db/repositories/order.server.ts` is therefore a
financial safety boundary.

### Inventory

`src/jobs/handlers/sync-inventory.ts` enforces one direction per mapped
location:

- `mk_to_shopify`: MetaKocka physical `amount` becomes Shopify `on_hand`.
- `shopify_to_mk`: Shopify `on_hand` is written through MetaKocka `sync_stock`.
- `none`: this app writes neither side.

The Shopify adapter refuses writes to locations this app does not own. The
MetaKocka adapter sends a complete warehouse snapshot because omission from
`sync_stock` is destructive.

### Catalogue and product names

- `sync-catalogue` reads Shopify variants and MetaKocka products into the SKU
  registry.
- `sync-products` performs merchant-enabled writes to MetaKocka.
- Product-name parsing, rendering, linting, and editing are pure functions in
  `src/domain/products/template/`.

### Schedules and recovery

`src/jobs/worker.ts` registers four keyed schedules. The fan-out in
`src/jobs/handlers/scheduled-tick.ts` runs:

- every 5 minutes: inventory sync;
- every 15 minutes: warehouse refresh, Shopify order reconciliation, exception
  re-check, and due merchant-scheduled catalogue work;
- hourly: MetaKocka document read-back;
- nightly: payment/profit-centre/pricelist refresh and PII retention.

Jobs that exhaust retries generally dead-letter into a merchant-visible
exception. Schedule/register jobs rely on the next cadence and Sentry instead.

## Persistence map

The authoritative schema is `prisma/schema.prisma`; migrations are immutable
history under `prisma/migrations/`. Major groups are:

- tenancy and auth: `Shop`, encrypted `Session`, `MetakockaCredential`;
- audit and delivery: `EventLog`, `IdempotencyKey`, pg-boss queues;
- supply and inventory: `SupplySource`, `SupplySetting`, `SupplyLevel`, cached
  warehouse/profit-centre registers;
- catalogue: `Sku`, `ProductSyncSetting`, observed pricelists and tax rates;
- orders: `Order`, `OrderLine`, `Allocation`, `MetakockaDocument`, `Exception`;
- merchant mappings/settings: payment types, payment fallback, and sales-order
  update policy.

Most tables are tenant-owned through `shopId`. The current repository-layer
enforcement gap is tracked in `docs/project-status.md`.

## Where to implement changes

| Change                         | Start here                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Pure allocation or money rule  | `src/domain/` and matching unit tests                                        |
| Shopify payload/query/mutation | `src/adapters/shopify/`                                                      |
| MetaKocka endpoint or schema   | `src/adapters/metakocka/`, after verified API evidence                       |
| Database query                 | `src/adapters/db/repositories/`; keep tenant scope at the boundary           |
| Background workflow            | Queue definition, `src/jobs/handlers/`, then worker registration             |
| Embedded screen or form        | `src/web/routes/` with shared UI in `src/web/components/` and `src/web/lib/` |
| Webhook                        | Thin route in `src/web/routes/`, shared verification helper, queue handler   |
| Schema change                  | `prisma/schema.prisma` plus a new additive migration                         |
| Current behavior or limitation | Owning document under `docs/` and `docs/project-status.md`                   |

## Cross-cutting invariants

- Identity comes from Shopify sessions or an explicit service principal; never
  trust a shop or record id posted by a browser without tenant scoping.
- Webhooks verify HMAC before parsing and enqueue heavy work.
- No page loader waits for MetaKocka; UI reads cached PostgreSQL state.
- Money stays in integer minor units until an integration boundary.
- MetaKocka credentials and Shopify offline tokens are encrypted. PII retention
  is active; the remaining JSON encryption gap is documented in project status.
- `EventLog` is an append-only product audit trail, not temporary debug output.

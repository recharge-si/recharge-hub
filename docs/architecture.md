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

### Order intake and the reconciliation loop

Order synchronization is a convergence loop, not an event-to-document mapper. A
webhook is a trigger to recompute desired state; it is never itself the state.

1. Shopify order webhook routes authenticate through
   `src/web/lib/webhook.server.ts`.
2. `orders/create` persists the order and queues `reconcile-order` in one
   transaction. Every other order topic reaches the same queue through
   `orders-event` or `sync-order-state`.
3. `src/jobs/handlers/reconcile-order.ts` is the single authority. Under a
   per-order lock (`order.reconcile_claimed_at`) it reads the order, its
   fulfilment assignment and its payment transactions from Shopify, builds
   desired state, diffs it against the recorded MetaKocka state, applies only
   the difference, and verifies the result.
4. `write-metakocka-order` remains the executor for one document, claiming a
   deterministic `count_code` before calling MetaKocka. It is called inline by
   the loop and remains a queue for retries.
5. `allocate-order` and `mark-metakocka-paid` are doorways into the same loop,
   kept so queued jobs and merchant-facing retries keep working.

The loop's supporting services live under `src/jobs/orders/`:
`allocation-planner`, `document-reconciler`, `payment-reconciler`, and
`verification`. The decisions they make are pure functions in
`src/domain/orders/` (`canonical`, `reconcile`, `invariants`, `reference`) and
`src/domain/payments/` (`transactions`, `allocation`).

Three safety boundaries hold this together:

- MetaKocka has no idempotency key and accepts duplicate `count_code` values,
  so the database claim in `src/adapters/db/repositories/order.server.ts` is a
  financial safety boundary.
- The per-order reconciliation lock is the only thing preventing two passes
  deciding two different warehouse splits for one order.
- After every pass the quantity and value invariants are checked
  (`domain/orders/invariants`). A broken invariant is recorded as
  `order.sync_state = inconsistent` with the per-SKU difference and **never**
  repaired by writing another document.

### Warehouse allocation

`sales_order_setting.allocation_mode` decides where an order's warehouse split
comes from:

- `shopify_locations` (default): Shopify's fulfilment orders are authoritative.
  `src/adapters/shopify/fulfillment-orders.ts` reads the assigned location per
  line; the existing `supply_source.shopify_location_id` mapping resolves it to
  a MetaKocka warehouse. Anything Shopify has not assigned falls back to (2).
- `stock_rules`: the pure allocator under `src/domain/allocation/` decides from
  cached `supply_level` rows, as it always did.

A location with no supply source is reported (`unmapped_location`), never
guessed at. A document whose supply source leaves the allocation is *retired*
according to `sales_order_setting.obsolete_document_policy`; it is never deleted
except under the explicit `delete_unpaid` opt-in, and only when unpaid.

### Payments

Payments are a ledger of individual Shopify transactions, not a flag.
`src/adapters/shopify/transactions.ts` reads `order.transactions`;
`order_payment` stores one row per transaction under
`UNIQUE (shop_id, shopify_transaction_id)`, which is what makes payment
synchronization idempotent. `domain/payments/transactions` decides what counts
as money — successful `SALE`/`CAPTURE` only, never an authorization — and
`domain/payments/allocation` divides receipts across a split order's documents
so they sum to exactly what was received.

MetaKocka's verified replacement semantics are used deliberately rather than
worked around: each document is sent the **complete** `mark_paid` array it
should carry (`replaceDocumentPayments`), so two captures are two entries and
re-sending an unchanged ledger changes nothing. Refunds are recorded in the
ledger and never projected onto a sales order; they remain a credit-note
exception.

### Inventory

`src/jobs/handlers/sync-inventory.ts` enforces one direction per mapped
location:

- `mk_to_shopify`: MetaKocka physical `amount` becomes Shopify `on_hand`.
- `shopify_to_mk`: Shopify `on_hand` is written through MetaKocka `sync_stock`.
- `none`: this app writes neither side.

The Shopify adapter refuses writes to locations this app does not own. The
MetaKocka adapter sends a complete *company* snapshot — every cached
warehouse, not only the one being reverse-synced — because `sync_stock`'s own
documentation requires the total stock for all warehouses in one request and
treats anything omitted, including a whole warehouse, as removed. Every
warehouse but the one Shopify is authoritative for is echoed back exactly as
read.

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
- payments: `OrderPayment` (one row per Shopify transaction) and
  `OrderPaymentApplication` (that transaction's share of one document);
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
| Order reconciliation rule      | `src/domain/orders/` and `src/jobs/orders/`, then `reconcile-order`          |
| Payment rule                   | `src/domain/payments/` and `src/jobs/orders/payment-reconciler.ts`           |
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

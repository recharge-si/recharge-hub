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

## Merchant-facing shape

Five areas in `s-app-nav`, each a job rather than a table. Every settings page
lives with the thing it configures, so nothing in the navigation is a database
name:

```text
Home              /app                  operations dashboard
Orders            /app/orders           list, and /app/orders/settings
Needs attention   /app/exceptions
Products          /app/products         status, and /app/products/sync for settings
Locations         /app/locations        warehouses and stock, and
                                        /app/locations/settings for the defaults
                                        and the profit centre register
Settings          /app/settings         hub; /app/settings/metakocka is the connection
```

Guided setup is `/app/setup`, five steps, reachable again from Home and
Settings. Three routes moved and redirect: `/app/settings/sales-orders` to
`/app/orders/settings`, `/app/settings/payments` to
`/app/orders/settings/payments`, `/app/settings/supply-sources` to
`/app/locations`. `tests/unit/route-table.test.ts` asserts the table, including
that `/app/orders/settings` out-ranks `/app/orders/:orderId`.

**An area is a page you land on plus a settings page behind its header
button.** Orders, Products and Locations are all built that way: the landing
page answers "is this working" with a breakdown and what is happening now, and
the settings page answers "what was it told to do". That is why the locations
route is `app.locations._index.tsx` rather than `app.locations.tsx` — a leaf
route with a child becomes a parent layout, and this one has no outlet to
render it in.

**Every redirect under `/app` goes through `redirectWithin`** in
`src/web/lib/redirects.ts`, which carries the request's query string and lets
the caller set or remove single parameters. Shopify opens the app as a
document request carrying `host`, `embedded`, `shop` and `id_token`; `host` is
what App Bridge initialises from and `id_token` is what `authenticate.admin`
reads, so a redirect that builds a fresh URL loses both and the merchant gets a
blank frame rather than an error.

It hides well, which is why it is a rule and not a review comment: in-app
navigation is a client-side fetch and the already-running App Bridge does not
care what the redirect said, so every path a person clicks through looks
right. Only a redirect on the *first* document request shows it — which is
Home sending a shop with nothing configured to guided setup, the one redirect
a merchant meets before anything else. `/auth/login` is the exception: it is
the un-embedded document and has no admin frame to preserve.

### One readiness model

`src/domain/readiness/` computes six components — MetaKocka, warehouses, stock,
orders, payments, products — each with a status, a summary, a reason and a place
to act. It is pure; `adapters/db/repositories/readiness.server.ts` gathers the
facts from our own tables in one parallel batch, so no screen waits on MetaKocka
to say whether the shop is configured. Home, the settings hub, guided setup's
review step and the order settings page all read that one answer.

The gateways a shop has used come from `order.payment_gateway` rather than from
Shopify, for the same reason.

### The activation boundary

`shop.setup_completed_at` records that a person pressed Finish setup, and
nothing else. Guided setup saves each answer into the table that already owns it
as the merchant gives it, so a shop can be connected and half-configured at the
same moment; both MetaKocka writers — `writeMetakockaOrderFor` and
`sync-inventory` — return early until that timestamp exists. Finish setup
re-checks readiness from stored state, sets the timestamp with a conditional
update, and enqueues the first order, stock and catalogue passes on throttled
keys, so pressing it twice activates once.

It is deliberately not a second answer to "is this shop configured":
`domain/readiness` answers that from the configuration, and Finish setup refuses
while readiness disagrees. `shop.setup_step` is where the wizard left off and
decides nothing. Shops that already held MetaKocka credentials were back-filled
by `20260826080000_setup_state`, so nothing that was synchronizing stopped.

`src/web/lib/locations.server.ts` holds the one implementation of connecting a
Shopify location to a MetaKocka warehouse, shared by the locations page and
guided setup, because "one writer per location" is not an invariant worth having
two of.

### Disconnecting resets the store

Disconnect on `/app/settings/metakocka` calls `resetShop`, which deletes the
`shop` row — every shop-scoped table cascades from it — removes the
`idempotency_key` rows that are keyed by domain rather than by foreign key,
and creates the shop again as a fresh install. The Shopify `session` stays:
the app is still installed and the merchant is still looking at it. The new
row has no `setup_completed_at`, so guided setup runs from the first step and
both MetaKocka writers refuse until it is finished again.

It is written as one delete rather than a list of tables on purpose: a list
is a thing that goes stale the next time a table is added, and the failure is
silent. `tests/db/disconnect-reset.test.ts` covers the two tables that do not
cascade.

It erases because almost everything here is derived from the company being
disconnected — warehouse marks and their stock directions, profit centres,
payment-type maps, the SKU register, cached registers. Keeping them and
connecting a *different* company files documents against marks that company
has never heard of, and MetaKocka accepts an unknown warehouse mark silently
and files against the company default. A stale mapping is worse than none.

**Nothing is sent to MetaKocka and nothing is deleted there.** Documents this
app filed are the merchant's accounting records; what goes is this app's copy.
Because it is unrecoverable, the button is behind typing the company ID, and
the server checks it again rather than trusting the disabled state of a
button.

### Stock direction is answered before activation, not after

The stock step asks where the shop counts stock and then asks it again per
location, defaulting to the shop answer. Both answers land on
`supply_setting.default_stock_direction` and `supply_source.stock_direction`
through the same `saveLocationMapping`, with `stock_direction_inherited`
recording which one a location took.

The per-location question is not a convenience. Finish setup starts the
five-minute stock cycle, and the first run writes real quantities: MetaKocka's
into Shopify, or Shopify's into an ERP inventory document. A store with one
MetaKocka-counted warehouse and one Shopify-counted one could previously not
say so until after activation, so the wrong direction had already been written
for one of them by the time the merchant reached the Locations page — and
neither an inventory document nor an overwritten on-hand is undone by
correcting the setting afterwards.

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

Every Shopify quantity is classified `managed`, `external` or `unresolved`
(`classifyQuantities`), and the three sum to the line — so any unit can be
answered for. A location with no supply source is `unresolved` and reported,
never guessed at; a third-party fulfilment service the app's scopes cannot
resolve is `external`, explicitly not represented in MetaKocka, and keeps the
order out of `in_sync`. A document whose supply source leaves the allocation is *retired*
according to `sales_order_setting.obsolete_document_policy`; it is never deleted
except under the explicit `delete_unpaid` opt-in, and only when unpaid.

### Shipping and discounts

Verified live before implementation (`docs/metakocka-verification.md`):
shipping is an **extra positive product line** against an article the merchant
names (`sales_order_setting.shipping_product_code`, validated against MetaKocka
when saved), and a discount is the document's own **`discount_value`**, which is
an absolute amount. The per-line `discount` field is a percentage and is
deliberately unused, because Shopify supplies amounts and converting one into
the other invents rounding.

Both are spread across a split order's documents in proportion to merchandise
value (`splitOrderMoney`), so the charge appears exactly once across the ERP and
moves with the goods when the allocation changes.

Neither has a default. Until a merchant configures them, an order carrying
shipping or a discount raises `commercial_representation_missing` and is held
out of `in_sync`: the goods are still written, and the order is never reported
as commercially reconciled while the ERP is short.

### Payments

Payments are a ledger of individual Shopify transactions, not a flag.
`src/adapters/shopify/transactions.ts` reads `order.transactions`;
`order_payment` stores one row per transaction under
`UNIQUE (shop_id, shopify_transaction_id)`, which is what makes payment
synchronization idempotent. `domain/payments/transactions` decides what counts
as money — successful `SALE`/`CAPTURE` only, never an authorization — and
`domain/payments/allocation` divides receipts across a split order's documents
so they sum to exactly what was received.

MetaKocka's replacement semantics — **live-verified on 2026-08-26**, see
`docs/metakocka-verification.md` — are used deliberately rather than worked
around: each document is sent the complete set of payment applications
*belonging to that document* (`replaceDocumentPayments`), so two captures are
two entries and re-sending an unchanged ledger changes nothing. "Complete" is
per document, never per order: a €300 order split €100/€200 sends `[€100]` and
`[€200]`, never €300 twice.

Clearing a payment sends a single **zero-amount** entry, not an empty array: an
empty array is verified to change nothing at all, and a document that keeps its
payment after its goods moved is the order recorded twice.

Refunds are recorded in the ledger and never projected onto a sales order. The
order is held at `blocked` while a credit note is outstanding, so "the Shopify
ledger is reconciled" and "MetaKocka's accounting is reconciled" stay separable
— `order.sync_detail.accounting` records both.

### Inventory

`src/jobs/handlers/sync-inventory.ts` enforces one direction per mapped
location:

- `mk_to_shopify`: MetaKocka physical `amount` becomes Shopify `on_hand`.
- `shopify_to_mk`: Shopify `on_hand` is written through MetaKocka `sync_stock`.
- `none`: this app writes neither side.

The Shopify adapter refuses writes to locations this app does not own, and
the MetaKocka write is bounded the same way: a `shopify_to_mk` sync sends a
complete list for **its own warehouse only**. Within that warehouse the list
is complete — managed products take Shopify's number, everything else
MetaKocka holds there is echoed back verbatim — because `sync_stock` removes
what it is not sent.

It briefly sent every cached warehouse, on the strength of that endpoint's
documentation asking for the total stock of all warehouses in one request.
That made a Shopify-counted location file an inventory document restating
the merchant's MetaKocka-counted warehouses, which is what one-writer
ownership exists to prevent. The documented risk of leaving a warehouse out
— that it is emptied — has never been observed and is announced by
`stock_remove_list` if it happens (T-16, T-20 in `docs/project-status.md`).

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

- tenancy and auth: `Shop` (including `setup_completed_at`, the activation
  boundary, and `setup_step`, guided setup's own place-keeping), encrypted
  `Session`, `MetakockaCredential`;
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
| What counts as configured      | `src/domain/readiness/`, then `readiness.server.ts` for the facts          |
| Guided setup step              | `src/web/routes/app.setup.tsx`; the settings it writes stay where they are |
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

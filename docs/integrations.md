# Integrations

This document describes integration ownership and code entry points. Product
requirements remain in `docs/BUILD_SPEC.md`. Observed MetaKocka behavior and
probe evidence belong in `docs/metakocka-verification.md`.

## Data ownership and direction

| Data                                     | Direction today             | Owner / implementation                                      |
| ---------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| Orders and order changes                 | Shopify → app → MetaKocka   | Per-order reconciliation loop, triggered by webhooks and a schedule |
| Warehouse allocation                     | Shopify → app → MetaKocka   | Fulfilment-order assigned location through the existing location mapping |
| Payment transactions                     | Shopify → app → MetaKocka   | `order_payment` ledger, allocated across documents, sent as a complete `mark_paid` |
| Refunds                                  | Shopify → app (reported)    | Recorded in the ledger; a credit note stays a merchant decision |
| SKU catalogue match                      | Shopify + MetaKocka → app   | `sync-catalogue` registry read                              |
| MetaKocka product names/prices on opt-in | Shopify → MetaKocka         | `sync-products`; merchant-controlled and off by default     |
| Inventory for `mk_to_shopify` locations  | MetaKocka → Shopify         | Physical `amount` to Shopify `on_hand`                      |
| Inventory for `shopify_to_mk` locations  | Shopify → MetaKocka         | Complete `sync_stock` write for that warehouse only         |
| Fulfilment-order placement               | Planned app → Shopify       | Queue exists; no consumer yet                               |
| Tracking                                 | Planned MetaKocka → Shopify | Blocked: verified sales-order payload has no tracking field |

Missing directions and product decisions are tracked in
`docs/project-status.md` rather than implied here.

## Shopify

### Access scopes the connector actually needs

| Scope | Why |
| ----- | --- |
| `read_orders` | The whole Shopify-to-MetaKocka direction: orders, line items, transactions. |
| `read_locations` | Resolving a fulfilment order's location to a supply source. |
| `read_merchant_managed_fulfillment_orders` | Which location each line ships from, which is what drives the warehouse split. |
| `read_products`, `read_inventory` | The SKU registry and stock levels. |
| `write_inventory` | Writing MetaKocka stock into Shopify for `mk_to_shopify` locations. |
| `write_products` | Merchant-enabled MetaKocka product-name and product-creation sync. Off by default. |

**`write_orders` is deliberately not requested.** Synchronising Shopify into
MetaKocka never writes to a Shopify order, so asking for it would be permission
the connector does not use — and every scope is something a merchant has to
consent to. The consequence is that order edits and payments cannot be created
from here, including for testing; the manual procedure in
`docs/development.md` covers those instead.

`write_merchant_managed_fulfillment_orders` is currently requested and its
feature (moving/splitting fulfilment orders, T-08) is not built. It is also what
made the location-move end-to-end test possible. Decide before App Store review:
either build T-08 or drop the scope (see T-07).

### Configuration and authentication

- Disconnecting MetaKocka erases this app's data for the store and restarts
  guided setup (`resetShop`); MetaKocka itself is never called or changed.
  See `docs/architecture.md` § Disconnecting resets the store.
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

**An order webhook is a trigger, never a source of truth.** Every order topic
ends in a `reconcile-order` job, which re-reads the order, its fulfilment
assignment and its transactions from the Admin API before deciding anything.
That is what makes a duplicate, late or out-of-order delivery cost one
comparison instead of a duplicated document.

### Order reads

Three Admin API reads make up an order's desired state, and each has its own
adapter so the parsers cannot drift:

- `src/adapters/shopify/orders.ts` — the order itself, mapped into the webhook
  shape so one parser serves both paths.
- `src/adapters/shopify/fulfillment-orders.ts` — which location is fulfilling
  what. Cancelled and incomplete fulfilment orders are excluded, several
  fulfilment orders for one location are folded into one entry, and a location
  this app's scopes cannot resolve is reported rather than dropped. Needs
  `read_merchant_managed_fulfillment_orders`.
- `src/adapters/shopify/transactions.ts` — the payment ledger, in presentment
  money, with amounts kept positive and direction carried by the kind.

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
  one document per supply source. A shop on
  `sales_order_setting.sales_order_split = single` writes one document for the
  whole order with **no** warehouse mark instead, which MetaKocka files against
  the company default.
- MetaKocka does not enforce `count_code` uniqueness. Never retry an ambiguous
  write without resolving whether it succeeded.
- An unknown warehouse mark is silently replaced by the company default, so
  mappings are validated against the cached warehouse register.
- Document updates replace the whole document. Payment and edit paths replay a
  complete recorded body and read it back.
- `mark_paid` is an array and an update replaces it entirely. The connector uses
  that deliberately: each document is sent the complete set of payments it
  should carry, so re-sending an unchanged ledger is a no-op and a second
  capture does not erase the first. Whether a MetaKocka company accepts a
  multi-entry array has **not** been live-verified — see
  `docs/metakocka-verification.md` — so `sales_order_setting.payment_entry_mode`
  offers an aggregate fallback.
- `delete_document` is called from exactly one place
  (`deleteSalesOrder`, reached only by `obsolete_document_policy:
  delete_unpaid`) and never for a document carrying a payment.
- Product lines are catalogue references. Sending `unit` can create a product
  accidentally, so order lines deliberately omit it.
- Stock `sync_stock` removes omitted products and can report success for a
  no-op, so the adapter sends and verifies a complete list for the warehouse
  it writes. It writes **only** the warehouse Shopify is authoritative for.
  The endpoint's documentation asks for the total stock of all warehouses in
  one request; sending them made a reverse sync restate the merchant's
  MetaKocka-counted warehouses, which section 7 forbids. See
  `docs/metakocka-verification.md` for the risk that trade accepts and how it
  is detected.
- `warehouse_stock` is read one warehouse at a time and `listWarehouseStock`
  keeps only the rows naming that warehouse. A leaked row is not a display
  error: it restates one warehouse's stock as another's, and it is what made
  a two-warehouse company's ERP totals come out doubled. `wh_id_list` is not
  verified to filter server-side.
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

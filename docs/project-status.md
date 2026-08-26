# Project status

Reviewed against the repository on 26 August 2026. This is the canonical list
of current implementation gaps, open decisions, and meaningful technical debt.
Completed work belongs in Git history, not in this file.

## Implemented

- Embedded Shopify shell, token exchange, encrypted offline sessions, app
  lifecycle, and required compliance webhooks
- MetaKocka connection, encrypted credentials, cached warehouse/payment/
  pricelist/profit-centre data, and in-app settings
- SKU registry, catalogue matching, merchant-controlled MetaKocka product-name
  and product-creation sync
- Order intake and a per-order reconciliation loop: Shopify-driven warehouse
  allocation from fulfilment orders, split/merge/move of MetaKocka sales orders,
  retirement of documents an order no longer uses, and post-pass quantity and
  value verification
- Transaction-level payment synchronization: an `order_payment` ledger keyed by
  Shopify transaction id, allocation across a split order's documents, partial
  payments, and refunds recorded without rewriting a receipt
- Merchant-configurable *Customer's order* reference, allocation mode, obsolete
  document policy, and payment allocation/entry mode
- Bidirectional inventory by per-location ownership, including destructive
  `sync_stock` safeguards
- Scheduled Shopify reconciliation, exception re-check, PII retention, dead-job
  visibility, dashboard, orders, and exceptions UI
- 491 fixture-driven tests across pure domain, adapters, presentation helpers,
  and the order-to-MetaKocka vertical slice

## Product and integration gaps

### T-05/T-06 — Shipping and discounts are not faithfully represented

Document payment shares account for shipping and discounts, but MetaKocka sales
order bodies contain product lines only. Shipping and order-level discounts can
therefore make the ERP document total differ from its payment; line discounts
are parsed and stored but are not encoded on their document line.

Do not invent a fix. The designated test company must establish whether a
service-product shipping line, document `discount_value`, and per-line
`discount` are gross/net, percentage/amount, and included in `sum_all`. Record
fixtures before changing money behavior.

### T-17 — Multi-entry `mark_paid` is not live-verified

The payment path sends each document the complete array of payments it should
carry, which is what makes an order paid twice representable and what makes a
repeated pass a no-op. `mark_paid` is documented as an array and the app has
observed a single-element one being accepted; **a multi-element array has not
been sent to a real company.** `sales_order_setting.payment_entry_mode`
(`aggregate`) exists as the fallback so a refusal is a setting change rather
than a code change.

Probe this on the designated test company before relying on it in production:
send a two-entry `mark_paid`, read the document back, and record a sanitized
request/response pair. Confirm at the same time that re-sending the identical
array leaves the document unchanged rather than adding to it.

### T-18 — Allocation follows Shopify by default, which is a behaviour change

`sales_order_setting.allocation_mode` defaults to `shopify_locations`, so a shop
that never opens the settings screen now takes its warehouse split from
Shopify's fulfilment orders instead of from cached stock levels. That is what
the connector is for — a merchant moving a line between locations should reach
the ERP — but for an existing shop whose Shopify locations do not correspond to
how they warehouse things, it changes which MetaKocka warehouse an order is
filed against.

Nothing historical is rewritten: the migration touches no rows and the existing
order-import boundary still decides which orders are acted on. The change lands
on the *next* order or the next reconciliation of an order that has moved.
Decide before wider rollout whether existing shops should be migrated to
`stock_rules` and opted in deliberately.

### T-19 — Assigned and third-party fulfilment orders are invisible

The app holds `read_merchant_managed_fulfillment_orders` only. A fulfilment
order held by a third-party service reports a location name with no id, which
the reader surfaces as `hasUnreadableLocation` and the loop fills in from stock
rules. That is safe and it is not right: those lines are filed against a
warehouse Shopify did not choose. Either request the assigned/third-party
scopes or raise an exception for that case instead of falling back silently.

### T-08 — Shopify fulfilment orders are not moved or split

`allocate-order` sends `write-shopify-fulfilment`, but the worker has no
consumer. Jobs have seven-day retention to avoid indefinite queue growth.
Implement `fulfillmentOrderSplit`/`fulfillmentOrderMove` and persist resulting
ids before removing that temporary retention. This changes merchant-visible
fulfilment state and needs real Shopify fixture/contract verification.

### T-09 — MetaKocka-to-Shopify product sync is absent

No Shopify product mutation exists. SKU, price, tax, weight, dimensions, and
barcode do not currently flow from MetaKocka to Shopify despite the target
ownership table in build-spec section 8.9. Decide whether this is v1 or phase 2.
`write_products` is otherwise unused.

### T-10 — Tracking sync is blocked on MetaKocka evidence

No job creates Shopify fulfilments with tracking. Verified sales-order
`get_document` responses contain no status or tracking field, so build-spec
section 8.5 cannot be implemented as originally written. Find and record the
actual MetaKocka delivery/tracking source first.

### T-11 — Nightly cross-checks are incomplete

Current schedules cover Shopify order reconciliation, inventory, exception
re-check, and MetaKocka document presence/content. Missing cross-checks are:

- MetaKocka `free_amount` versus Shopify available stock.

Document count, allocation-to-fulfilment correspondence and document totals
versus the Shopify total are now checked per order by the reconciliation loop
(`domain/orders/invariants`), which records `order.sync_state` and raises
`sync_inconsistent`. What is still missing is a *shop-wide* sweep of orders that
have not been reconciled recently, rather than only those something touched.

These require new exception/dashboard states rather than silent log lines.

### Configurable allocation rules and returns remain future work

The stock-rules fallback still uses the hardcoded `DEFAULT_RULE` (own stock
first, then partners, split allowed); there is no `allocation_rule` table or
rule editor. It is now a fallback rather than the primary path — Shopify's own
assignment is — so its priority has dropped accordingly.

Refunds are recorded transaction by transaction and netted, so what a customer
has actually paid is right. Automatic credit notes, returns, and complaints
remain phase 2, and deliberately so: representing a refund on a sales order
would mean shrinking a recorded receipt.

## Decisions requiring a human

### T-02/T-03 — Ambiguous MetaKocka document recovery

Probe the designated test company for `get_document` by shared `buyer_order` and
`search` by exact `count_code`. Until response shapes are recorded, recovery
must treat a sibling result as inconclusive and never blindly resend.

### T-16 — Company-wide `sync_stock` write is unverified against a live company

`pushShopifyStockIntoMetakocka` now sends every cached warehouse in one
`sync_stock` request, not only the reverse-synced one, on the strength of that
endpoint's own documentation ("the total stock for all warehouses must be sent
in one request") rather than a live probe. The designated test company has not
been used to confirm that omitting a whole warehouse from the request actually
removes its stock (or that it does not). See
`docs/metakocka-verification.md` § `sync_stock` for what is documented versus
verified, and record a sanitized multi-warehouse fixture once probed.

### T-07 — Shopify access scopes before App Store review

`write_products` and both merchant-managed fulfilment-order scopes are requested
but their target features (T-09 and T-08) are absent. Either build those before
review or remove the scopes and accept merchant re-consent if they return later.

### T-12 — Name-only partner matching can merge people

Partner resolution searches tax number, email, then name and chooses the first
ambiguous name match. This avoids duplicate ERP partners but can merge different
customers with the same name. Choose among stronger address/phone matching,
creating a duplicate, or a merchant-resolved exception before changing who an
order is filed against.

### T-13 — JSON customer PII is not column-encrypted

`order.raw_payload` and `metakocka_document.request_body` contain plaintext PII
until redaction. Secrets and sessions are encrypted, retention is enforced, and
disk/database encryption may satisfy Shopify's requirement; confirm the Level 2
expectation before designing searchable encrypted payloads.

## Engineering debt

### T-01/T-04 — Coverage and database concurrency are unmeasured

Vitest coverage tooling is not installed. More importantly, tests do not run
against PostgreSQL, so transactional enqueue, document claims, and concurrent
partner/payment/write guards are type- and unit-tested but not exercised under
real database contention. A Compose-backed Vitest project is the highest-value
test addition.

This now includes the per-order reconciliation lock
(`claimOrderReconciliation`), which is a conditional `updateMany` with a lease
and cannot be exercised without a database. Its *consequence* — that a repeated
pass over an unchanged order creates nothing — is covered at the pure level in
`tests/integration/order-reconciliation.test.ts`, but "two workers, one order,
one winner" is not. That is the single most valuable case a Compose-backed
Vitest project would buy.

### T-14 — Database boundary is not fully enforced

Many direct `prisma.*` calls remain in jobs and a few web/queue modules despite
the target rule that tenant filtering lives in repositories. Migrate one
subsystem at a time, then forbid importing the Prisma client outside
`src/adapters/db/` with ESLint.

### T-15 — Prisma's config dependency has an open security advisory

`npm audit --omit=dev` reports
[GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
against `deepmerge-ts` 7.1.5 through Prisma 6.19.3's `@prisma/config`. The flaw
requires recursive in-memory object graphs; the application does not pass
request payloads into Prisma configuration, so no exposed request path is
currently known. The audit nevertheless remains red, and the Prisma CLI ships
in the production image because the migration service uses it.

Do not accept npm's forced Prisma version change or add a transitive override
without compatibility testing. Adopt a compatible upstream fix, or validate an
upgrade/override separately against generation, all migrations, the test suite,
and both runtime images.

### UI, accessibility, and performance need measured passes

The Built for Shopify checklist has not been walked requirement by requirement.
The 375 px layout, screen-reader table semantics, save-bar behavior, hydration,
and p75 LCP/CLS/INP budgets need browser measurement. Product loaders currently
await Shopify catalogue queries; measure before changing them.

### Large modules should be split only along proven responsibilities

Several route/handler/repository files exceed 1,000 lines. They are coherent and
tested, so a cosmetic split would create churn. Extract server operations,
presentation helpers, or form sections only when a concrete change establishes
a stable boundary.

### Formatting and CI are not enforced

ESLint, typecheck, tests, and builds are documented but no CI workflow is
tracked. Prettier is configured but the existing repository does not pass a
whole-tree `prettier --check`; avoid a giant formatting-only rewrite and adopt
enforcement deliberately in a separate change.

## MetaKocka probes still outstanding

All require explicit approval and the designated test company:

- shared-`buyer_order`/`show_split_orders` and exact-`count_code` lookup;
- realistic and invoice-enabled `put_document` timing;
- public stock-webhook acknowledgement;
- full pricelist write including `lowest_price_30_days`;
- complete-document payment update and payment-survival behavior;
- shipping and discount semantics described in T-05/T-06.

See `docs/metakocka-verification.md` for completed evidence and test-company
artifacts. Never probe a production company.

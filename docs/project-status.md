# Project status

Reviewed against the repository on 19 September 2026. This is the canonical list
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
  payments, and refunds recorded without rewriting a receipt. Multi-entry
  `mark_paid` semantics are live-verified (`docs/metakocka-verification.md`)
- Real-PostgreSQL concurrency tests for the per-order lock, the `count_code`
  claim and the ledger's unique index (`tests/db/`)
- Merchant-configurable *Customer's order* reference, allocation mode, obsolete
  document policy, payment allocation/entry mode, shipping article and discount
  representation
- Shipping and discounts written into MetaKocka on verified mechanisms, spread
  across a split order in proportion to merchandise value and charged once
- Bidirectional inventory by per-location ownership, including destructive
  `sync_stock` safeguards
- Scheduled Shopify reconciliation, exception re-check, PII retention, dead-job
  visibility, dashboard, orders, and exceptions UI
- Five-area information architecture with settings under the thing they
  configure, and redirects from the three routes that moved
- The app's name in the admin nav opens Home: `/app` is the named home route
  and the root decides embedded-or-outside from the admin's own markers, so an
  installed merchant never sees the shop-domain login form
  (`docs/architecture.md` § Merchant-facing shape)
- A tax subsystem (`docs/architecture.md` § Tax decisions,
  `docs/BUILD_SPEC.md` §8.12): Shopify's transaction tax normalised at the
  boundary, one pure engine that classifies each line's treatment (domestic,
  OSS, distance sale, reverse charge, local registration, export, exempt,
  zero-rated, non-taxable), validates and maps it to a MetaKocka `tax_factor`,
  a per-order snapshot with the configuration version and content it was
  decided under, refund reversal against that snapshot, fail-closed
  exceptions in the existing queue, Taxes & VAT settings (registrations and
  policy, EU rates, mappings, overrides) with diagnostics, a tax card on the
  order page and a Taxes readiness component
- Guided setup at `/app/setup`: connect and verify MetaKocka, choose where stock
  is counted, map locations to warehouses, order reference, profit centre and
  payment types, then an explicit Finish that activates synchronization
- One readiness model (`domain/readiness`) shared by Home, the settings hub,
  guided setup and the order settings page, computed from our own tables
- An activation boundary (`shop.setup_completed_at`) both MetaKocka writers
  respect, so opening setup never starts writing
- 916 fixture-driven tests across pure domain, adapters, presentation helpers,
  the route table, the app's entry points, the order-to-MetaKocka vertical
  slice and the tax pipeline end to end, plus PostgreSQL tests for the
  reconciliation lock, the `count_code` claim, the payment ledger's unique
  index, activation idempotency, the one-writer-per-location rule, the tax
  tables and the tax migration's backfill

## Product and integration gaps

### T-05/T-06 — Shipping and discounts: representable, not yet configured

Resolved as a mechanism, live-verified on 2026-08-26
(`tests/fixtures/metakocka/shipping_discount_semantics.json`):

- **Shipping** is an extra positive product line. An extra line adds to
  `sum_all` exactly, and the article is one the merchant names —
  `sales_order_setting.shipping_product_code`, checked against MetaKocka when
  it is saved. This app never creates one.
- **Discounts** use the document's own `discount_value`, which is an
  **absolute amount**. The per-line `discount` field is a *percentage*, and
  Shopify supplies amounts, so using it would mean inventing a conversion.
- Both are spread across a split order's documents in proportion to merchandise
  value and sum to the charge exactly once (`domain/money/split`).

What remains is per shop, not per codebase: **both settings default to
unconfigured**, and an order carrying shipping or a discount then raises
`commercial_representation_missing` and is held out of `in_sync`. That is
deliberate — there is no safe default for which article an accountant expects
postage on — but it means every shop has a setup step before its orders reconcile
commercially.

**Guided setup now asks for the shipping article and refuses to continue without
one**, checked against MetaKocka the way the settings screen checks it. A shop
set up from now on therefore starts with postage representable. Readiness is
deliberately unchanged: for a shop that finished setup before this, a missing
shipping article stays a note on a working Orders component rather than a red
one, because it is a per-order condition and not a broken integration. The
discount setting keeps its safe default and is not asked for during setup.

Line-level discounts are still not represented: they are parsed and stored, and
they appear in the value reconciliation as a named unrepresented term. Folding
them into `discount_value` alongside the order-level discount is the obvious
next step and has not been done, because it changes what each *line* appears to
have cost and that is a merchant-visible accounting decision.

### T-20 — Two deliberate readiness choices worth revisiting

Both are product decisions rather than bugs, and both are visible in
`domain/readiness`:

- **A payment method this store has used, unmapped, is a caution and not a
  block.** What blocks Finish setup is the *fallback* being unchosen, because
  the fallback is the merchant's own answer for every method with no row of its
  own and is what makes an unmapped one safe rather than silent. A shop can
  therefore finish setup with, say, cash on delivery falling back to the card
  type. Readiness names the methods that fall back so it is not invisible.
  Requiring an explicit row per used gateway is the stricter reading of the
  brief and would block shops whose register genuinely has one entry.
- **The API user email is required by guided setup and only required by
  readiness when a location is counted in Shopify.** `sync_stock` is the only
  call that needs it, so a shop that never writes stock into MetaKocka is not
  held up by it after setup — but setup asks for it once, up front, because
  discovering it later means an inventory sync that silently publishes nothing.

### T-18 — Existing shops keep stock-rules allocation until they opt in

`sales_order_setting.allocation_mode` defaults to `shopify_locations`, which is
right for a shop installing the app today. It is the wrong thing to do *to* a
shop already running: its MetaKocka documents are filed against warehouses this
app chose from stock levels, and flipping the authority underneath them would
restructure those documents the next time anything unrelated touched the order.

Migration `20260826050000_existing_shops_keep_stock_rules` therefore pins every
shop that existed at that moment to `stock_rules`. Shops created afterwards have
no row and inherit the new default. Switching is one control in the
advanced order settings, which shows what will change before it is saved.

Nothing is re-sent in bulk either way: an order is only rebuilt when something
changes it or a merchant checks it by hand.

**Open decision:** whether, and how, to invite existing shops to switch. The
setting is discoverable but nothing prompts them, so a merchant who would
benefit may never look.

### T-19 — Third-party fulfilment is excluded by rule, not represented

Now visible rather than merely classified: external quantity raises an
exception, keeps the order out of `in_sync`, is recorded in `order.sync_detail`
and is stated on the order page, so a merchant cannot assume MetaKocka holds
those goods.

**The open business decision is unchanged.** If third-party-fulfilled goods
*should* appear on the MetaKocka sales order, this app cannot decide which
warehouse to file them against — the fulfilment order names a service and
withholds a location id, and no mapping exists. That needs either the
assigned/third-party fulfilment scopes plus a warehouse mapping for those
services, or an explicit rule that they are filed against a nominated warehouse.
Neither is something to guess.

The app holds `read_merchant_managed_fulfillment_orders` only, so a fulfilment
order held by a third-party or assigned service reports a location name with no
id. Those quantities are now classified `external`
(`domain/orders/canonical`): **deliberately not represented in MetaKocka**,
because the goods never pass through a MetaKocka warehouse and no mapping could
say which one, so allocating them by guesswork would misstate ERP stock.

It is explicit rather than silent — external quantity raises an exception naming
the service, keeps the order out of `in_sync`, and appears in
`order.sync_detail` — but it is still a *gap in coverage*: a merchant who
fulfils through a 3PL and invoices from MetaKocka gets a sales order short of
those goods and has to add them by hand.

Closing it properly means requesting `read_assigned_fulfillment_orders` and
`read_third_party_fulfillment_orders`, mapping those services to warehouses, and
deciding whether their stock is MetaKocka's to hold. That is a scope change and
a merchant-consent event (see T-07), so it is a decision rather than a task.

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
has actually paid is right, and each refund's tax is reversed against the
order's stored decision — per rate and per treatment — so the credit note a
person issues has its figures. Automatic credit notes, returns, and complaints
remain phase 2, and deliberately so: representing a refund on a sales order
would mean shrinking a recorded receipt, and MetaKocka's credit-note behaviour
is unverified.

### T-22 — Tax: known limits of the data this app can read

Genuine limits of the Shopify data available to this app, not gaps in the
engine:

- **B2B company tax registrations are not read.** `Order.purchasingEntity`
  (company location tax id, exemptions) needs `read_customers` and
  `read_companies`. A VAT number reaches the engine only through a note
  attribute a storefront or app wrote (`VAT number`, `Tax ID`, `DDV`…), and
  its presence alone never zeroes VAT. Adding those scopes is a merchant
  consent event (T-07).
- **Duties and import tax are not modelled.** `IMPORT` exists as a treatment
  but nothing produces it; `currentTotalDutiesSet` is not read. A DDP order
  reconciles on its tax lines alone.
- **A reference reduced rate cannot be removed**, only replaced: the country
  table holds one merchant row per (country, kind). Reduced rates are
  validation data, so the cost is at most a note on an order.
- **Sale Campaigns** are named by the product brief and do not exist in this
  repository. The engine reads Shopify's actual selling price and transaction
  tax, so any price change upstream is handled without coupling.
- **Rates are validation data, verified September 2026.** The reference
  table in `domain/tax/eu` is what the app expects, not what it files with;
  a merchant edits it on the EU VAT rates page when a country changes.

### T-23 — Existing shops: non-EU orders with no Shopify tax now wait

Before the tax subsystem the configured rate stood in for a missing Shopify
rate on every order, including one shipped outside the EU — which filed home
VAT on an export. The migration keeps the EU-wide fallback (that is what the
shop was doing) and sets the non-EU policy to `review`, so the first such
order is held with `tax_treatment_unknown` until the merchant chooses "file
as export at 0%" on the Taxes & VAT page. Deliberate: a held order is
recoverable, home VAT on an export is a correction in the books.

## Decisions taken

### D-01 — Custom (single-merchant) distribution, 2026-09-18

The app runs for one store only. The Dev Dashboard app is set to custom
distribution for that store and `shopify.server.ts` uses
`AppDistribution.SingleMerchant`. `docs/BUILD_SPEC.md` still describes a public
App Store app; those requirements (review, Built for Shopify, listing) are not
current goals. Custom distribution cannot be reverted on the same Partner app,
so a public release would mean a new app and a re-install.

## Decisions requiring a human

### T-21 — MetaKocka credentials gate is DISABLED (security, decide soon)

`src/web/lib/principal.server.ts` has `OWNER_GATE_DISABLED = true`: every
signed-in staff account counts as the store owner and can read or replace the
MetaKocka secret key, contrary to `docs/BUILD_SPEC.md` section 9. Disabled on
2026-09-18 because the people running the store are organization
administrators, not the store owner, and Shopify exposes no organization role
to apps (`StaffMemberPrivateData.permissions` and its `FULL` value are
deprecated in 2026-07). Acceptable only while the store's staff list is the
merchant's own trusted people. Before adding any further staff or
collaborators, either re-enable the gate (flip the constant) and use the owner
account, or replace it with an `ERP_ADMIN_EMAILS` allowlist read from the server
environment and matched case-insensitively against `associated_user.email`.
Remove this entry when done.

### T-02/T-03 — Ambiguous MetaKocka document recovery

Probe the designated test company for `get_document` by shared `buyer_order` and
`search` by exact `count_code`. Until response shapes are recorded, recovery
must treat a sibling result as inconclusive and never blindly resend.

### T-16 — Whether `sync_stock` empties a warehouse left out of the request

`pushShopifyStockIntoMetakocka` writes one warehouse: the one Shopify is
authoritative for. The endpoint's documentation ("the total stock for all
warehouses must be sent in one request"), read together with its
omission-removes rule, could mean every other warehouse in the company is
emptied by that request. It has never been observed, and the alternative —
sending every warehouse, which this briefly did — is a certain wrong write
on every cycle to warehouses section 7 reserves to the merchant (T-20).

Until it is probed on the designated test company, a non-empty
`stock_remove_list` is the detector: the adapter treats it as a failure and
the merchant is told. Record a sanitized multi-warehouse fixture once probed.
The same probe settles T-19 below, and the two share a fixture.

### T-20 — The app must not write a warehouse the merchant counts in MetaKocka

Section 7 gives a `mk_to_shopify` warehouse to the merchant: this app reads
it and never writes it. Sending every cached warehouse in a `sync_stock`
request broke that — one Shopify-counted location filed an inventory document
restating warehouses it had no say over, and reverted anything moved in the
ERP between the read and the write. Fixed by writing only the authoritative
warehouse.

The open decision is what to do if T-16 proves omission really does empty a
warehouse. Going back to writing warehouses this app does not own is not the
answer; sending the authoritative warehouses together, and echoing the rest
only under an explicit merchant-visible setting, is the shape to design.

### T-19 — `warehouse_stock` server-side warehouse filtering is unverified

`listWarehouseStock` sends `wh_id_list` and then drops any row naming a
different warehouse, because nothing proves the parameter filters and the
consequence of trusting it was doubled ERP stock on the `shopify_to_mk`
path. The client-side filter makes that safe either way, but two things are
still unknown: whether `wh_id_list` filters at all (if not, every read pays
for the whole company's stock list), and what shape it wants ids in. A
recorded multi-warehouse `warehouse_stock` response answers both. Until
then, a `warehouse_stock returned rows for other warehouses` warning in the
worker log is the signal that it does not filter.

### T-07 — Unused Shopify access scopes

`write_products` and both merchant-managed fulfilment-order scopes are requested
but their target features (T-09 and T-08) are absent. Harmless for a
single-merchant install (D-01); revisit before any App Store submission: either
build those features or remove the scopes and accept re-consent later.

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

**Partly addressed.** `tests/db/` now runs against the Compose database when one
is reachable and skips cleanly when not: it covers the per-order reconciliation
lock (exclusivity at two and at eight workers, lease expiry, takeover races,
release, tenant scoping), the `count_code` claim under an eight-way race, and
the payment ledger's unique index. Each file creates its own shop and deletes it
afterwards, so it touches no other tenant's rows.

Still unmeasured: Vitest coverage tooling, and the transactional
enqueue path (`enqueueInTransaction`), which needs pg-boss running rather than
just PostgreSQL.

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

This now includes the screens added or reorganized in the product UX pass:
Home, `/app/setup`, `/app/settings`, and the regrouped order settings. Their
grids use container queries rather than viewport media queries and their tables
use `variant="auto"`, which is the same approach the existing screens take, but
none of it has been measured in a browser. Guided setup's Continue button is a
step action rather than a contextual save bar; the settings pages it writes to
keep the save bar. Both readings are defensible and neither has been checked
against a reviewer.

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

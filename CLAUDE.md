# Fulfilment Orchestrator — build specification

Source of truth for this project. Read fully before writing code. Where this conflicts
with a convention you would otherwise follow, this file wins. Where this file is wrong
or stale, say so rather than working around it.

Two sets of constraints govern the work and neither yields to the other:

- **Built for Shopify (BFS) compliance** — this is a public app that must pass App Store
  review. §2 is a list of literal rejection criteria.
- **MetaKocka API reality** — §3 documents verified, non-obvious behaviour. Do not write
  MetaKocka code from memory; fetch the relevant doc page for each endpoint.

If a request conflicts with either, say so and propose a compliant alternative instead
of silently violating it.

---

## 1. What this system is

A public Shopify app that sits between a merchant's Shopify store and their MetaKocka
ERP, and owns two decisions no existing connector makes:

1. **Allocation** — for each line of each order, which supply source fulfils it and in
   what quantity, including splitting one line across sources.
2. **Availability** — how much stock is safe to publish (phase 2, see §7).

### Non-goals — do not build these

- Anything before payment: checkout modification, custom carrier rates, order routing
  functions
- Invoicing logic — MetaKocka issues invoices; we create sales orders
- A PIM
- A replacement for the merchant's existing partner stock-sync app
- Registering as a Shopify **fulfillment service** (see §2.7 — this is a deliberate
  decision, not an oversight)

---

## 2. Shopify platform rules

Reference: https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
App Bridge and Polaris have both changed shape recently; older patterns are now
rejection reasons. Check shopify.dev rather than guessing.

### 2.1 Non-negotiables

1. The app is **embedded in the Shopify admin**. Never build a standalone dashboard as
   the primary surface.
2. UI is **App Bridge web components + Polaris web components** (`s-*` custom elements).
   No competing design system, no Tailwind theming, no custom button/card styling.
   **Note:** the official Shopify app template ships Polaris *React*. Use the template
   for scaffolding, auth and webhook plumbing, but build UI with `s-*` components.
3. **No theme file writes.** Storefront output ships as theme app extensions only. The
   Asset API is read-only at most.
4. **No script tags.** Web pixel extensions or theme app extensions instead.
5. **GraphQL Admin API only**, latest stable version. No REST Admin calls.
6. Mandatory compliance webhooks exist, verify HMAC, respond 200:
   `customers/data_request`, `customers/redact`, `shop/redact`. Also `app/uninstalled`.
7. Every webhook verifies HMAC **before parsing the body** and responds within 5 seconds.
   Heavy work goes to the queue.

### 2.2 Authentication and install

- **Token exchange with App Bridge ID tokens.** Do not build a legacy OAuth redirect
  flow.
- Load App Bridge by putting the `app-bridge.js` script tag in `<head>` of **every**
  document, before any other script. Not lazy-loaded, not bundled. API key via the
  `data-api-key` attribute.
- **Seamless sign-up.** After install the merchant lands in a working app. No account
  creation, no email/password screen, no external sign-up wall.
- MetaKocka credentials are requested **inside** embedded onboarding. Linking out to
  MetaKocka's help page so the merchant can generate a key is fine; bouncing them to an
  external site to *sign up* is not.
- Offline tokens encrypted at rest. Never log tokens, HMACs, or shop-scoped secrets.

### 2.3 Access scopes

Minimum necessary. Every scope justified in the PR description.

| Scope | Why |
|---|---|
| `read_products`, `write_products` | product sync, MetaKocka → Shopify |
| `read_inventory`, `write_inventory` | read levels everywhere; write on-hand for own locations only (§7) |
| `read_locations` | map Shopify locations to supply sources |
| `read_orders` | order intake |
| `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders` | move and split fulfilment orders |

Verify the exact scope needed for `fulfillmentCreate` and for moving fulfilment orders
assigned to third-party services against current docs before adding anything further.
Do not request `read_all_orders` unless a specific requirement needs orders older than
60 days.

### 2.4 Protected customer data

Order payloads carry customer name, email, phone and shipping address, and this app
transmits them to a third-party ERP. That is **Level 2 protected customer data** and
requires an approved application with a documented justification, plus:

- **Data minimisation.** Only request and store the fields needed to create a MetaKocka
  partner and receiver. Do not store what we do not send.
- **Encryption at rest** for customer PII.
- **Retention policy, enforced in code.** Raw Shopify order payloads are kept 90 days,
  then a scheduled job redacts PII from `order.raw_payload` and from
  `metakocka_document.request_body` while preserving the decision trail (SKUs,
  quantities, sources, rule reasons, document ids). The audit log survives; the personal
  data does not.
- `customers/redact` and `shop/redact` must **actually delete**, not soft-delete. Test
  this.
- Staff access to PII in any internal tooling is logged.

This conflicts with "keep everything forever for the audit trail." The retention job is
how the conflict is resolved — do not skip it.

### 2.5 Performance budgets

BFS thresholds at p75 of admin page loads:

| Metric | Budget |
|---|---|
| LCP | ≤ 2.5 s |
| CLS | ≤ 0.1 |
| INP | ≤ 200 ms |
| Storefront Lighthouse impact | ≤ 10 point drop |

Consequences that bind this app specifically:

- Server-render the first meaningful screen. Never a blank shell that fetches after
  hydration.
- **Never block first paint on MetaKocka.** MetaKocka calls can take tens of seconds
  (§3). No page load may await one. Render from our database, refresh in the background.
- Reserve layout space: skeletons with fixed dimensions, explicit `width`/`height` on
  images, no late-inserted banners.
- Batch GraphQL. A query inside a loop is an automatic review comment.
- Leaky-bucket-aware client with exponential backoff. Bulk operations above ~250 records
  — relevant to initial product sync.
- Long-running sync work runs in background jobs with idempotency keys, never in a
  request handler.

### 2.6 UI rules

These are literal rejection criteria.

**Structure.** `s-app-nav` for primary navigation, integrated into the admin nav. No
custom sidebar, no emoji in nav items, sub-pages highlight their parent. No nav item
that just links to app home. Every sub-page has a back button. `s-page` / `s-app-window`
for page chrome — the deprecated Polaris Fullscreen bar is banned. Modals use `s-modal`
with `heading` and the `primary-action` / `secondary-actions` slots; never loose buttons
in the modal body.

**Forms.** Saving goes through the **contextual save bar**. No bespoke Save button in a
card. Block navigation while the save bar is active. Break large forms into grouped
sections — one giant form is a rejection reason. This applies to the settings screens in
M2 and the rules editor in M6.

**Visual.** Content in cards that look like admin cards. Polaris button variants only —
no green or purple primaries. No serif or script body copy. Admin background colour, no
dark theme. Polaris spacing tokens. WCAG 2.1 AA contrast. Icons consistent within a
group: all or none. No flicker, no layout jumping.

**Responsive.** Works at 375 px with no horizontal scroll. Multi-column layouts stack.
Nothing becomes unreachable. This matters for the exceptions queue and the order detail
timeline, which are the two widest screens.

**App name** must not truncate when pinned in the admin nav.

### 2.7 Home page and integration

- **Primary workflows stay inside the admin.** A feature that can only be completed on
  an external site is not done.
- The MetaKocka connection can be **connected and disconnected from inside Shopify** at
  any time.
- **The home page must be dynamic and diagnostic** — a static welcome card fails BFS.
  It shows: setup state, whether syncing is working, and real metrics. For this app:
  orders received today, automatically allocated, awaiting attention; last successful
  MetaKocka write; last stock reconciliation and its result; open exceptions by type.
  This is the operations dashboard, and BFS requires it, so build it in M4 rather than
  deferring.
- **Clean uninstall.** On `app/uninstalled`: revoke tokens, cancel all scheduled jobs
  for that shop, and purge shop data per §2.4.

**Fulfillment service — a decision, not a default.** Registering supply sources as
Shopify fulfillment services would trigger category SLAs: tracking added within an hour
on 80 % of fulfillments, fulfillment requests answered within 24 h (95 %), cancellations
within 24 h (99 %). Those SLAs would depend on *partners'* behaviour, not ours. v1 uses
merchant-managed locations and does **not** register a fulfillment service. Revisit only
with an explicit decision.

### 2.8 Content and behaviour

**Errors** are red, **persistent** (never a self-dismissing toast), and rendered next to
the field they concern. A red field always has a message. No error before the merchant
has interacted with the field. Error text says what is wrong *and* how to fix it. "Sync
failed" is a rejection; "MetaKocka rejected profit center 'Partner1' — it must exist in
MetaKocka before it can be selected here" is not.

**Copy.** Correct spelling and grammar, especially headings, nav labels and buttons.
Labels state units: "Reconciliation interval (minutes)", not "Interval". Concise and
scannable, no paragraphs of prose in the UI.

**Onboarding.** Short, guided, easy to find, removable once complete. Never imply another
app must be installed. Explain why each piece of information is needed — particularly the
MetaKocka secret key, where the merchant deserves to know it grants full ERP access.

**Dark patterns, all banned.** No guaranteed outcomes or promised results of any kind. No
countdown timers, urgency, or guilt-trip copy. No incentivised review requests. No modals
on page load, on a timer, or after an unrelated action. No attention-seeking animation.
Red is reserved for errors and destructive actions. Never two banners close together. All
promotional content dismissible, and it stays dismissed. Do not resemble a first-party
Shopify app — no Shopify-like icon, no Sidekick icon, no Shopify "magic purple".

**Plan gating.** Plan-locked features are visually *and* functionally disabled with the
required tier named. Never let a merchant complete a form and only then discover it is
paid. Shopify Plus-only features are hidden entirely from non-Plus merchants.

---

## 3. Hard facts about MetaKocka

Verified from https://github.com/metakocka/metakocka_api_base
Base URL: `https://main.metakocka.si/rest/eshop/v1/`

### Authentication
Every request body carries `secret_key` and `company_id`. That is the entire model — no
OAuth, no scopes, no rotation, no read-only mode. The key has full write access to the
merchant's ERP. Treat it as a production database password (§10).

### Sales orders
- `put_document` with `doc_type: "sales_order"`.
- **`warehouse`, `profit_center`, `delivery_type` and `parcel_shop_id` are
  document-level, not per-line.** One sales order = one warehouse = one profit center.
  This is the single most important constraint in the system.
- A split order therefore becomes **N sales orders, one per supply source** (decided).
- `count_code` is the external reference. Derive deterministically:
  `SH-{shopifyOrderNumber}-{sourceCode}`.
- `customer_order` links sibling documents. All documents from one Shopify order share it.
- `get_document` / `search` support `show_split_orders` — investigate before finalising
  reconciliation queries.
- Lines in `product_list` with `code`, `amount`, and `price` or `price_with_tax`.
  **Always `price_with_tax` for webshop orders** — the docs say so explicitly.
- Tax is a `tax` code string or a `tax_factor` decimal (`"0.22"`).
- `create_invoice: "true"` creates the invoice in the same call and returns `bill_mk_id`
  inside `attachment_list`. The documented example reports ~47 seconds. Never inline.
- `mark_paid` on an update **deletes the previous payment and replaces it**.
- Northern Ireland uses country `"United Kingdom - Northern Ireland"` or `"XI"`, not
  `"UK"`.

### Products
- `product_add` / `product_update` / `product_list` / `product_delete`. **No bulk
  endpoint** — one product per call. Initial catalogue sync is a long job.
- Fields: `count_code`, `code`, `barcode`, `name`, `name_desc`, `unit`,
  `service`/`sales`/`purchasing`, dimensions, `weight`, `gross_weight`, `min_stock`,
  `minimal_order_quantity`, `localization[]`, `categories[]`, `pricelist[]` with tiered
  `price_def` including `lowest_price_30_days` (Omnibus).
- `supplier_info.partner_id` sets the supplier.
- `product_partner_info[]` holds each partner's own code and name for the product.
  **Use it** — the supplier ↔ SKU mapping belongs in the ERP, not only our database.
- `compound` supports bundles. Out of scope for v1; note in the schema.

### Stock
`warehouse_list`, `warehouse_stock`, `source_stock`, `import_inventory`.
`warehouse_stock` returns `amount`, `reserved_amount`, `free_amount`. See §7 for which
number is correct.

### Webhooks (MetaKocka → us)
- **Only one event exists: `warehouse_product_stock_update`.** No order webhook, no
  document webhook, no tracking webhook. Everything else is polling via `search` by last
  change timestamp, status change, or last tracking event change date.
- HMAC-SHA1 over the raw body with `client_secret`, Base64, header
  `X-MetaKocka-Signature`. Event id in `X-MetaKocka-Id`.
- Our endpoint **must** return JSON containing `check_respond_status_json_ok: true`.
- On failure MetaKocka retries **twice, 60 s apart, then gives up.** Two retries is not
  reliable delivery — scheduled full reconciliation is mandatory.

### Rules endpoints
`get_order_change_warehouse` / `replace_order_change_warehouse` and the forbidden-products
equivalent are **replace-the-entire-set**. No single-rule insert, update or delete.
Read-modify-write behind an advisory lock or corrupt the merchant's rules.

Those rules match `from_status_list`, `from_warehouse_mark_list`,
`from_delivery_type_list`, `product_code_list` → `to_warehouse_mark`, `to_delivery_type`.
A static lookup table: no quantity awareness, no stock awareness, no priority, no
splitting. Our allocation engine sits above this ceiling — that is the product.

### What the API cannot do
- Allocate one order line across two warehouses.
- Create or list profit centers, warehouses or pricelists. They must pre-exist in the
  MetaKocka UI and be referenced by exact string, with no validation endpoint.
- Push notification of anything except stock.
- Provide idempotency keys. Duplicate prevention is entirely ours.
- Return machine-readable errors. Failures are `opr_code` plus a human-readable
  `opr_desc`. Build our own classifier.

### Data format
Numbers come back as **strings**. Dates are inconsistent: ISO-with-offset
(`"2024-09-12+02:00"`) in most fields, `dd.mm.yyyy` in `mark_paid`. Decimal commas appear
in the docs' own examples (`"gross_weight": "0,8"`). Parse and normalise at the boundary
with Zod; never let a raw MetaKocka value reach domain code. MetaKocka keeps its own API
log for **two months only** — our audit log is the permanent record, subject to §2.4
retention.

---

## 4. Tech stack

Pinned. Do not substitute without asking.

| Concern | Choice | Note |
|---|---|---|
| Runtime | Node 22 LTS | |
| Language | TypeScript, `strict: true` | `noUncheckedIndexedAccess` on |
| Scaffolding | Official Shopify app template (React Router 7) | Not Next.js — that template is deprecated |
| Admin UI | App Bridge + Polaris **web components** (`s-*`) | Deviates from the template's Polaris React |
| Database | PostgreSQL 16 | |
| ORM / migrations | Prisma | |
| Job queue | pg-boss | In Postgres; gives transactional enqueue (§8.1) |
| Validation | Zod | Every external boundary, no exceptions |
| Tests | Vitest | |
| HTTP mocking | MSW with recorded fixtures | |
| Logging | pino, structured JSON, redaction list | |
| Errors | Sentry or self-hosted GlitchTip | |
| Deployment | Docker Compose on one Linux VM | `postgres`, `web`, `worker`, `caddy` |
| TLS | Caddy | Automatic Let's Encrypt |

Two Node processes from one image: `web` (admin UI + webhook receivers) and `worker`
(pg-boss consumer + schedules).

---

## 5. Repository layout

```
src/
  domain/          pure logic — no I/O, no imports from adapters/ or jobs/
    allocation/
    availability/  phase 2
    money/         split arithmetic (§8.6)
    types.ts
  adapters/
    shopify/       GraphQL client, webhook verification, mappers
    metakocka/     client, Zod schemas, mappers, error classifier
    db/            Prisma client and repositories
  jobs/            pg-boss handlers and schedules
  web/             routes and s-* component UI
prisma/
tests/fixtures/    recorded MetaKocka and Shopify responses
```

**Enforced import direction** (add an ESLint rule): `domain/` imports nothing from the
others. `adapters/` may import `domain/`. `jobs/` may import both. `web/` may import
`adapters/` and `domain/`, never `jobs/`.

`domain/allocation` is a **pure function**:

```ts
allocate(input: {
  lines: OrderLine[]
  supply: SupplyLevel[]
  rules: AllocationRule[]
  now: Date            // injected, never Date.now()
}): AllocationResult
```

No network, no database, no clock, no randomness. Highest-risk logic in the system;
must be testable in milliseconds.

---

## 6. Data model

Every table carries `shop_id`, `created_at`, `updated_at`.

**`shop`** — domain, offline token (encrypted), install state, uninstalled_at.

**`metakocka_credential`** — shop_id, company_id, secret_key (encrypted), webhook
client_secret (encrypted), last_verified_at.

**`sku`** — shop_id, sku, shopify_variant_id, shopify_inventory_item_id, metakocka_code,
metakocka_mk_id, status. Unique (shop_id, sku).

**`supply_source`** — shop_id, code, name, kind (`own` | `partner`), shopify_location_id,
`inventory_writer` (`metakocka` | `external` | `manual`), metakocka_warehouse,
metakocka_profit_center, priority, lead_time_days, default_delivery_type, can_split,
enabled.

**`supply_level`** — supply_source_id, sku_id, quantity, reserved, observed_at.
Unique (supply_source_id, sku_id).

**`order`** — shop_id, shopify_order_id, shopify_order_number, customer_order_ref, status,
raw_payload (jsonb, PII-redacted after 90 days), financial_status, presentment_currency,
received_at.

**`order_line`** — order_id, sku_id, quantity, unit_price_with_tax (minor units),
tax_factor, shopify_line_item_id.

**`allocation`** — order_line_id, supply_source_id, quantity, status (`planned` |
`written_to_shopify` | `written_to_metakocka` | `failed` | `manual`), reason (jsonb: which
rule fired and why).

**`metakocka_document`** — order_id, supply_source_id, is_primary, doc_type, count_code,
mk_id, status, payment_marked_at, request_body (jsonb, redacted after 90 days),
response_body (jsonb). Unique (shop_id, count_code) — the duplicate guard.

**`payment_type_map`** — shop_id, shopify_gateway, metakocka_payment_type.

**`allocation_rule`** — shop_id, priority, condition (jsonb), action (jsonb), enabled.
Rules are data, not code.

**`event_log`** — shop_id, entity_type, entity_id, event, detail (jsonb), at. Append-only.
The audit trail is a product feature, not debug output.

**`exception`** — shop_id, order_id, kind, message, detail (jsonb), status, resolved_by,
resolved_at.

**`idempotency_key`** — shop_id, scope, key, first_seen_at, result (jsonb).
Unique (shop_id, scope, key).

pg-boss creates its own schema. Leave it alone.

---

## 7. Shopify inventory — one writer per location

The merchant also runs a separate app that writes **partner** stock into Shopify. Two
apps writing one location is a write loop. The rule is ownership, not silence.

`supply_source.inventory_writer` is one of:

- `metakocka` — this app writes it from MetaKocka stock (own warehouses)
- `external` — another app owns it (partner locations). **Never write these.**
- `manual` — a human owns it. Never write.

Enforce in the inventory adapter: it throws for any location whose writer is not
`metakocka`. Not a convention — a throw.

### Which number to push

| MetaKocka | Meaning | Shopify equivalent |
|---|---|---|
| `amount` | physical stock; drops when a delivery note / packing list is issued | **on hand** |
| `reserved_amount` | claimed by open sales orders | ≈ committed |
| `free_amount` | `amount - reserved_amount` | ≈ available |
| `order_in_delivery` | on order from a supplier, not in the warehouse | nothing — not sellable |

**Write `amount` to Shopify's `on_hand`. Never write `available`.**

Shopify computes available as on hand minus committed itself. Pushing `free_amount` into
available subtracts the same open order twice — once via MetaKocka's reservation, once via
Shopify's committed count — and the store undersells silently. `amount` → on hand is the
only pairing that does not double-count.

`free_amount` is a **monitoring** value: compare it to Shopify's available nightly; a
persistent gap is an exception, not a number to write. `order_in_delivery` is never
published as sellable in v1.

**This depends on `amount` not dropping at sales-order creation. Verify it (§14.8) before
relying on it.** If it does drop, the correct source becomes `amount + reserved_amount`.

### Mechanics

Prefer 1:1 warehouse ↔ location; if several warehouses map to one location, sum `amount`
and log that the breakdown was flattened. Write only on change — keep the last written
value per (location, inventory item) and skip no-ops. Use `inventorySetQuantities` with
`name: "on_hand"`, a stable `reason`, and `ignoreCompareQuantity: false`. **Loop
prevention:** we receive `inventory_levels/update` for our own writes — compare against
the last value written and drop matching events. Full stock reconciliation runs on a
schedule regardless, because MetaKocka's webhook gives up after two retries.

Safety stock and virtual availability (phase 2) need a location this app exclusively
owns. Never attempt it by writing partner locations.

---

## 8. Core flows

### 8.1 Order intake

```
Shopify orders/create webhook
  → verify HMAC on the raw body, respond 200 within 5 s (no work here)
  → in ONE transaction: insert order + order_lines, enqueue `allocate-order`
```

The transactional enqueue is why we use pg-boss. Never insert and enqueue in separate
transactions.

### 8.2 Allocation

```
job allocate-order
  → load lines, supply levels, rules
  → domain.allocate(...)   [pure]
  → persist allocations + reason
  → enqueue `write-shopify-fulfilment-orders`
  → enqueue one `write-metakocka-order` per supply source
```

If a line cannot be fully satisfied, do not guess: allocate what can be satisfied, mark
the remainder `manual`, raise an exception (§11).

### 8.3 Shopify fulfilment orders

Move and split fulfilment orders so each maps to one supply source's location
(`fulfillmentOrderMove`, `fulfillmentOrderSplit`). Record resulting ids on the allocation.

### 8.4 MetaKocka sales orders

One job per supply source. Each job:

- builds `count_code` = `SH-{orderNumber}-{sourceCode}`
- checks `metakocka_document` for that `count_code`; if a successful row exists, **return
  without calling MetaKocka**
- sets document-level `warehouse`, `profit_center`, `delivery_type` from the source
- sets `customer_order` to the shared reference
- maps partner (buyer) and receiver (shipping address) separately — they differ for gift
  and B2B orders
- sends `price_with_tax` on lines
- records request and response bodies regardless of outcome

Do **not** set `create_invoice` in v1. Invoicing stays a merchant decision.

### 8.5 Tracking back to Shopify

Scheduled job polls MetaKocka `search` for sales orders changed since the stored cursor,
extracts tracking codes, creates Shopify fulfilments with tracking. Never re-scan from the
beginning.

### 8.6 Money on a split order

One Shopify payment becomes N MetaKocka documents. Decided once, here, asserted in tests.

- One document is **primary**: highest line total, ties broken `own` before `partner`,
  then by source code. Stored as `metakocka_document.is_primary`.
- Line items go on the document for their allocation; a split line appears on both with
  split quantities.
- **Shipping, COD surcharge and order-level discounts go on the primary document only.**
  Never spread them — they are single charges, not per-source costs.
- Line-level discounts stay with their line.
- **Rounding:** compute in integer minor units. The documents must sum to the Shopify
  order total exactly; assign any remainder to the primary. Assert in the integration
  test — a one-cent drift becomes a manual reconciliation for someone.
- **Currency:** use the Shopify presentment currency and amount, set `currency_code`.
  Never silently convert to shop currency.
- **Tax:** derive `tax_factor` per line from Shopify tax lines, not a product default —
  the same SKU has different rates across markets. Handle tax-inclusive and tax-exclusive
  stores.

### 8.7 Payments

| Shopify `financial_status` | Action |
|---|---|
| `pending`, `authorized` | Create the sales order. Do **not** mark paid. |
| `paid` | Mark paid, dated from the Shopify transaction. |
| `partially_paid` | Create the order, raise an exception. Do not guess. |
| `refunded`, `partially_refunded` | See §8.8. |
| `voided` | Exception. Never auto-delete the MetaKocka document. |

**Cash on delivery is not paid at order time.** Set `method_of_payment` to the COD value
and leave the document unpaid. Marking a COD order paid at creation misstates the books.

**`mark_paid` is destructive on update** — it deletes and replaces the previous payment.
Send it exactly once, record `payment_marked_at`, and never include it in a routine
update. Correcting a payment is a deliberate, logged, single-purpose job.

**Gateway mapping.** `payment_type` must match a type in the merchant's MetaKocka
register, and no endpoint lists them. Use `payment_type_map`, expose it in settings, and
raise an exception on an unmapped gateway rather than guessing. Gift cards and store
credit map through the same table.

**Date format:** `mark_paid.date` is `dd.mm.yyyy`, unlike the ISO-with-offset elsewhere in
the same payload. Format explicitly at the boundary.

**Split orders:** each document is marked paid for its own share, summing per §8.6.

### 8.8 Refunds, cancellations, edits

Not implemented in v1, but the webhooks are **received and turned into exceptions from day
one** so nothing is lost silently: `refunds/create`, `orders/cancelled` (never auto-delete
a MetaKocka document — it may already be invoiced), `orders/edited` (allocation and
documents already exist; automatic re-allocation is a phase 2 decision).

Phase 2 maps these to MetaKocka credit notes and the complaint endpoints
(`create_complaint`, `update_complaint`, `get_complaint`).

### 8.9 Product sync

Field ownership is fixed and enforced in code. Never let both sides own a field — that is
how you build a nightly flip-flop.

| Field | Master | Direction |
|---|---|---|
| SKU / code, price, tax | MetaKocka | MK → Shopify |
| Weight, dimensions, barcode | MetaKocka | MK → Shopify |
| Supplier and partner codes | MetaKocka | read only |
| Customer-facing title | Shopify | Shopify → MK (`name` only) |
| Images, SEO, collections | Shopify | not synced |
| Inventory quantity | §7 | on-hand, own locations only |

Use Shopify bulk operations for reading the catalogue; MetaKocka has no bulk endpoint, so
writes are sequential and rate-limited.

### 8.10 Reconciliation

Nightly, and mandatory because MetaKocka's webhook gives up after two retries:

- every Shopify order in the window has the expected number of MetaKocka documents
- every allocation has a corresponding fulfilment order
- document totals sum to the Shopify order total
- last-observed stock still matches `warehouse_stock`; MetaKocka `free_amount` still
  agrees with Shopify available

Every discrepancy becomes an exception, never a silent log line. Results surface on the
home page (§2.7).

---

## 9. Multi-tenancy

- Token exchange, offline token per shop (§2.2).
- Identity from the App Bridge ID token. **No separate login, no user table in v1.**
- Gate the MetaKocka credentials screen to the shop owner; staff accounts must not read or
  set the ERP key.
- Every query filters by `shop_id`, enforced in the repository layer so route code cannot
  forget.
- Background jobs have no session. Put a thin `Principal` abstraction
  (`ShopSession | ServiceToken`) in front of the service layer now, so a partner portal can
  be added later without a rewrite.

---

## 10. Secrets

MetaKocka `secret_key` and webhook `client_secret` encrypted with AES-256-GCM, master key
from environment, never in the repo — `sops` + `age` if the env file is committed. Once
saved, never return a key to the browser; show `••••1234`. pino redaction covers
`secret_key`, `client_secret`, `access_token`, and customer PII fields. Shopify HMAC
verification uses the **raw** body — configure the framework to preserve it.

---

## 11. Errors and exceptions

Three distinct things. Do not conflate them.

**Retryable failure** — network error, 5xx, timeout. pg-boss retries with exponential
backoff. No human involved, no UI.

**Exception** — a business condition needing a human: SKU not in MetaKocka, profit center
rejected, insufficient stock across all sources, unmapped payment gateway, partner
disabled, tax undeterminable. Goes in the exceptions queue with the order, reason, raw
error, and actions: retry, change supply source, force own warehouse, ignore.

**Form validation error** — subject to §2.8: red, inline, persistent, actionable, and never
shown before interaction.

Classify MetaKocka `opr_code` / `opr_desc` into retryable vs exception in exactly one place
(`adapters/metakocka/errors.ts`). Never swallow an error. Never let a failed MetaKocka
write leave the order looking successful.

---

## 12. Testing

- `domain/allocation` needs exhaustive unit tests: zero stock, exact stock, partial stock,
  split disabled, source below minimum, same SKU on two lines, zero quantity, source
  disabled mid-order, priority ties.
- `domain/money` needs tests proving documents always sum to the order total, including
  odd cents and three-way splits.
- All Shopify and MetaKocka interaction tested against **recorded fixtures**. Capture real
  responses once. Never hit a live ERP from tests.
- One integration test running the full v1 slice against fixtures: webhook in, allocations
  out, two MetaKocka request bodies asserted field by field.
- `docker compose up` brings up a working system in one command. If setup needs manual
  steps, fix the setup.

---

## 13. Build order

Do not start a milestone before the previous one runs.

**M1 — skeleton.** Shopify template scaffolded, token exchange working on a dev store,
App Bridge in `<head>`, compliance webhooks responding, Postgres + pg-boss under Compose,
health endpoint, Sentry wired.

**M2 — connection.** MetaKocka credentials in embedded onboarding, encrypted storage,
"Test connection" calling `warehouse_list`, warehouse/location/profit-center mapping,
payment gateway mapping. All forms on the contextual save bar. Disconnect works.

**M3 — catalogue.** SKU registry, variant ↔ article matching by code, review screen for
unmatched SKUs.

**M4 — the vertical slice, plus the diagnostic home page.** Order webhook → allocation with
one hardcoded rule (own first, then partner, split allowed) → fulfilment orders split →
two MetaKocka sales orders → order detail page with the full decision trail → home page
showing live counts and last-sync state.

*Demo target: an order for 8 units where own stock is 5 splits 5/3, lands as two MetaKocka
documents whose totals sum to the Shopify total, and the audit log explains why.*

**M5 — robustness.** Exceptions queue with actions, nightly reconciliation, tracking sync
back to Shopify, stock writes for own locations, PII retention job.

**M6 — configurable rules.** Move the hardcoded rule into `allocation_rule` rows; build the
rules UI in grouped sections.

**Phase 2:** virtual availability with safety stock, partner portal, returns and complaints,
bundles via `compound`, Omnibus `lowest_price_30_days`, App Store submission and billing.

---

## 14. Verify against a MetaKocka test company first

Separate test `company_id`. Never point development at production — there is no sandbox
flag, only a different company. Record every response in `tests/fixtures/`.

1. Create two sales orders sharing one `customer_order` with different warehouses. Check
   `show_split_orders` and whether it looks acceptable in the MetaKocka UI.
2. Send a `profit_center` that does not exist. Record the exact error.
3. Time `put_document` with realistic line counts, with and without `create_invoice`.
4. Register the stock webhook; confirm our response format is accepted.
5. Push one product with a full pricelist including `lowest_price_30_days`.
6. Create a sales order with `mark_paid`, run `update_document` **without** `mark_paid`,
   confirm the payment survives. Then send `mark_paid` again and confirm it replaces.
7. List the payment types in the test company and the exact strings `payment_type` accepts.
8. **Read `warehouse_stock` for a product with an open sales order and confirm `amount`
   does not drop at sales-order creation.** §7 depends on this. If it does drop, the
   correct value to publish is `amount + reserved_amount`.

Report results before building on top of them.

---

## 15. Conventions

Sentence case in UI copy. No emoji anywhere — code, UI, commits, nav. Conventional commits.
No `any`; no `as` across a boundary — parse with Zod. No `Date.now()` in domain code;
inject the clock. Money as integer minor units internally, converted at the boundary; never
float. One migration per logical change; never edit an applied migration. If a requirement
here is ambiguous or looks wrong once you are in the code, stop and ask — do not invent a
MetaKocka field name or a Polaris component name.

---

## 16. Definition of done

Before reporting any task complete:

- [ ] Renders embedded, App Bridge loaded from `<head>`
- [ ] Uses `s-*` components; no custom-styled buttons, cards, or nav
- [ ] Forms wired to the contextual save bar with navigation blocking
- [ ] Errors red, inline, persistent, actionable
- [ ] No layout shift; skeletons fixed-dimension; images explicitly sized
- [ ] Works at 375 px with no horizontal scroll
- [ ] No new scopes without justification; no REST Admin calls; no query in a loop
- [ ] No page load awaits a MetaKocka call
- [ ] Rate limiting and retry handled; long work queued; idempotency key present
- [ ] No script tags, no theme file writes
- [ ] Customer PII: only what is needed, encrypted, covered by the retention job
- [ ] Copy checked for spelling, grammar, units, and outcome claims
- [ ] Contrast checked against WCAG 2.1 AA

If any box cannot be ticked, report it explicitly rather than marking the task done.

# Fulfilment Orchestrator — build specification

Source of truth for product requirements and the architecture target. Read the
relevant sections before changing code, and read it fully before broad
architectural work. `docs/architecture.md` maps the current implementation and
`docs/project-status.md` records target features or constraints that are not yet
implemented. Where this specification is wrong or stale, correct it from
evidence rather than working around it.

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
5. **GraphQL Admin API only**, using the latest stable version supported by the
   pinned Shopify SDK. Bump the SDK/client and webhook version together as a
   deliberate, tested change. No REST Admin calls.
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

Verified from https://github.com/metakocka/metakocka_api_base and, where marked
**[verified]**, against test company 6789 on 2026-08-24. Full results in
`docs/metakocka-verification.md`. Where the two disagree, the observed behaviour
wins.

Base URL: `https://main.metakocka.si/rest/eshop/v1/`

**[verified] Endpoint paths split into two families and the wrong one returns an
HTML 404, not a JSON error.** `warehouse_list`, `warehouse_stock` and
`product_list` answer on `{base}json/{endpoint}`; `put_document`,
`get_document` and `delete_document` answer on `{base}{endpoint}`. There is no
rule to derive this from. Probe a new endpoint before using it and record it in
`adapters/metakocka/endpoints.ts`.

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
- **[verified] `count_code` is not unique on MetaKocka's side.** Re-sending an
  existing `count_code` does not fail and does not return the existing document:
  it creates a second document under MetaKocka's own numbering (`1/2026`), which
  can no longer be found by the `count_code` we sent. The duplicate guard in §8.4
  is therefore the only thing preventing duplicate sales orders, and an ambiguous
  timeout must be resolved by lookup, never by blind retry.
- **[verified] `buyer_order` links sibling documents**, not `customer_order`.
  A `customer_order` field sent on `put_document` is silently discarded; only
  `buyer_order` persists and only `buyer_order` is searchable. All documents from
  one Shopify order share it.
- **[verified] An invalid `warehouse` is silently accepted.** Sending a warehouse
  mark that does not exist returns `opr_code 0` and files the document against the
  company default instead. MetaKocka validates `profit_center` and does not
  validate `warehouse`, so `supply_source.metakocka_warehouse` must be validated
  against `warehouse_list` by us, on save and before use.
- **[verified] A line is a catalogue reference, and `unit` is what turns it into a
  new product.** An unknown `code` is refused with `opr_code 8`, "Product with
  code X not found - unit must be set to add new product" — so sending `unit` on
  a document line makes MetaKocka **create the catalogue product from the
  order**. Never send it. `name` is pointless too: MetaKocka overrides it with
  the catalogue's own name for a product that exists, and it only describes a
  manual line for one that does not. Validate the SKU against the catalogue
  before writing and raise an exception instead (§11).
- **[verified] Inline partner data creates a new partner every time.** Sending
  `partner: { customer, street, ... }` on a document does not match an existing
  record, it makes another one — two documents for one customer left company 6789
  with two "Grega Rotar" partners. Resolve the partner first with `get_partner`
  (searchable by `partner_tax_number`, `partner_email`, `partner_name`,
  `partner_phone_number`), create it with `add_partner` only when there is none,
  and reference it on the document.
- **[verified] Referencing a partner needs an address as well as an id.**
  `partner: { mk_id }` alone is refused with "Partner must have mk_address_id or
  customer and street for address identification." Send `mk_id` plus either
  `mk_address_id` (from `partner_delivery_address_list`, type "Račun" for
  billing) or `customer` and `street`.
- **[verified] `sales_pricelist_code` is how a document records which prices
  applied.** Omitted, the order is filed against no pricelist at all, and
  nobody opening it in MetaKocka can tell what it was priced from.
- **[verified] `get_document` takes `doc_id`, not `mk_id`.** Sending `mk_id`
  answers "Cannot find document type sales_order with id = null". The value to
  put in `doc_id` is the `mk_id` that `put_document` returned.
- **[verified] `get_document` returns the whole document at the top level**, with
  `mk_id`, `count_code`, `doc_date`, `partner`, `receiver`, `sales_pricelist_code`,
  `currency_code`, `buyer_order`, `warehouse`, `product_list`, `sum_basic`,
  `sum_tax_ex4`, `sum_all`, `profit_center`, `order_create_ts`, `created_ts`.
  **There is no status field of any kind on a sales order, and no tracking
  field.** So there is no ERP workflow state to poll for, and §8.5's tracking
  sync will have to find its codes somewhere else.
- **[verified] A document this app wrote can simply stop existing.** Asking for a
  `doc_id` MetaKocka no longer has answers `opr_code 2`, "Cannot find document
  type sales_order with id = 1200049905201" — the same code as a malformed
  request, so the description has to be read rather than the code. Two of four
  documents on the test company had been deleted in the MetaKocka UI while this
  app still reported those orders as sent. Deleting a document there is a thing
  merchants do, and nothing else in this system would ever find out (§8.11).
- `get_document` / `search` support `show_split_orders` — investigate before finalising
  reconciliation queries.
- Lines in `product_list` with `code`, `amount`, and `price` or `price_with_tax`.
  **Always `price_with_tax` for webshop orders** — the docs say so explicitly.
- Tax is a `tax` code string or a `tax_factor` decimal (`"0.22"`).
- **[verified] MetaKocka will not infer a line's tax rate, and zero is not a safe
  default.** Omitting `tax_factor` is refused even when the product carries a
  pricelist entry with a rate on it. Sending `"0"` *is* accepted, and produces a
  line of 209.00 net at 0% where the pricelist says 171.31 at 22% — the right
  gross, a net matching nothing, and VAT understated to the tax office. Sending
  `"0.22"` produces `price 171.31 / price_with_tax 209 / tax EX4`, which is the
  correct line. So when Shopify supplies no rate — any shop with no tax
  registration for that market, which includes every development store — use the
  shop's configured VAT rate. Only `taxable: false` means zero.
- **[verified] Tax on a line is not optional.** A line whose product carries no
  `tax` attribute in MetaKocka is rejected with `opr_code 6, "Attribute 'tax' for
  product with code 'X' or name 'Y' must be set."` So `tax_factor` is always sent,
  including `"0"`. Deriving that zero is legitimate when Shopify reports
  `total_tax: 0.00` or `taxable: false` — that is the ERP being told what the
  customer actually paid — but when tax *was* charged and Shopify has not broken
  it down per line, the rate is undeterminable and the order becomes an exception
  (§11) rather than a guess.
- **Send `price` for a tax-exclusive shop, `price_with_tax` for a tax-inclusive
  one.** The docs say webshop orders should always send gross, which holds only
  while `taxes_included` is true. Shopify's `price` is net when it is false, and
  putting a net figure in `price_with_tax` understates every line by the VAT rate.
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
- **[verified] A pricelist is net or gross, and it is not Shopify's choice.**
  Every pricelist has its own price type, fixed when it was created. Sending the
  wrong field is refused outright — pricelist `1` on company 6789 answers
  `opr_code 2, "Pricelist '1' has 'net' price type. Use 'price' instead of
  'price_with_tax' to set the product price on the pricelist."` — and, worse,
  sending the wrong *amount* is not refused at all. A Shopify gross price of
  209.00 written into a net pricelist is stored as 209.00 net, a price 22% too
  high, with no complaint. So the amount must be restated on the pricelist's
  basis (`domain/money/tax.ts`), not merely relabelled. The rejection names the
  type, so a wrong setting is self-correcting on the next call.
- **[verified] `count_code` and `code` are not the same thing.** Products created
  in the MetaKocka UI carry an internal `count_code` (`"4451"`) and the SKU in
  `code`. `product_update` selected by `count_code` fails with
  `"Product with count_code 'X' does not exist."` for those — match on `code`,
  update by `mk_id`.
- **[verified] `product_list` omits prices unless asked.** Pass
  `return_pricelist: "true"` or the response carries no `pricelist` at all,
  which looks exactly like a product with no prices.
- `supplier_info.partner_id` sets the supplier.
- `product_partner_info[]` holds each partner's own code and name for the product.
  **Use it** — the supplier ↔ SKU mapping belongs in the ERP, not only our database.
- `compound` supports bundles. Out of scope for v1; note in the schema.

### Stock
`warehouse_list`, `warehouse_stock`, `source_stock`, `import_inventory`.
`warehouse_stock` returns `amount`, `reserved_amount`, `free_amount`. See §7 for which
number is correct. **[verified]** all three are returned by default with no flag, the
response list is `stock_list`, and `product_code_list` matches the product's `code`,
not its `count_code`.

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
  `opr_desc`. Build our own classifier. **[verified]** codes so far: `0` success,
  `2` request not accepted as written, `6` a general rejection. `6` was first
  seen as "Profit center 'X' doesn't exist." and was briefly assumed to mean
  "named entity does not exist"; a live order then returned `6` with "Not valid
  date for doc_date", so **the code alone does not identify the cause** and an
  exception kind must be read from `opr_desc`. Anything unrecognised is an exception, not
  a retry.

### Data format
Numbers come back as **strings**. Dates are inconsistent: ISO-with-offset
(`"2024-09-12+02:00"`) in most fields, `dd.mm.yyyy` in `mark_paid`.

**[verified] `doc_date` accepts `dd.mm.yyyy`, and its ISO form only works with a
hardcoded `+02:00`.** Probed against company 6789 by sending `put_document` with a
profit centre that cannot exist, so MetaKocka refuses before creating anything and the
error says whether the date got past validation:

| `doc_date` | result |
|---|---|
| `25.08.2026`, `15.01.2026` | accepted |
| `2026-08-25+02:00`, `2026-01-15+02:00`, `2025-08-25+02:00` | accepted |
| `2026-08-25` (bare) | rejected |
| `2026-08-25+00:00`, `2026-08-25-04:00` | rejected |
| `2026-08-25+01:00`, `2026-08-25+03:00`, `2025-01-15+01:00` | rejected |
| `2026-08-25+0200`, `2026-08-25T09:52:00+02:00` | rejected |

**`+02:00` is a literal, not a timezone.** It is refused in January only if you change it
to the real Ljubljana winter offset, and accepted in January when left at `+02:00`. So the
ISO form documented throughout MetaKocka's own docs is only usable by hardcoding an offset
that is wrong for five months of the year, and any implementation that computes the true
offset breaks between late October and late March.

Use `dd.mm.yyyy` — the same format `mark_paid` already requires — and take the calendar
date in the ERP's timezone, not UTC and not the shop's. A document date belongs to the
ledger it is filed in: an order placed at 23:00 in New York is the next day in Ljubljana.

Decimal commas appear
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
| HTTP testing | Recorded fixtures with injected fetch clients | Never call live services from tests |
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

**Enforced import direction** (implemented in ESLint): `domain/` imports nothing from the
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

Tenant-owned records are scoped to a shop either directly with `shop_id` or
through a required parent relation. Persistent application models carry creation
and update timestamps unless an external storage contract dictates their shape.
`prisma/schema.prisma` is authoritative for the implemented physical model; the
list below is the conceptual target and omits later operational/cache fields.

**`shop`** — domain, offline token (encrypted), install state, uninstalled_at.

**`metakocka_credential`** — shop_id, company_id, secret_key (encrypted), webhook
client_secret (encrypted), last_verified_at.

**`sku`** — shop_id, sku, shopify_variant_id, shopify_inventory_item_id, metakocka_code,
metakocka_mk_id, status. Unique (shop_id, sku).

**`supply_source`** — shop_id, code, name, kind (`own` | `partner`), shopify_location_id,
`inventory_writer` (`metakocka` | `external` | `manual`), stock_direction,
stock_direction_inherited, metakocka_warehouse, metakocka_profit_center,
profit_center_inherited, priority, lead_time_days, default_delivery_type, can_split,
enabled. The two `_inherited` flags say whether the value beside them came from
`supply_setting`; the value itself stays materialised here (§7).

**`supply_setting`** — shop_id (unique), default_stock_direction,
default_profit_center. The answers a source inherits unless it overrides them.

**`metakocka_profit_center`** — shop_id, value, is_valid, validated_at.
Merchant-maintained, because MetaKocka can neither list nor validate profit
centres (§3, §7). Unique (shop_id, value).

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

**[verified] Stock moves in one of two directions per warehouse, chosen by the
merchant.** This section originally modelled only MetaKocka → Shopify. Some
warehouses are counted in Shopify instead, and those write back to the ERP:

| Direction | Meaning | Mechanism |
|---|---|---|
| `mk_to_shopify` | MetaKocka is counted | `warehouse_stock.amount` → Shopify `on_hand` |
| `shopify_to_mk` | Shopify is counted | Shopify `on_hand` → MetaKocka `sync_stock` |
| `none` | neither is copied | nothing is written |

`supply_source.stock_direction` holds the choice, and `inventory_writer` follows
from it: only `mk_to_shopify` gives this app the pen for a Shopify location.
Stock is never copied both ways for one warehouse.

### The settings model: shop defaults, per-location overrides

The merchant answers "where is stock counted" once for the store, not once per
warehouse. Two tables hold it:

- **`supply_setting`** — one row per shop. `default_stock_direction` and
  `default_profit_center`.
- **`supply_source.stock_direction_inherited` / `.profit_center_inherited`** —
  whether this source took the default or chose for itself.

**The effective value stays materialised on the source.** `stock_direction` and
`metakocka_profit_center` are still the single columns the sync engine and the
order writer read, with no default to resolve at read time. Changing a default
therefore writes through to every source flagged as inheriting, in
`saveSupplyDefaults`. The alternative — a nullable column meaning "ask the
shop" — pushes that resolution into every reader, including the two places where
getting it wrong publishes the wrong stock.

Two rules survive a write-through, and both live in
`domain/supply/defaults.ts` so they can be tested without a database:

- A source with **no Shopify location** gets `none` whatever the default says.
  It stays flagged as inheriting, so connecting a location later picks the
  default up.
- **One writer per location still wins.** An inherited source that would become
  a second `mk_to_shopify` writer for a location is left alone and named back to
  the merchant, never silently skipped. An explicit override outranks a default,
  so its claim is counted first.

A migration that introduces a default must back-fill both flags to `false`:
values a merchant configured one at a time are deliberate choices, and they
become explicit overrides rather than being reset to something they have never
seen.

### Profit centres are a register, not a text field

MetaKocka refuses a whole document over a profit centre it does not recognise
(§3), and §3 also records that it will neither **list** profit centres nor
**validate** one. The payment-type trick does not transfer: that rejection
enumerates the valid set, and this one only ever says
`"Profit center 'X' doesn't exist."`.

So `metakocka_profit_center` is a **merchant-maintained register**, checked as
each entry is added, and every field that needs a profit centre is a choice over
it rather than free text. A typo is then caught once, on the settings screen,
instead of on an order days later.

**The check is a probe, and it needs a control.** `adapters/metakocka/probe.ts`
sends a sales order that MetaKocka is guaranteed to refuse — a sentinel
`payment_type` — and the refusal is the read. Sending the value under test on
that document gives two readable outcomes: the error names the profit centre
(wrong), or the error lists payment types (validation got past it, so it is
right).

That second inference only holds if MetaKocka checks the profit centre **before**
the payment type. Nothing documents the order, and assuming it backwards would
call every value valid, including the typos. So `validateProfitCenters` first
probes a profit centre that cannot exist: if MetaKocka names it, the ordering is
established; if it answers about payment types instead, every verdict is
`unknown`.

**`unknown` is an answer, not a failure.** A value that could not be checked is
stored unchecked and the merchant is told, never refused — being unable to ask
is our problem, not theirs. Only an explicit rejection refuses. A rejected entry
is kept in the register and marked, because a supply source may still point at
it and removing it would make that source look unconfigured rather than broken.

Nothing above is on the page-load path (§2.5). The register is re-checked
nightly by `reload-profit-centers`, beside the payment-type reload and for the
same reason: each check is a request designed to fail, and running it every
fifteen minutes would fill the merchant's own MetaKocka API log with rejections
that are not failures.

**Writing back is destructive by design. Two verified hazards:**

- **Omission removes.** `sync_stock` deletes anything absent from `stock_list`,
  so the payload must describe the *whole* warehouse. Products this app does not
  manage are sent back at the value MetaKocka already holds
  (`buildCompleteStockList`), which makes removal-by-omission impossible.
- **A no-op reports success.** Posting without `stock_list` returns
  `opr_code 0, "Sync successful"` having changed nothing. Never trust the code
  alone; check that the returned `stock_list` matches what was sent.

`sync_stock` also sits on its own base path — `/rest/eshop/sync_stock`, no `v1`,
no `json` — and needs an `api_user_email` that the secret key does not carry.
Writing stock creates an inventory document in MetaKocka: it is an accounting
action, not a cache update.


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

**[verified] `amount` does not drop at sales-order creation.** An order for 2 units
left `amount` at 10 and moved 2 into `reserved_amount`, with `free_amount` the
difference. `amount` → on hand is confirmed correct; no fallback to
`amount + reserved_amount` is needed.

### Mechanics

Prefer 1:1 warehouse ↔ location; if several warehouses map to one location, sum `amount`
and log that the breakdown was flattened. Write only on change — keep the last written
value per (location, inventory item) and skip no-ops.

**[verified] The write shape on API 2026-07, corrected against the live schema.** This
section previously specified `ignoreCompareQuantity: false`, which does not exist:

- `InventorySetQuantitiesInput` has `name`, `reason`, `referenceDocumentUri` and
  `quantities` only. There is no `ignoreCompareQuantity`, so there is no unconditional
  set.
- `InventoryQuantityInput` calls the guard `changeFromQuantity`, not `compareQuantity`.
  Introspection reports it optional; the API rejects the mutation without it. Send the
  value read from the location in the same run.
- **Both `inventorySetQuantities` and `inventoryActivate` require the `@idempotent(key:)`
  directive** and fail with `BAD_REQUEST` without it. Derive the key from the job id and
  the batch contents: a retry sending the same numbers is then recognised as one write,
  a retry that re-read different numbers is applied, and a later run that happens to
  repeat an earlier batch — stock going 10, 5, 10, 5 — is not swallowed by the cached
  result of the first.
- `inventorySetQuantities` only speaks about items that already have a level at the
  location. A product held in MetaKocka but never stocked at the mapped Shopify location
  has none, and is stocked with `inventoryActivate(…, onHand:)` instead. Without that
  step its stock never reaches Shopify at all. `inventoryActivate` takes one item per
  field, so batch them as aliases in one document rather than a query in a loop.

**Write-loop prevention:** there is currently no `inventory_levels/update`
subscription. The app reads Shopify-to-MetaKocka locations on the five-minute
cycle and writes only when the value differs; MetaKocka-to-Shopify writes also
skip no-ops using the last observed/pushed state. If an inventory webhook is
added later, compare it with the last app write before scheduling another one.
Full stock reconciliation still runs on a schedule because MetaKocka's webhook
gives up after two retries.

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

Current status: allocation enqueues this work, but no worker consumes that queue
yet. See `docs/project-status.md` T-08.

### 8.4 MetaKocka sales orders

`sales_order_setting.sales_order_split` decides how many documents an order
becomes.

**`per_warehouse` (default).** One job per supply source. Each job:

- builds its internal claim key = `SH-{orderNumber}-{sourceCode}`, from the
  frozen `customer_order_ref`
- checks `metakocka_document` for that key; if a successful row exists, **return
  without calling MetaKocka**. This is not an optimisation: MetaKocka happily creates a
  duplicate document under its own numbering (§3), so this check is the duplicate guard.
  The key is **internal** and derived from a value frozen at intake, so no merchant
  setting can move it — see *Numbering* below
- validates the source's `metakocka_warehouse` against `warehouse_list` before sending,
  because MetaKocka accepts an unknown warehouse silently (§3)
- sets document-level `warehouse`, `profit_center`, `delivery_type` from the source
- sets `buyer_order` to the shared reference (not `customer_order`, §3)
- maps partner (buyer) and receiver (shipping address) separately — they differ for gift
  and B2B orders
- sends `price` or `price_with_tax` according to Shopify's tax-inclusive setting
- records request and response bodies regardless of outcome

**`single`.** One job for the whole order, keyed by `WHOLE_ORDER_DOCUMENT` and
stored with `metakocka_document.supply_source_id = NULL`. It does everything
above except the warehouse: `count_code` is the order reference with no source
suffix, every line of the order is on the one document at full quantity, no
`warehouse` mark is sent — so MetaKocka files it against the company default —
`profit_center` comes from `supply_setting.default_profit_center` and no
`delivery_type` is sent. Nothing is allocated, so §8.2 does not run and
`allocation_mode` has no effect. Every other rule here — the `count_code` claim,
the ambiguous-write lookup, the update policy of §8.8, the money split of §8.6,
the payments of §8.7 and the verification of §8.10 — is unchanged.

This is a merchant's choice and it has a stated cost: MetaKocka no longer
records which warehouse the goods left from. It is offered because a shop that
does not keep its warehouses in MetaKocka gets nothing from the split except two
documents per order, each filed against a warehouse nobody meant to use.

**Numbering.** `count_code` is what MetaKocka's screen labels *Sales ord. no.*,
and §3 verified it is **not unique** there — so it is a number and never an
identity. `sales_order_setting.sales_order_numbering` decides who chooses it:

- `app` (default): the number is rendered from
  `sales_order_number_template`, which defaults to *the order's
  `customer_order_ref`* rather than to a second copy of
  `DEFAULT_CUSTOMER_ORDER_TEMPLATE` — so a merchant who customised their
  reference gets a matching document number and the two cannot drift apart.
  A `per_warehouse` document suffixes `-{sourceCode}`, because siblings cannot
  share a number.
- `metakocka`: **no `count_code` is sent at all** — the field is absent, not
  empty — and MetaKocka's own sequence answers. Whatever it returns is recorded
  in `metakocka_document.sent_count_code`, so the number is known from the first
  write onwards: every later update sends the same one back, and every message
  about the document names something the merchant can find.

The number is settled once, when the row is claimed, and frozen there for the
same reason `customer_order_ref` is frozen at intake: a document's number is an
accounting record, and re-rendering it after a template change would renumber
documents MetaKocka already holds. It is cleared only when the drift poller
finds the document deleted in MetaKocka, so the rewrite is numbered afresh.

`metakocka_document.count_code` therefore means **the app's internal claim key**
and nothing else. `sent_count_code` is what MetaKocka holds, and is what every
merchant-facing message and screen names.

One consequence is stated rather than hidden: under `metakocka` numbering an
ambiguous write (§8.4's `buyer_order` lookup) cannot be resolved by comparing
numbers, because this app has none of its own. For an unsplit order the document
found under the reference is necessarily the one, and is adopted; for a split
order it is not, so the merchant is asked. That cost is paid only by a write
whose outcome was already unknown.

Do **not** set `create_invoice` in v1. Invoicing stays a merchant decision.

### 8.5 Tracking back to Shopify

Target: create Shopify fulfilments with tracking from a stored MetaKocka cursor,
never by rescanning from the beginning. This is currently blocked: verified
sales-order `get_document` responses contain no status or tracking field, so the
actual delivery/tracking source must be identified and recorded before a job can
be designed. See `docs/project-status.md` T-10.

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

Current status: shipping, document-level discounts, and line-level discounts are
not yet encoded faithfully in the MetaKocka request body because their API
semantics have not been verified. See `docs/project-status.md` T-05/T-06.

### 8.7 Payments

| Shopify `financial_status` | Action |
|---|---|
| `pending`, `authorized` | Create the sales order. Do **not** mark paid. |
| `paid` | Mark paid, dated from the Shopify transaction. |
| `partially_paid` | Create the order, raise an exception. Do not guess. |
| `refunded`, `partially_refunded` | See §8.8. |
| `voided` | Exception. Never auto-delete the MetaKocka document. |

**An order's payment state is not settled at intake, and the app has to keep listening.**
Most Slovenian orders arrive `pending` — bank transfer, cash on delivery, a manual method
— and become `paid` minutes or days later. `orders/create` says nothing about that, so the
app subscribes to **`orders/updated` and `orders/paid`**, and reconciles orders against
the Admin API on a schedule as well (§8.10). The three are deliberately redundant: a
webhook is best-effort, and a payment nobody hears about is a payment the merchant chases
by hand.

The decision itself is pure and lives in `domain/orders/state.ts`. It is written as a
function of the **destination** status rather than of the transition, because Shopify does
not promise to deliver every intermediate state and the reconciler routinely sees pending
jump straight to refunded.

**Cash on delivery is not paid at order time.** Set `method_of_payment` to the COD value
and leave the document unpaid at creation. Marking a COD order paid at creation misstates
the books — but that rule is about *order time*: when Shopify later reports the order as
paid, the courier has remitted and the payment is recorded like any other
(`jobs/payment.ts`, `phase: "settle"`). Enforcing it as "never" left every COD order
permanently unpaid in the ERP.

**Recording a payment after the fact means re-sending the whole document.** MetaKocka
treats an update as a replacement (§3), so `mark-metakocka-paid` replays the exact body
recorded in `metakocka_document.request_body` with `mk_id` and `mark_paid` added, then
reads the document back to check it still has its lines. A rebuilt body is never sent: it
could replace the document with a differently derived version of itself. Past the §2.4
redaction the stored body no longer holds the customer, so the job stops and raises an
exception rather than filing "[redacted]" on a live accounting document.

**`mark_paid` is destructive on update** — it deletes and replaces the previous payment.
Send it exactly once, record `payment_marked_at`, and never include it in a routine
update. Correcting a payment is a deliberate, logged, single-purpose job.

**Gateway mapping.** `payment_type` must match a type in the merchant's MetaKocka
register, and no endpoint lists them. Use `payment_type_map`, expose it in settings, and
raise an exception on an unmapped gateway rather than guessing. Gift cards and store
credit map through the same table.

**Date format:** `mark_paid.date` is `dd.mm.yyyy`, unlike the ISO-with-offset elsewhere in
the same payload. Format explicitly at the boundary.

**Split orders:** each document is marked paid for its own share, summing per §8.6. Not
only the primary — that understates the payment by the rest of the order. There is no
double counting to avoid here, because the shares sum to the Shopify total by
construction; double counting would only happen if each document were paid the *order*
total. `jobs/order-shares.ts` computes them once for both the create and the settle path,
so the two cannot drift.

### 8.8 Refunds, cancellations, edits

Refunds and credit notes are not implemented in v1, but every one of these webhooks is
**received and acted on from day one** so nothing is lost silently.

Topics whose payload is the order — `orders/updated`, `orders/paid`, `orders/cancelled` —
go to `sync-order-state`, which compares the payload against what is stored and acts only
on what moved. `refunds/create` and `orders/edited` carry something else (a refund, an
edit), so they queue a read of the order from the Admin API and go through the same
comparison.

**An edit reaches MetaKocka** (`contentChangePolicy`):

- **No document written.** The edit is simply what the order is: the lines are rewritten
  and the order is allocated again. Raising an exception here, which the app used to do
  for every edit, asks a person to resolve something nothing had gone wrong with.
- **A document written.** The lines are rewritten, the order is allocated again, and each
  existing document is **updated in place**. This is a change from the original §8.8,
  which said never to touch a written document: in practice that left the ERP holding
  quantities nobody had agreed to while the merchant read an exception they could not act
  on. **[verified 2026-08-25]** raising a line from 1 to 2 rewrote `SH-1006-GLAVNO` from
  836.00 to 1045.00 under the same `mk_id` and the same `count_code` — no second document.

  MetaKocka has no partial update, so the document is rebuilt whole and swapped
  (`updateSalesOrder`), then read back to confirm every line survived. Any payment already
  recorded is put back on the body, because §8.7's warning that `mark_paid` on an update
  replaces the previous payment means an update without one silently unpays the document.

  Whether this happens at all is `sales_order_setting`, on the Sales orders page:
  `update_on_change` (on by default) and `update_after_paid` (**off** by default, because
  a paid document is the one most likely to have been invoiced, and rewriting an invoiced
  document changes an accounting record). With either switched off the old behaviour is
  exactly what happens — an `order_diverged` exception naming the difference, and "Mark as
  sorted in MetaKocka" on the order page to settle it.
- **A line that moves to a different warehouse** is the one part an update cannot cover:
  the document written for the old source now describes goods this order no longer takes
  from there. Emptying it is not automatic and deleting it is forbidden outright, so that
  stays an exception naming the document.

An order that arrives already cancelled, refunded or voided — which only happens through
the recovery path — is recorded and **not** allocated. Creating a sales order for money
that no longer exists, when undoing it is never automatic, is the one mistake worth
designing out.

Phase 2 maps these to MetaKocka credit notes and the complaint endpoints
(`create_complaint`, `update_complaint`, `get_complaint`).

### 8.9 Product sync

Field ownership is fixed as the target. Never let both sides own a field — that
is how you build a nightly flip-flop. MetaKocka-to-Shopify product writes in the
table are not implemented today; the current app only reads/matches the two
catalogues and performs merchant-enabled Shopify-to-MetaKocka name/creation
writes. See `docs/project-status.md` T-09.

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

**The catalogue read is on a schedule, not only on a button.** A registry that is as fresh
as the last time somebody remembered to press Sync is a registry that silently stops
matching — a product renamed in the ERP, a SKU corrected in Shopify, a variant added this
morning — and the first anyone hears of it is an order that cannot be sent. Off by
default with a merchant-chosen interval (`product_sync_setting.schedule_enabled`,
`.schedule_interval_minutes`), because this is the one scheduled job that can write into
the merchant's ERP catalogue.

The same read collects what makes a product list readable — image, price, vendor, product
type — since it is already walking every variant. A list of bare codes is a diagnostic,
not a product list: a merchant looking for "the blue one" recognises it by its picture and
its price.

**Creating articles is a merchant-controlled exception to the table above.** A Shopify SKU
with no MetaKocka article can be neither stocked nor ordered, so the app can create one:
`product_add` with `count_code` and `code` set to the SKU, the barcode, and a name built
from a template the merchant writes (`domain/products/template/`). Where this
departs from the table, it does so deliberately and only when asked:

- **Price and tax on creation only**, behind their own switch, off by default. The price
  goes into a pricelist whose `count_code` the merchant names, because §3 says a pricelist
  cannot be created through the API. Whether Shopify's number is `price` or
  `price_with_tax` is read from the shop's `taxesIncluded` setting, never assumed.
- **An article that already exists keeps its price and tax.** Updates send `name` and
  nothing else, so MetaKocka stays master for everything in the table for every article it
  already owns.
- **Renaming is a three-way choice** — always, only when MetaKocka's name is empty, or
  never — because a merchant who edits names in the ERP must be able to keep them.

Everything here defaults to off. This is the only place in the app that writes into the
ERP's catalogue.

### 8.10 Reconciliation

**Orders, every fifteen minutes.** `reconcile-orders` re-reads everything Shopify has
touched since a stored `updated_at` watermark and applies it through the same path as the
webhooks. This is not a nicety: Shopify retries a failed delivery for a while and then
stops, an app that is down for an afternoon never hears what happened in it, and delivery
order is not promised. So the watermark is read with five minutes of overlap — re-reading
an order costs one comparison that finds nothing, missing one is silent — and
`order.shopify_updated_at` is a high-water mark, so a late webhook cannot undo a newer
state. The same pass ingests orders `orders/create` never delivered, and re-queues an
order that was allocated and then had nothing written for half an hour.

Its first run never looks further back than the install, so a fresh install does not
manufacture ERP documents for orders the merchant handled before this app existed.

**`order.raw_payload` is refreshed on every sync, changed or not.** It is Shopify's whole
record of the order, not a copy of the diff's inputs, and it is what the document writer,
the partner resolver and the tax re-derivation all read. The diff deliberately watches
only what this app would *send differently*, so treating "nothing actionable moved" as
"nothing to store" left every field outside the diff able to go stale permanently. It did:
an order created with no address, given one in Shopify a minute later, synced, correctly
diffed as unchanged — and the payload carrying the address was discarded, so the order
could never be sent however many times anyone pressed retry. The customer is now in the
snapshot as a fingerprint (never the details themselves — the summary reaches the event
log, which the §2.4 job does not cover), and an address *arriving* re-drives the write
without being treated as a divergence: there is no document yet to be wrong.

**Every caller that re-reads a stored payload must use `parseOrderSafe`.** After ninety
days the §2.4 job has replaced `customer`, `billing_address` and `shipping_address` with
the string "[redacted]", and a schema expecting an object throws on it. Null says "too old
to send" without taking the job down.

**Stock every five minutes, and immediately on the MetaKocka webhook.** §3 records
that `warehouse_product_stock_update` is the only event MetaKocka pushes and that it
retries twice and gives up, which makes it a nudge rather than a delivery. The receiver
verifies HMAC-SHA1 over the raw body with the webhook `client_secret`, answers
`check_respond_status_json_ok: true`, and does nothing but queue the sync — publishing
stock is an accounting-grade decision (§7) and belongs in the job that knows the rules.
The five-minute cycle beside it is the guarantee.

**Open exceptions every fifteen minutes** (§11).

**MetaKocka documents hourly** (§8.11).

**Everything else nightly**, and mandatory because MetaKocka's webhook gives up after two
retries. These cross-checks are the target and are not yet implemented; the
current schedules above do run. See `docs/project-status.md` T-11:

- every Shopify order in the window has the expected number of MetaKocka documents
- every allocation has a corresponding fulfilment order
- document totals sum to the Shopify order total
- last-observed stock still matches `warehouse_stock`; MetaKocka `free_amount` still
  agrees with Shopify available

Every discrepancy becomes an exception, never a silent log line. Results surface on the
home page (§2.7).

### 8.11 What MetaKocka does with a document afterwards

The reconciler above watches Shopify get ahead of us. This is the same problem in the
other direction, and it needed its own answer because **MetaKocka will not tell us
anything**: §3 verified that the only event it pushes is a stock update.

**[verified 2026-08-25]** Two of the four documents this app had recorded as `written` on
the test company had been deleted in the MetaKocka UI. The app reported those orders as
sent and would have done so indefinitely. So `poll-metakocka-documents` reads each written
document back hourly for thirty days and asks the two questions that have answers:

- **Is it still there?** A `doc_id` MetaKocka does not have is not a failure — it means
  somebody deleted the document. The row is marked `failed`, which is both the truth and
  what lets the `count_code` claim be taken again (§8.4) so the merchant can send it
  afresh. Nothing is re-sent automatically: deleting it may well have been deliberate.
- **Does it still say what we sent?** Compared against `metakocka_document.request_body`,
  the exact body MetaKocka accepted, and **by line code and quantity rather than by
  total** — what this app sends is gross or net depending on the shop's tax setting (§8.6)
  while `sum_all` is always gross, so comparing totals would report every document on a
  tax-exclusive shop as edited.

Both raise an exception and neither is repaired automatically. §8.8's rule holds in this
direction too: the document may already be invoiced.

Note what this means for "the merchant says it is dealt with". `order_diverged` is cleared
by a person pressing **Mark as sorted in MetaKocka**, which records their decision and
sends nothing — the button is named for what it does. This poller is the backstop that
keeps that from being a way to hide a real difference.

---

## 9. Multi-tenancy

- Token exchange, offline token per shop (§2.2).
- Identity from the App Bridge ID token. **No separate login, no user table in v1.**
- Gate the MetaKocka credentials screen to the shop owner; staff accounts must not read or
  set the ERP key.
- Every query must filter by tenant. The repository layer is the target boundary
  so route/job code cannot forget; existing direct Prisma calls outside that
  boundary are tracked in `docs/project-status.md` T-14 and should be migrated
  subsystem by subsystem.
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

**An exception is a condition, not an event, and the app has to keep checking.** "No
supply source has enough stock" stops being true the moment stock arrives; "the profit
centre does not exist" stops being true when the merchant creates it; nothing announces
either. Left alone, the queue fills with problems that were dealt with days ago, and a
queue nobody trusts is a queue nobody reads. So `recheck-exceptions` re-evaluates every
open exception every fifteen minutes and does one of three things:

- **Closes it** when the work actually got done, attributed to the app so the trail says
  it was not a person.
- **Re-drives it** when the blocker is gone but the work has not been redone, leaving the
  exception open on purpose: it closes when the retry succeeds, and if the retry fails
  again the merchant is still reading a true statement.
- **Leaves it** — the safe direction to be wrong in. Anything this app cannot see the
  fix for (a refund credited by hand, a document edited in the ERP) stays until a person
  says otherwise.

**Retry must re-drive the step that failed, not the pipeline.** It used to re-queue the
allocation whatever had gone wrong, so for a rejected sales order it re-ran the one step
that had never failed and the button appeared to do nothing.
`adapters/queue/redrive.server.ts` maps each kind to the job that answers it, and is
shared by the exceptions page, the order page and the re-check so all three mean the same
thing. Where nothing can be re-driven it says so rather than running a job that changes
nothing.

**Every exception must be solvable from inside the app** (§2.7: a feature that can only be
completed on an external site is not done). Two that were not:

- *"No supply source has enough stock — choose a source by hand"* was advice with nowhere
  to act on it. The order page now sets sources per line, showing what each one holds and
  deliberately **not** refusing a source with none — that is the whole point of an
  override. A hand-made allocation is locked (`order.allocation_locked_at`) so the next
  stock sync does not silently revert it.
- *"This order has no billing or shipping address — add it in Shopify"* is impossible for
  point-of-sale orders, digital goods and some draft orders. `order.partner_override`
  holds customer details entered on the order page, and both the document writer and the
  partner resolver prefer it, so the two cannot file the order against different people.

**Form validation error** — subject to §2.8: red, inline, persistent, actionable, and never
shown before interaction.

Classify MetaKocka `opr_code` / `opr_desc` into retryable vs exception in exactly one place
(`adapters/metakocka/errors.ts`). Never swallow an error. Never let a failed MetaKocka
write leave the order looking successful.

---

## 12. Testing

- `domain/allocation` needs exhaustive unit tests: zero stock, exact stock,
  partial stock, split disabled, same SKU on two lines, zero quantity, a disabled
  source, and priority ties. A minimum-order rule belongs here only after the
  model has such a concept.
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

**Results are in `docs/metakocka-verification.md`.** Items 2, 7, 8 and 9 are
answered; items 1 and 3 are partial; items 4, 5, 6 and 10 remain open. The
findings that changed this document are marked **[verified]** in §3 and §7.

1. Create two sales orders sharing one `buyer_order` with different warehouses. Check
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
9. ~~**`get_document`'s response shape.**~~ **Answered on 2026-08-25**: the document
   comes back at the top level, `product_list` and `sum_all` included, and there is no
   status or tracking field. Recorded in §3. The read-back check in `markDocumentPaid`
   still treats a missing `product_list` as "could not tell" rather than as "the lines
   are gone", which is the right way round to be wrong.
10. **`put_document` with `mk_id` and the complete original body.** That a *partial*
    update destroys the document is verified. That re-sending the whole body leaves it
    unchanged apart from the payment is inferred from the same behaviour — a replacement
    replacing a document with itself — and is what the payment path depends on. Create a
    multi-line sales order on the test company, mark it paid this way, and confirm the
    lines, totals and pricelist all survive.

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

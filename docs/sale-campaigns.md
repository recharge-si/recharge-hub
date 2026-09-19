# Sale campaigns

Visible storefront sales, made by writing Shopify's own variant `price` and
`compareAtPrice`. Not a Shopify discount: nothing here touches checkout, and
standard Liquid (`product.compare_at_price > product.price`) renders the sale
with no storefront script.

This document is the design and the map of the implementation. It was written
as the implementation plan and kept current; where the code and this document
disagree, the code is right and this document is the bug.

## What the module owns, and what it does not

| Recharge Hub owns                                                      | Shopify owns                                |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| The campaign: what it targets, how much, when, under which policy      | The current selling price                   |
| The snapshot of every price it changed, kept until restore is verified | Presentation (Liquid, themes, channels)     |
| The expected sale price, so an external change can be told apart       | Checkout discounts (codes, automatic, BXGY) |

A campaign writes `price = sale`, `compareAtPrice = original`. When it ends it
writes back **both** values it recorded, never "copy compare-at into price".

## Architecture (mapped onto the existing shape)

```text
web (React Router)                         worker (pg-boss)
  /app/sales …  ──enqueue──▶  sale-campaign-run ──▶ Shopify productVariantsBulkUpdate
  preview (DB only)           sale-campaign-scheduler (every minute)
  webhooks/products/*  ──▶    sale-product-event  (external change, dynamic membership)
                              catalogue-snapshot  (bulkOperationRunQuery → JSONL → catalog_*)
```

- `src/domain/sales/` — pure: money and rounding, discount calculation,
  existing-sale policy, rule evaluation, conflict resolution, state machine.
  No clock, no Shopify.
- `src/adapters/shopify/catalogue.ts` — the bulk read; `variant-prices.ts` —
  live read and the one mutation that writes prices; `price-lists.ts` and
  `discounts.ts` — the Markets and automatic-discount checks for the preview.
- `src/adapters/db/repositories/sale-campaign.server.ts` and
  `catalogue.server.ts` — tenant-scoped persistence, the ownership claim, the
  batch claim.
- `src/jobs/handlers/sale-*.ts`, `catalogue-snapshot.ts` — orchestration.
- `src/web/routes/app.sales.*` — the screens; `app.products.$productId` — the
  product-side view.

Nothing new in the runtime: same two processes, same queue, same audit log
(`event_log`), same exceptions queue for what needs a person.

## Data model

Money is integer minor units everywhere (`price_minor`), converted from
Shopify's decimal strings with `toMinorUnits` and back with `fromMinorUnits`
at the adapter. Percentages are integer basis points (2000 = 20 %).

### `catalog_product`, `catalog_variant`, `catalog_price_list`

A per-shop **snapshot of the catalogue**, read by a Shopify bulk operation
(`products { variants { metafields } collections metafields }` — five
connections, two levels, the bulk-query limit). It exists so that targeting
rules — including metafield rules, which Shopify's search syntax cannot
express — are evaluated in this database, and so a preview is a query rather
than a walk of the Admin API. `shop.catalogue_snapshot_at` says how fresh it
is; the campaign editor shows it and offers a refresh.

`products/update` keeps the price, SKU, barcode, title, tags, vendor, type and
status of a product current between snapshots. Collections and metafields are
not in that payload and wait for the next snapshot (hourly while a dynamic
campaign is active or scheduled, nightly otherwise).

`catalog_price_list` records each Markets price list: currency, adjustment,
and how many **fixed** prices it holds. See _Markets_ below.

### `sale_campaign`

The campaign as the merchant edits it: name, notes, status, discount
(`percentage` | `fixed_amount` | `fixed_price`, value, currency), rounding
(`none` | `nearest_whole` | `ending_99` | `ending_9` | `ending_99_99` |
`increment` with `rounding_increment_minor`), `starts_at` / `ends_at` (UTC),
`priority`, the four policies (`existing_sale_policy`, `conflict_strategy`,
`base_price_change_policy`, `dynamic_membership`), `include_rules` and
`exclude_rules` (JSON rule trees), `created_by`, and the lifecycle timestamps.

### `sale_campaign_variant` — the snapshot

One row per variant a campaign has touched or intends to touch:

| column                                                               | meaning                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `original_price_minor`, `original_compare_at_minor`                  | exactly what Shopify held before the first write; what restore writes                                                                  |
| `base_price_minor`                                                   | what the discount was computed from (differs from original under the existing-sale policies)                                           |
| `sale_price_minor`, `sale_compare_at_minor`                          | what the campaign writes and expects to find                                                                                           |
| `state`                                                              | `pending` → `applying` → `applied` → `restoring` → `restored`; side states `failed`, `restore_failed`, `skipped`, `review`, `released` |
| `skip_reason` / `review_reason` / `last_error`                       | why, in a stable code                                                                                                                  |
| `last_observed_price_minor`, `_compare_at_minor`, `last_observed_at` | what Shopify last reported for this variant                                                                                            |
| `snapshot_created_at`, `last_applied_at`, `restored_at`, `attempts`  |                                                                                                                                        |

**Ownership is a database constraint.** A partial unique index on
`(shop_id, variant_id) WHERE state IN ('applying','applied','review',
'restoring','restore_failed')` means two campaigns cannot both hold a
variant's sale state, whatever the jobs do. Rows are never deleted while a
campaign exists; a completed campaign keeps its snapshot.

### `sale_run`

One row per batch job the campaign runs: `kind` (`apply` | `restore` |
`retry` | `release`), counts (`total`, `done`, `failed`), `status`, the
pg-boss job id, and the error if it stopped. The progress bar reads this.

## Campaign state machine

```text
draft ──schedule──▶ scheduled ──(starts_at reached | Activate now)──▶ active
  │                    │                                                │
  └──Activate now──────┘                                     pause ┌────┴────┐ resume
  │                    │                                           ▼         │
  │                cancel                                        paused ─────┘
  │                    │                                           │
  ▼                    ▼                                        cancel / end now
cancelled ◀────────────┴──────────────────────────── completed ◀── (ends_at reached | End now)
```

- `draft` — editable, writes nothing.
- `scheduled` — has a `starts_at` in the future; the scheduler activates it.
- `active` — its variants are being applied or are applied. The campaign's
  _phase_ is derived from its latest run: applying, applied, ending, with
  failed counts. It stays `active` until a restore has verified every
  variant; a campaign never claims to have finished restoring while a row is
  `restore_failed`.
- `paused` — prices restored, membership kept; resume re-reads Shopify and
  re-applies (a fresh snapshot, because the base may have moved).
- `completed` — every variant restored, released or under review; the
  review rows are shown and can still be resolved.
- `cancelled` — never applied, or paused and then cancelled.

Targeting, discount, rounding and policies are editable in `draft`,
`scheduled` and `paused`. In `active` only the name, notes and `ends_at` can
change; changing what is on sale means pausing.

Every transition is a conditional update (`WHERE status = <from>`), so two
clicks or a scheduler racing a person produce one transition.

## Discount calculation (`domain/sales/pricing.ts`)

Integer arithmetic on minor units; half-up. `fixed_amount` and `fixed_price`
are in the shop currency.

1. Decide the base price and the compare-at to write from the live values
   and the **existing-sale policy** (section below).
2. `sale = base − round(base × bp / 10000)` | `base − amount` | `value`.
3. Round: `nearest_whole` to the unit; `ending_99` to x.99 (rounds down);
   `ending_9` to the nearest ten below minus one unit; `ending_99_99` to the
   hundred below minus one cent; `increment` to the nearest multiple of
   `rounding_increment_minor`.
4. Clamp at 0. If `sale >= compare-at to write`, the variant is **skipped**
   (`no_discount`): a sale that does not lower the price is not written and
   never shows a compare-at above nothing.

## Existing-sale policy

Live `(price P, compareAt C)`; "already on sale" means `C > P`.

| policy                   | base | writes compare-at | note                                 |
| ------------------------ | ---- | ----------------- | ------------------------------------ |
| `skip` (default)         | —    | —                 | variant skipped, `already_on_sale`   |
| `discount_selling_price` | P    | C                 | the customer keeps seeing C          |
| `discount_compare_at`    | C    | C                 | skipped if the result would raise P  |
| `override`               | C    | C                 | the campaign's sale replaces the old |

Not on sale: base P, compare-at P. The row's `original_*` is always the live
pair, whatever the policy, so restore is exact.

## Shopify API operations (Admin GraphQL 2026-07, existing client)

| operation                                               | used for                                       | scope                    |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------ |
| `bulkOperationRunQuery` + `currentBulkOperation`        | catalogue snapshot (JSONL, `__parentId`)       | read_products            |
| `nodes(ids:)` on `ProductVariant`                       | live price read before every write             | read_products            |
| `productVariantsBulkUpdate(productId, variants)`        | the one price write, ≤ 250 per product         | write_products           |
| `priceLists { fixedPricesCount parent { adjustment } }` | Markets check in the preview                   | read_products            |
| `automaticDiscountNodes`                                | "may also be discounted at checkout"           | **read_discounts** (new) |
| `metafieldDefinitions(ownerType:)`                      | the rule builder's metafield list, with `type` | read_products            |
| `shop { ianaTimezone currencyCode }`                    | displaying schedule times                      | —                        |

Every write is preceded by a live read of the same variants, so a retry sees
what the previous attempt did. `admin.graphql(…, { tries: 3 })` retries
throttling; a batch that still fails is re-queued with backoff rather than
failed.

`read_discounts` is the only new scope; it is used for a warning and the app
degrades to "not checked" while the merchant has not granted it.

## Targeting and rule evaluation (`domain/sales/rules.ts`)

A rule tree: `{ op: "and" | "or", rules: (Rule | Group)[] }`, groups nested
one level (the builder offers "Match all" / "Match any" and "Add group").
Fields: all products, product, variant, collection, vendor, product type,
tag, category, product status, SKU (equals / prefix / contains), barcode,
title, handle, price, compare-at, on sale, and metafield (product or variant
owner, `namespace.key`, the definition's type).

Operators per type: text — `=`, `≠`, contains, does not contain, starts with,
ends with, is empty, is not empty, in, not in; number and date — `=`, `≠`,
`>`, `≥`, `<`, `≤`, is empty, is not empty; boolean — is true, is false, is
empty; lists — contains, does not contain, is empty, in; references —
`=`, `≠`, in, not in (by id; the picker supplies it), is empty.

Metafield values are parsed by their Shopify `type` (`number_integer`,
`number_decimal`, `boolean`, `date`, `date_time`, `list.*` as JSON arrays,
`*_reference` as GIDs, `money` as `{amount, currency_code}` JSON, `rating` as
JSON). A value that cannot be parsed never matches an operator that needs
parsing, and does match "is not empty".

Evaluation: include tree over every catalogue variant, then the exclude tree
removes from that set. The result is a set of variant ids; product counts are
the distinct products. The preview reports applies-to / excluded / final.

## Conflicts (`domain/sales/conflicts.ts`)

Two campaigns overlap when one variant is in both and their time windows
intersect. Detected in the preview (against active campaigns' owned rows and
scheduled campaigns' evaluated rules) and again at apply time (against the
ownership rows, which is the one that matters).

Strategy — the activating campaign's — decides each contested variant:

- `prevent` (default): activation is refused while the preview shows a
  conflict with an active campaign; overlaps with scheduled campaigns are a
  warning.
- `priority`: higher `priority` wins; a tie is refused.
- `largest_discount`: the larger effective reduction on that variant wins.
- `newest`: the later `created_at` wins.

A pending row whose variant another campaign holds live **cannot be claimed**:
the one-owner index would refuse the move to `applying`. Each run settles
those rows first (`resolveHeldRows`): when the activating campaign wins, the
holder's snapshot is **restored** and its row marked `released` (reason
`superseded:<id>`), after which the row claims like any other and snapshots
from the restored price — prices never stack. When it loses, or the holder is
still being written or under review, the row is `skipped` with reason
`conflict` and the holder's name in the detail.

## Scheduler and jobs

- `sale-campaign-scheduler`, every minute from its own cron entry. One
  query: campaigns `scheduled` with `starts_at <= now`, and `active` with
  `ends_at <= now`. A due start goes through `activateCampaign` exactly as a
  button does; one that cannot start (no matches, a refused conflict) goes
  back to `draft` with a `sale_apply_failed` exception rather than being
  tried again every minute. A due end goes through `settleEnding`: complete
  when every row is settled, queue a restore while rows are still out, and
  raise `sale_restore_failed` once when only failed restores remain.
- The four sale queues are created with pg-boss `policy: "short"`, because a
  bare `singletonKey` is not enforced on the default `standard` policy. A run
  that hands over to itself can therefore be re-enqueued while it is still
  active, and everything else asking for the same campaign folds into that
  one job.
- `sale-campaign-run` `{ shopDomain, campaignId, runId }`: puts back claims
  older than the lease, settles rows held by other campaigns, then claims a
  batch of up to 100 rows in the run's source state (`pending` → `applying`,
  or `applied` → `restoring`; a `release` run only rows marked
  `no_longer_matches`) with `FOR UPDATE SKIP LOCKED`, groups by product,
  reads live prices, decides per row, writes one `productVariantsBulkUpdate`
  per product, records the outcome per row, updates run counts, and after
  fifty seconds hands over to a fresh job until nothing is claimable. Then it
  settles the campaign (apply: stays active, raising `sale_apply_failed` if
  rows failed; restore: releases never-applied rows, completes the campaign
  when its end has come and every row is settled, else raises
  `sale_restore_failed`).
- `catalogue-snapshot` `{ shopDomain }`: starts the bulk operation if none
  is running, polls (re-enqueues itself with `startAfter`), downloads the
  JSONL, parses it in memory, and replaces the shop's catalogue rows in one
  transaction. Also reads price lists and the shop's timezone.
- `sale-product-event` — fed by `products/update` and `products/delete`
  webhooks under the webhook idempotency guard. Updates the catalogue rows
  from the payload, then for every owned variant of that product compares
  the live pair to the expected pair (external change), then for every
  active dynamic campaign re-evaluates this product's variants (membership).

### Idempotency

- A row is claimed by conditional update before it is written, so two
  workers cannot both write it.
- The snapshot is taken **once**: `original_*` is set when the row leaves
  `pending` and never overwritten within the same activation. A retry, a
  crash after the Shopify write but before the row update, and a re-run all
  re-read Shopify and find the price already at `sale_*` → recorded as
  applied without a write. A campaign activated twice discounts once.
- The sale is always computed from `base_price_minor`, never from what
  Shopify currently shows, so no repeated job can lower a price twice.
- Restore writes `original_*` only after checking the live pair equals the
  expected `sale_*` pair (or already equals `original_*`). Anything else is
  an external change and goes to `review` instead of being overwritten.

### Loop prevention

Our own write produces a `products/update`. The handler compares the
payload's price pair to `sale_*` (or, mid-restore, to `original_*`): equal
means it is ours or harmless, and nothing is written. Only a pair that
matches neither is an external modification. A recalculation writes a new
expected pair, so the webhook it causes also matches. There is no
self-triggering path.

### External base-price change (`base_price_change_policy`)

When the live pair differs from the expected pair on an owned variant:

| policy             | what happens                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preserve`         | the new base is recorded as the new original (so restore later writes the ERP's price, not a stale one); the sale price is written back with the new base as compare-at |
| `recalculate`      | same, and the sale is recomputed from the new base                                                                                                                      |
| `review` (default) | nothing is written; the row goes to `review` and a `sale_price_conflict` exception names the variant and both pairs; the merchant chooses keep / recalculate / release  |

Deriving the "new base": compare-at if it changed and is above the price,
otherwise the price. Every detection is an `event_log` entry with both pairs.

## Dynamic membership

`dynamic_membership` on: `sale-product-event` and every catalogue snapshot
re-evaluate the rules for active campaigns. A variant that newly matches is
inserted `pending` and a run is enqueued; one that no longer matches is
restored and marked `released` (reason `no_longer_matches`) — unless it is
under `review`, which a person resolves. Off: the membership is exactly the
set captured at activation.

## Markets and currencies

- The base catalogue price (`ProductVariant.price`, shop currency) is what
  a campaign writes. Markets that price by **percentage adjustment** or by
  **currency conversion** follow it automatically, compare-at included, so
  the sale shows correctly in those markets.
- Markets with **fixed prices** on a variant (`PriceListPrice`) do not
  follow the base price. The preview reads every price list's
  `fixedPricesCount` and warns which markets hold fixed prices; those
  variants keep their market price during the sale. Writing market-specific
  sale prices would need a per-price-list snapshot and
  `priceListFixedPricesAdd`/`…Delete`, and is deliberately not done: it is
  documented here rather than producing a wrong price silently
  (`docs/project-status.md`).
- Fixed-amount and set-price discounts are in the shop currency and say so.

## Failure and recovery

- Every batch is claimed, written, and recorded; a crash between the write
  and the record is repaired by the live read on retry.
- pg-boss retries a run job with backoff; a run that exhausts retries
  dead-letters into a `job_failed` exception and the campaign shows the
  failed count with **Retry failed**, which resets `failed` → `pending`
  (or `restore_failed` → `applied`) and starts a `retry` run.
- The campaign page states the truth: `4,921 applied · 11 failed`, never
  "done" over a partial result.
- Server restart, deployment, timeout: the queue survives, the rows say
  where each variant is, the next run continues from them.
- **Restore original prices** is available on every non-draft campaign,
  including a completed one with review rows, and only ever writes rows
  whose live pair still matches what we last wrote or observed.

## Audit log

`event_log` entries with `entity_type = "sale_campaign"` (`entity_id` the
campaign) or `"sale_variant"` (`entity_id` the variant): created, edited
(with the diff), scheduled, activated, paused, resumed, completed,
cancelled, restore requested, variant price changed (before/after), variant
restored, variant apply failed, external price modification detected
(expected/observed), conflict detected, review resolved. The campaign page
shows its own trail.

## UI

- Nav: **Sales** → `/app/sales`. Index grouped Active / Scheduled / Paused /
  Draft / Finished, each card: name, discount, product count, when it starts
  or ends, phase.
- `/app/sales/new` creates a draft and opens it.
- `/app/sales/:id` — the editor: General · Targeting · Exclusions · Discount
  · Schedule · Conflict handling · Advanced (existing sales, base-price
  changes, dynamic membership, rounding) · Preview. The header carries the
  lifecycle actions for the current status. Activation goes through a
  confirmation naming the variant count. While a run is in progress the page
  polls and shows `Applying sale… 1,248 / 4,932 variants`.
- `/app/sales/:id/variants` — every variant row, filterable by state, with
  CSV export at `/app/sales/:id/variants.csv`.
- `/app/products/:productId` — the product view: per variant, price,
  compare-at, sale, campaign (linked), discount, original price.
- Needs attention gains `sale_price_conflict`, `sale_apply_failed`,
  `sale_restore_failed`, each with an action into the campaign.

Times are stored in UTC and shown in the shop's `ianaTimezone`, which the
snapshot job caches on `shop.iana_timezone`.

## Required scopes

Existing: `read_products`, `write_products`. New: `read_discounts` (the
checkout-discount warning only). No `read_markets`: price lists are readable
under `read_products`.

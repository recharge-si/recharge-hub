# Night run — 25 August 2026

Unattended session. You went to sleep and asked me to fix the named bugs, build
the order flow from CLAUDE.md, make the home page a real dashboard, and use my
own judgement on anything ambiguous. This is the log.

Everything below is committed to the working tree, typechecked, linted and
covered by the test suite unless a section says otherwise.

---

## Read this first

### Restart the dev server before you touch anything

**The app will throw until you do.** Your `shopify app dev` stack ran all night
and still holds a Prisma client generated before tonight's two migrations. It
knows nothing about the `order`, `allocation`, `metakocka_document` or
`exception` tables, and the home page now reads orders — so it will error on
load until the process restarts.

Stop the running `npm run dev` and start it again. Nothing else is needed; the
database is already migrated.

I could not do this for you: stopping processes is blocked in this session. I
tried starting a second dev server instead and it failed cleanly on the same
file lock, changing nothing. Your original stack is untouched and still running.

### How I worked around the lock

`prisma generate` cannot run while the dev server holds
`query_engine-windows.dll.node`. I used `npx prisma generate --no-engine`, which
regenerates the TypeScript types and skips copying the engine binary. That is
enough for `tsc` and the test suite; the running processes pick up the real
client when they restart.

`prisma migrate dev` needs a TTY and there wasn't one, so migrations were
authored with `prisma migrate diff --from-schema-datasource` and applied with
`prisma migrate deploy`. The SQL is in `prisma/migrations/` as usual, in the
normal format — nothing about them is unusual, only the way they were generated.

---

## 1. Bugs you named

### 1a. Pricing never reached MetaKocka

**Cause.** `sync-products.ts` only ever passed a price to `addProduct`. The
update path sent `name` and nothing else. So the "Also send the Shopify price
and tax rate" switch did nothing whatsoever for any product MetaKocka already
had — which, for an existing catalogue, is all of them. Nothing was broken about
the payload: `pricelistBody` matches `docs/product_add.md` field for field.

The update path also returned early when the name already matched, so even once
a price was passed it would have been skipped for most products.

**Fix.**

- New setting `updatePricing`, its own switch, off by default, only offered once
  "send price" is on. It writes the Shopify price onto products MetaKocka
  already holds.
- It is deliberately _not_ folded into `sendPricing`. §8.9 makes MetaKocka
  master for price, so overwriting a price it already owns has to be a decision
  the merchant takes on purpose. The UI states plainly that Shopify becomes the
  price master while it is on, in a warning banner that only appears when the
  box is ticked.
- The update path now computes "does the name need changing" and "does a price
  need sending" separately and makes one call with whatever is needed, instead
  of bailing out on an unchanged name.
- The sync summary now counts `repriced` and `missingPrice`, so "I turned it on
  and nothing happened" is visible in Recent activity rather than silent. The
  old counters could not distinguish "nothing to do" from "did nothing".

**Files.** `prisma/schema.prisma`, `src/jobs/handlers/sync-products.ts`,
`src/adapters/db/repositories/product-sync-setting.server.ts`,
`src/web/routes/app.products.sync.tsx`.

### 1b. Renaming a warehouse in MetaKocka looked like deleting it

**Cause.** The warehouse cache was keyed on `mark`, which changes when a
merchant renames a warehouse. `replaceCachedWarehouses` therefore saw the old
mark vanish and the new one appear, concluded the warehouse had been deleted,
and retired the supply source — turning off its stock sync and releasing its
Shopify location. MetaKocka's `mk_id` is stable across a rename; nothing was
using it.

**Fix.**

- `metakocka_warehouse` is now unique on `(shop_id, mk_id)`, with a plain index
  on `mark`. Identity follows the id.
- `supply_source` gained `metakocka_warehouse_mk_id`. The mark is still stored
  and still sent — documents are addressed by mark — but the link that survives
  a rename is the id.
- A rename now updates the source's mark and name in place. This matters beyond
  cosmetics: §3 says MetaKocka accepts an unknown warehouse mark silently and
  files the document against the company default, so a stale mark is a silent
  mis-filing, not an error.
- Only a warehouse genuinely absent from the new list retires its source.
- Sources saved before the id existed are backfilled on the next reload, so the
  fix applies to your current data without anything to do by hand.
- The reload message now reports renames as well as retirements.

**Files.** `prisma/schema.prisma`,
`src/adapters/db/repositories/supply-source.server.ts`,
`src/web/routes/app.settings.supply-sources._index.tsx`.

### 1c. Nothing was ever scheduled

**Cause.** The warehouses screen told merchants "Stock also syncs on a schedule"
and the worker had no schedule of any kind. Every sync in the app was manual.
`boss.schedule` was never called.

**Fix.**

- New `scheduled-tick` queue with one cron entry, `*/15 * * * *`. pg-boss
  schedules a queue rather than a tenant, so the tick handler is the missing
  fan-out step: it reads installed shops that have MetaKocka credentials and
  enqueues per-shop work. One cron entry however many shops are installed.
- New `reload-warehouses` queue and handler, so the warehouse list refreshes
  itself. Renames and retirements are written to the event log rather than
  applied silently.
- Stock sync is enqueued on the same tick. §3 says MetaKocka's stock webhook
  gives up after two retries, so a scheduled pass is the only thing that
  guarantees the two sides converge.
- Everything is sent through `enqueueThrottled` with a window slightly longer
  than the cadence, so a run that takes longer than 15 minutes is never lapped.

**Files.** `src/adapters/queue/queues.ts`, `src/jobs/worker.ts`,
`src/jobs/handlers/reload-warehouses.ts`, `src/jobs/handlers/scheduled-tick.ts`.

---

## 2. The order flow (CLAUDE.md section 8)

This is the bulk of the night. The vertical slice from section 13's M4 now
exists: order webhook, allocation, MetaKocka sales orders, payment, order detail
with the decision trail, exceptions queue.

### What runs

```
Shopify orders/create
  -> webhook writes order + lines AND enqueues allocate-order in ONE transaction
  -> allocate-order          reads stock, calls domain/allocation, writes the plan
  -> write-metakocka-order   one job per supply source, one document per source
  -> mark_paid on the primary document, exactly once
```

### Pure domain first

`src/domain/allocation/` and `src/domain/money/` are pure — no I/O, no clock, no
randomness, clock injected — so the highest-risk logic in the app is testable in
milliseconds, which is what section 5 asks for.

**`allocate()`** implements M4's rule: own stock first, then partners, splitting
allowed. Two properties matter more than the rule itself:

- Stock is consumed across the whole order, so two lines of the same SKU draw
  from one running balance. Deciding each line against the original stock figure
  is the classic way to promise the same unit twice.
- It never guesses. A line it cannot fill is allocated as far as it goes and the
  remainder comes back as a shortfall, which becomes an exception.

`tests/unit/allocate.test.ts` covers every case section 12 names — zero stock,
exact stock, partial stock, split disabled, same SKU on two lines, zero
quantity, disabled source, priority ties — plus determinism and purity.

While writing those tests I asserted the wrong thing for "splitting forbidden"
and the code turned out to be right: with splits off and own stock short,
sending the whole line to a partner that can cover it beats a shortfall. The
test now says that, and there is a separate case for nobody being able to cover
it at all.

**`splitOrderMoney()`** implements section 8.6. One document is primary (highest
line total, ties broken own before partner, then source code, so a retry picks
the same one). Shipping, COD surcharge and order-level discounts go on the
primary alone — they are single charges, not per-source costs. Everything is
integer minor units, and any remainder lands on the primary so the documents sum
to the Shopify total to the cent. That sum is asserted on every case in the
table, including odd cents and three-way splits.

### MetaKocka sales orders

`src/adapters/metakocka/documents.ts`. The three verified behaviours from
section 3 are designed around rather than discovered later:

- **`count_code` is not unique on MetaKocka's side.** Re-sending one creates a
  second document under MetaKocka's own numbering. So the row in
  `metakocka_document` is claimed _before_ the call goes out, and the unique
  index on `(shop_id, count_code)` is the only duplicate guard that exists. A
  redelivered webhook or a retried job cannot produce two sales orders.
- **`buyer_order` links siblings, `customer_order` is silently discarded.** Only
  `buyer_order` is sent, and a test asserts `customer_order` never appears.
- **An invalid warehouse mark is silently accepted** and filed against the
  company default. So the mark is validated against the cached warehouse list
  before sending, and a mismatch raises an exception naming the warehouse.

`create_invoice` is never set — invoicing stays a merchant decision (section
8.4), asserted in a test.

`tests/unit/sales-order-body.test.ts` is the section 12 request-body test: it
runs the section 13 demo through the allocator and the money split, then asserts
both request bodies field by field.

### Payments (section 8.7)

`mark_paid` goes out exactly once per document, guarded by `payment_marked_at`,
because on an update MetaKocka **deletes the previous payment and adds the new
one** — a routine re-send silently rewrites the books. Only the primary document
carries the payment. `pending` and `authorized` create the order unpaid;
`partially_paid` raises an exception rather than guessing an amount; an unmapped
gateway raises an exception rather than guessing a payment type; and a
cash-on-delivery gateway is left unpaid whatever Shopify's status says, because
marking COD paid at order time misstates the books.

### Refunds, cancellations, edits (section 8.8)

Not implemented, as specified — but the webhooks are received and turned into
exceptions from day one, so nothing is lost silently. Every one of them says
plainly that a MetaKocka document may already be invoiced and that nothing is
deleted automatically.

### Retention (section 2.4)

`redact-old-orders` runs nightly. Raw Shopify payloads and MetaKocka request
bodies older than 90 days have their personal data overwritten in place, while
SKUs, quantities, prices, sources, rule reasons and document ids survive. The
order row is never deleted — deleting it would take the allocations and
documents with it, and with them every record of why the ERP holds what it
holds. Tested, including that running it twice is a no-op.

---

## 3. The home page is now a dashboard

Section 2.7 says a static welcome card fails Built for Shopify. The page now
leads with what is happening and drops setup to the bottom once it is done.

- Four metrics for today: received, allocated, sent to MetaKocka, awaiting
  attention. Fixed block heights so the row does not reflow as figures change.
- Badges for last ERP write, last stock sync, and how many warehouses sync.
- A fourteen-day chart of orders per day, with the portion that reached
  MetaKocka filled in darker — so "arrived" and "reached the ERP" are compared
  inside one shape rather than across two.
- Open exceptions by type, and a persistent critical banner above everything
  whenever any are open.

**The chart is hand-written inline SVG.** No charting library: that would mean a
new dependency and a second design system inside a Polaris page (section 2.6),
for something that is a few dozen lines. Colours are Polaris custom properties,
so it follows the admin palette. It carries an `aria-label` with the totals,
because an SVG of bars is unreadable without one.

## 4. New screens

- **Orders** (`/app/orders`) — newest first, with which sources fulfil each one
  and how many documents have reached MetaKocka.
- **Order detail** (`/app/orders/:id`) — the decision trail section 13 asks the
  M4 demo to produce. Every allocation shows which source took how much and the
  recorded reason why, in the merchant's words. Documents show which is primary.
  Two actions: allocate again, send to MetaKocka again — both safe, because the
  duplicate guard still applies.
- **Exceptions** (`/app/exceptions`) — one row per business condition needing a
  person, each with what happened, what it means, what to do about it, and
  retry / mark resolved / ignore.

Both are in the app nav.

---

## 5. What I did NOT build, and why

I would rather leave these clearly marked than half-done.

- **Shopify fulfilment orders (section 8.3).** `fulfillmentOrderMove` and
  `fulfillmentOrderSplit` are not implemented. This one moves real fulfilments
  in a live store, and I had no way to test it against real fulfilment order ids
  overnight; getting it wrong would silently reassign merchant fulfilments. The
  queue and the job name exist, the handler does not. **This is the biggest
  remaining gap in the order flow.**
- **Tracking sync back to Shopify (section 8.5).** Not started.
- **Nightly reconciliation (section 8.10).** Not started. The scheduler now
  exists, so this is a handler and one cron entry away.
- **Allocation rules as data (section 6, M6).** Still the single hardcoded rule.
  The shape is already in `AllocationRule`, so moving it to rows is additive.
- **The product name template builder UI** from the earlier task — steps 1 and 2
  are done and tested; the pill editor is not built.
- **`name_rules` column.** The resolver takes a `NameSettings` object as asked,
  but rules are not persisted yet.

## 6. Things you should check

1. **Restart `npm run dev`.** Your running processes hold a stale Prisma client
   and will error on the new columns until they restart.
2. **The new webhook subscriptions need registering.** `shopify.app.toml` now
   subscribes to `orders/create`, `refunds/create`, `orders/cancelled` and
   `orders/edited`. Those reach Shopify when the CLI next syncs config — a
   `shopify app dev` run, or `shopify app deploy`. Until then no order webhook
   arrives and the whole flow sits idle.
3. **No real order has been through this.** Everything is unit-tested and the
   payload shapes come from MetaKocka's own documentation, but nothing has
   touched a live MetaKocka company. Section 14 says verify against the test
   company first: place one test order and watch it before trusting it with
   production data.
4. `read_orders` was already in the access scopes, so no scope change was needed
   and none was made.
5. The warehouse **Edit** button revert from earlier in the evening was never
   re-verified in the browser — the tab closed before I could. Worth one click.

## 7. Verification

`npx tsc --noEmit`, `npx eslint src/ tests/`, `npx prettier --check`,
`npm test` (208 tests across 15 files) and `npm run build` all pass.

New tests this run: allocation (21), money split (15), order payload and
redaction (15), sales order body (11).

---

## 8. First real order — two bugs, both fixed

You put order SH-1002 through and MetaKocka rejected it. The screenshot showed
both problems at once.

### 8a. `Not valid date for doc_date : 2026-08-25+00:00`

**Cause, and it is mine.** `toDocumentDate` built the date from
`date.toISOString()` and hardcoded a `+00:00` offset. That is valid ISO 8601 and
differs from MetaKocka's own documented example only in the offset — but they
reject it. Every example in their docs carries a real Ljubljana offset; the
offset is not decoration.

**Fix.** The offset now comes from Shopify's `created_at`, which arrives with
the shop's local offset attached (`2026-08-25T11:30:00+02:00`). That is the
right value on the merits too, and it is why I took it from the timestamp rather
than looking up a timezone:

- **It fixes a day-boundary bug I had not noticed.** An order placed at 00:30 in
  Ljubljana is still the previous day in UTC, so every late-evening order would
  have been dated to the wrong day. Dating a sales order wrongly is an
  accounting problem, not a cosmetic one.
- Reading the offset off the timestamp gets DST right for free, with no
  timezone table and no extra Shopify call.

A shop whose timestamp arrives as `Z` falls back to a bare `2026-08-25`. That
avoids re-sending the value we know is refused, but it is **unverified against
MetaKocka** — if you ever run a UTC shop, test it before trusting it.

### 8b. The banner said "Profit centre rejected" and the profit centre was fine

**Cause, also mine.** I mapped `opr_code === "6"` straight to
`profit_center_rejected`, on the strength of the single code-6 response anyone
had recorded: `"Profit center 'X' doesn't exist."`. Your order proved code 6 is
a general rejection — it came back with a date error. So the app showed a red
banner blaming a setting that was correct, which is exactly the kind of error
message that sends someone to change the wrong thing.

**Fix.** `exceptionKindFor()` now reads the kind from `opr_desc`, and anything
it does not recognise becomes the honest `metakocka_write_failed` rather than a
confident wrong guess. The full MetaKocka text was always shown underneath — it
is only the heading that lied, but the heading is what people act on.

### CLAUDE.md updated

Both are now recorded in §3, because both contradict what was written there:

- The `opr_code` list said `6` means "named entity does not exist". It does not;
  it is a general rejection and the cause has to come from `opr_desc`.
- The data-format section said nothing about the offset being validated. It now
  says a zero offset is refused and that document dates must never be built from
  UTC.

### Tests

`toDocumentDate` now has four cases pinning the verified behaviour, including
one asserting it can never emit `+00:00` for any input, and one for the
day-boundary case. `exceptionKindFor` has three, including the exact date
rejection that caused the mislabelling.

214 tests pass; `tsc`, `eslint` and `prettier` clean.

### Worth knowing

The document for SH-1002 is recorded as `failed`, so **the duplicate guard will
let you retry it** — that path exists precisely because a failed claim is
retryable while a written one is not. Use "Send to MetaKocka again" on the order
page once the worker restarts with this code.

---

## 9. The date, settled properly

Section 8a above was wrong, and so was the fix after it. Recording the whole
sequence because the wrong turns are the useful part.

**Attempt 1** sent `2026-08-25+00:00`. Rejected. I concluded a zero offset was
the problem.

**Attempt 2** took the offset from Shopify's `created_at`, which for your US dev
store is `-04:00`. Also rejected. So the offset was not simply "must be real".

**Attempt 3** would have been "use the ERP's timezone, computed properly with
DST". You then said I could write to MetaKocka, so I stopped guessing and asked
it instead — and that third guess would have been wrong too, in a way that only
showed up in winter.

### The probe

`put_document` with a `profit_center` that cannot exist. MetaKocka validates the
profit centre and refuses the document before creating anything, so the error it
returns says whether the date got past validation:

- `"Not valid date for doc_date"` → the format was rejected
- `"Profit center 'X' doesn't exist."` → the date was **accepted**

No documents were created. Nothing was written to your ERP.

### What it found

| `doc_date`                                                 | result   |
| ---------------------------------------------------------- | -------- |
| `25.08.2026`, `15.01.2026`                                 | accepted |
| `2026-08-25+02:00`, `2026-01-15+02:00`, `2025-08-25+02:00` | accepted |
| `2026-08-25` (bare)                                        | rejected |
| `2026-08-25+00:00`, `2026-08-25-04:00`                     | rejected |
| `2026-08-25+01:00`, `2026-08-25+03:00`, `2025-01-15+01:00` | rejected |
| `2026-08-25+0200`, `2026-08-25T09:52:00+02:00`             | rejected |

**`+02:00` is a literal MetaKocka insists on, not a timezone it interprets.**
`+01:00` is refused in January as readily as in August, and `+02:00` is accepted
in January. The ISO form that appears in every example in MetaKocka's own
documentation is therefore only usable by hardcoding an offset that is wrong for
five months of the year.

That is exactly what attempt 3 would have shipped: a correct DST calculation
producing `+01:00`, breaking every document between late October and late March,
with tests passing the whole time. It would have looked fine until the clocks
changed.

### The fix

`dd.mm.yyyy` — accepted, no offset to be wrong about, and the format
`mark_paid` already required, so the payload now uses one date convention
instead of two.

The calendar date is taken in the ERP's timezone (`Europe/Ljubljana`,
overridable per call). A document date belongs to the ledger it is filed in, not
to wherever the customer was standing: an order placed at 23:00 in New York is
the next day in Ljubljana, and a Slovenian company books it then. `mark_paid`
now uses the same rule, which fixes a quieter version of the same bug — it was
reading the date off UTC.

Verified by running the exact output of `buildSalesOrderBody` back through the
probe, for both a summer and a winter date. Both accepted.

### Also fixed: two red banners for one failure

Your screenshot showed the new correct error _and_ the stale "Profit centre
rejected" from before the classifier fix, both open at once. `raiseException`
only dedupes within a kind, so a retry that fails under a different kind leaves
the old one standing.

A failed write now closes the other write-failure kinds for that order before
raising the current one, and a successful write closes all of them. One
rejection, one banner, and it says the right thing.

### CLAUDE.md

§3 now carries the full table and the `+02:00`-is-a-literal finding. The note I
added in section 8 — "take the offset from Shopify's `created_at`" — was wrong
and has been replaced.

215 tests pass; `tsc`, `eslint` and `prettier` clean. The probe script is
deleted.

---

## 10. Tax on the line, and a second bug found alongside it

With the date accepted, SH-1002 reached the next check and MetaKocka said:

> Attribute 'tax' for product with code 'P04200014460' or name
> 'Patrik FIN P-RACE (DTT)' must be set.

### What the order actually contained

Rather than assume, I read the stored payload:

```
taxes_included: true
total_tax:      0.00
tax_lines:      []            (order level)
line_items:     taxable: true, tax_lines: []   (all three)
```

So the lines are taxable, Shopify charged no tax, and there are no tax lines to
derive a rate from. The old code returned null for that and sent no `tax_factor`
at all — which MetaKocka refuses, because the product has no tax attribute of
its own to fall back on.

### The distinction that fixes it

"No tax lines" was being treated as one thing when it is two:

- **Shopify charged no tax.** `total_tax: 0.00`, or `taxable: false`. The factor
  is zero, and that is not a guess — it is Shopify stating what the customer
  paid. Treating it as unknown would block every order from a shop that does not
  charge tax.
- **Tax was charged but not broken down per line.** Genuinely undeterminable.
  §8.6 forbids substituting a product default, so this raises a
  `tax_undeterminable` exception (§11) and the document is not sent.

`tax_factor` is now always present when we send, including `"0"`.

### The second bug, which nothing had surfaced yet

Reading the payload turned up `taxes_included: true`, and the builder was
sending Shopify's price as `price_with_tax` unconditionally.

That is right for a tax-inclusive shop and **wrong for a tax-exclusive one**,
where Shopify's `price` is net — every line would have been understated by the
VAT rate, silently, with a document MetaKocka accepted without complaint. It
happens not to bite your store, and it would have bitten the first tax-exclusive
merchant to install the app.

The builder now sends `price` or `price_with_tax` according to the shop's own
`taxes_included` flag. MetaKocka takes either.

### Verified, not assumed

The exact body the app now builds for SH-1002 was replayed against MetaKocka
with an impossible profit centre attached, so it could not create anything:

```
doc_date:      25.08.2026
taxesIncluded: true
product_list:  price_with_tax "209.00", tax_factor "0"  (x3)

-> PASSED every check up to the profit centre
   opr_code 6: Profit center 'ZZ_PROBE_DOES_NOT_EXIST_ZZ' doesn't exist.
```

Date, lines, prices, tax and partner all accepted. Nothing was written.

### CLAUDE.md

§3 now records that a line's tax is not optional, when a zero is legitimate
versus when it is an exception, and the tax-inclusive/exclusive price rule.

219 tests pass; `tsc`, `eslint` and `prettier` clean. Probe scripts deleted.

**SH-1002 should go through now.** Its document is still `failed`, so the
duplicate guard will let a retry proceed.

---

## 11. The tax exception was stale data, not bad logic

The "Tax rate could not be determined" banner was the new check firing on old
data. The lines were written at intake by the previous parser, which stored
`null`; today's parser derives `"0"` from the same payload:

```
STORED on order_line (written at intake):  null, null, null
RE-DERIVED from the raw payload today:     0,    0,    0
```

The write job read the stored column, so a retry could only ever reproduce the
same failure. A parser fix could never reach an order already in the database.

**Fix.** While the raw payload is still there it wins: tax is re-derived at write
time, matched by `shopifyLineItemId`, and the stored row is corrected once the
write succeeds so the order page and the decision trail stop showing the
superseded value. Past the 90-day redaction (§2.4) the payload is gone and the
stored column is all there is, which is why it stays as a fallback rather than
being replaced.

---

## 12. Pricelists — two bugs, one of them silent

You were right that this was still broken, and the reason had nothing to do
with the switch I added last night.

### What I found by asking MetaKocka

- `product_list` returns **no prices at all** unless you pass
  `return_pricelist: "true"`. A product with prices looks identical to one
  without.
- No product in company 6789 had any pricelist entry.
- `product_update` selected by `count_code` failed:
  `"Product with count_code 'P04200014460' does not exist."` Products created in
  the MetaKocka UI carry an internal `count_code` (`"4451"`) with the SKU in
  `code`. Matching on `code` and updating by `mk_id`, which the sync already
  does, is correct — worth knowing before anyone "fixes" it.
- Then the real one:

  > Pricelist '1' has 'net' price type. Use 'price' instead of 'price_with_tax'
  > to set the product price on the pricelist.

### The bug, and the worse bug behind it

`pricelistBody` chose between `price` and `price_with_tax` from **Shopify's**
`taxes_included` setting. That is the wrong input entirely: a MetaKocka
pricelist has its own net-or-gross type, fixed when it was created, and it has
no relationship to how Shopify stores prices.

The visible symptom was a rejected call. The invisible one is worse: had your
pricelist been gross while Shopify was net, or vice versa in the other
direction, MetaKocka would have **accepted the number and stored it wrong by the
VAT rate**, silently. 209.00 gross into a net pricelist is 209.00 net — a price
22% too high, in the ERP, with no error anywhere.

So renaming the field was never enough. The **amount** has to be restated.

### What now happens

- `domain/money/tax.ts` converts between bases in integer minor units, pure and
  tested — 209.00 gross at 22% is 171.31 net, and it refuses to guess when the
  bases differ and no rate is available, because the unconverted number is
  simply the wrong price.
- A new setting says whether the pricelist is gross or net, on the settings
  screen next to the pricelist code.
- If that setting is wrong, MetaKocka's rejection names the type it wants, so
  the sync **flips, converts, retries that SKU, and writes the correction back**.
  One wrong answer costs one rejected call, not a catalogue.
- The run summary now reports `unpriceable`, `pricelistIncludesTax` and
  `basisCorrected`.

### Verified against your company

Driving the app's own pricing path with your real settings:

```
attempt 1: pricelist treated as gross, sending 209.00
  rejected: Pricelist '1' has 'net' price type...
  -> self-correcting the basis and retrying
attempt 2: pricelist treated as net, sending 171.31
  accepted

stored in MetaKocka: {"count_code":"1","price_def":{"tax":"EX4","tax_desc":"22",
                      "price":"171,31"},"title":"Shopify Pricelist", ...}
```

### One thing that is your call, not a bug

`updatePricing` is **off** in your settings. Prices therefore only go out on
products this app creates, and yours already exist — so nothing was ever going
to be priced regardless of the above. Turn on _"Keep prices up to date on
products MetaKocka already has"_ on the product sync page. It stays off by
default because §8.9 makes MetaKocka master for price.

### CLAUDE.md

§3 now records the pricelist net/gross rule and the silent-wrong-price hazard,
that `count_code` and `code` differ for UI-created products, and that
`product_list` hides prices without `return_pricelist`.

232 tests pass; `tsc`, `eslint` and `prettier` clean. Probe scripts deleted.

---

## 13. Pricelist on the order, and lines that can only be catalogue products

Both of these were real, and the second one had a hazard behind it worth
spelling out.

### The pricelist

`sales_pricelist_code` was never sent, so every document was filed against no
pricelist at all and nobody opening it in MetaKocka could see what it was priced
from. It now carries the shop's pricelist code.

That code also moved **out** of the "send prices" section on the product sync
page. It is needed on every sales order whether or not product prices are being
synced, and hiding it behind an unrelated switch meant an order could never get
one unless you happened to have turned pricing on.

### Lines are catalogue references, never manual entries

Probing MetaKocka with a code that does not exist returned:

> `opr_code 8`: Product with code ZZ-NOT-IN-CATALOGUE-ZZ not found —
> **unit must be set to add new product**

That is an invitation. Send `unit` on a document line and MetaKocka **creates
the catalogue product from the order**, named and priced from whatever Shopify
happened to send. That is exactly how a curated catalogue fills up with
duplicates nobody made on purpose.

The builder never sent `unit`, so it failed safe — but by luck, not by design.
Three changes make it deliberate:

- `unit` and `name` are documented as _deliberately absent_ from `DocumentLine`,
  with the reason, so nobody adds them back as an improvement. `name` was doing
  nothing anyway: MetaKocka overrides it with the catalogue's own name for a
  product that exists, and it only describes a manual line for one that does not.
- Every SKU is checked against the matched-SKU registry **before** the call. A
  missing one raises `sku_not_in_metakocka` naming the code, rather than the
  merchant reading a MetaKocka rejection.
- `opr_code 8` is now a known code and classifies to `sku_not_in_metakocka`
  rather than the generic write failure.

### Verified against your company

The real document for SH-1002 was built by the app's own code, sent, read back
and deleted:

```
sales_pricelist_code: 1
doc_date:             2026-08-25+02:00
line: mk_id=562502829669 code=P04200014460 name=Patrik FIN P-RACE (DTT) 460 amount=1 price=209 tax=000
line: mk_id=562502829670 code=P04200014480 name=Patrik FIN P-RACE (DTT) 480 amount=1 price=209 tax=000
line: mk_id=562502829671 code=P04200014500 name=Patrik FIN P-RACE (DTT) 500 amount=1 price=209 tax=000
sum_all:              627
```

Every line came back with an `mk_id` and MetaKocka's **own** catalogue name —
note the "460", "480", "500" suffixes it added, which are not the names we sent.
That is the proof the lines are references rather than entries. `sum_all` of 627
matches the Shopify order total to the cent. The document was deleted afterwards;
nothing was left behind.

### CLAUDE.md

§3 now records the `unit` auto-create hazard and `opr_code 8`, that
`sales_pricelist_code` is what ties a document to its prices, and that
`get_document` takes `doc_id` rather than `mk_id` — which cost a round of
confusing "id = null" errors during this.

235 tests pass; `tsc`, `eslint` and `prettier` clean. Probe scripts deleted.

---

## 14. Partners: link to the right one, create one only when there isn't

### The reported error was not the real problem

"Partner data are missing" on #1003. I read the exact request the job had
recorded, replayed it verbatim, and **it succeeded**. The payload was never
wrong; the failure was state-dependent, which is itself the symptom.

What the digging turned up is the actual fault:

```
get_partner partner_email "grega@etiam.si"  ->  1 partner   684/2026
get_partner partner_name  "Grega Rotar"     ->  2 partners  684/2026, 686/2026
```

**Two partner records for one customer.** Sending inline `partner: { customer,
street, ... }` on a document does not match an existing record — it creates
another one, every time. A shop doing real volume would accumulate one partner
per order, with each customer's history scattered across all of them.

### What now happens

`adapters/metakocka/partners.ts` resolves the partner before any document is
written:

1. `get_partner` by tax number, then email, then name — in that order, because
   a tax number is unique by law, an email is unique in practice, and a name is
   neither.
2. Found: reference it. Not found: `add_partner` explicitly, flagged as a buyer,
   then reference that.
3. The document sends `partner: { mk_id, mk_address_id, customer, street }` and
   MetaKocka links rather than creating.

**[verified] An id alone is not enough.** `partner: { mk_id }` is refused with
"Partner must have mk_address_id or customer and street for address
identification", so the resolved partner carries its billing address id (the
`"Račun"` entry) and the document sends both.

### Where the resolution happens, and why it matters

In the **allocation** job, not the document job. Allocation is the last point at
which exactly one job owns the order. A split order fans out into one document
job per supply source, and those run together — three jobs looking up the same
new customer at the same moment would each find nothing and each create a
partner, which is the bug reproduced three times over. The resolved id is stored
on the order and reused; the document job falls back to resolving only for
orders allocated before this existed.

### Verified against your company

```
partners named 'Grega Rotar' before: 2
resolved: mkId 400071680303, mkAddressId 400082841143, countCode 684/2026, created false
partner sent: {"mk_id":"400071680303","mk_address_id":"400082841143",
               "customer":"Grega Rotar","street":"Spodnje Pirniče 19n"}
ACCEPTED -> document links to partner 400071680303 (684/2026) Grega Rotar
sum_all: 627
partners named 'Grega Rotar' after: 2 (unchanged - no duplicate created)
```

The document was deleted afterwards.

**You have two "Grega Rotar" records in MetaKocka already** — `684/2026` and
`686/2026` — left by the earlier inline-partner writes. Merge or delete the
spare one when convenient; from now on the app will keep linking to whichever
survives, because it searches by email first.

### CLAUDE.md

§3 records that inline partner data duplicates, the `get_partner` / `add_partner`
resolution, and that a reference needs an address id as well as a partner id.

238 tests pass; `tsc`, `eslint` and `prettier` clean. Probe scripts deleted.

### One note on the Prisma client

`npx prisma generate --no-engine` makes the client refuse real database
connections ("the URL must start with `prisma://`"), which breaks any script run
through `tsx`. Twice now I have had to regenerate a full client into a temp
directory and copy everything except the locked `query_engine-windows.dll.node`
over `node_modules/.prisma/client`. **Once you restart the dev server, run a
plain `npx prisma generate`** and this goes away.

---

## 15. VAT on order lines: zero was never the right answer

Your screenshot showed both lines side by side, which made the problem obvious:

```
ours    P04200014500   209,00    0 %     209,00
correct P04200014500   171,31   22 %     171,31
```

Same gross, and only one of them agrees with the pricelist.

### What I got wrong earlier

When Shopify reported `total_tax: 0.00` with no tax lines, I decided that was
Shopify "stating what the customer paid" and sent `tax_factor: "0"`. It read as
a fact at the time. It is not: a taxable line with no tax lines means the shop
has no tax registration for that market — true of every development store — not
that the sale was zero-rated.

The consequence is not cosmetic. A line at 0% books 209.00 as net, against a
catalogue and pricelist that say the net is 171.31, and understates the VAT owed
on every order.

### What MetaKocka actually does

```
tax_factor "0"     -> price 209     tax 000   (accepted, and wrong)
no tax_factor      -> REJECTED: Attribute 'tax' for product ... must be set
tax_factor "0.22"  -> price 171.31  price_with_tax 209  tax EX4
```

It will not infer the rate from the catalogue even though the product's pricelist
entry carries `tax_desc: "22"`, and it will not accept a line without one. A rate
has to come from us.

### The rule now

- **Line has tax lines** — use them. Per-market accuracy, and the only source
  §8.6 allows for a real taxed sale.
- **`taxable: false`** — zero. That is a statement about the sale.
- **Taxable but no rate given** — use the shop's configured VAT rate, because
  that is the rate its catalogue and pricelist are built on.
- **No rate configured either** — `tax_undeterminable` exception, telling the
  merchant to set the default rate so it matches their pricelist.

The VAT rate field moved out of the "send prices" section on the product sync
page for the same reason the pricelist code did: it is needed on every order,
not only when product prices are being synced. It is now labelled **Default VAT
rate (%)** and says what it is for.

### Verified against your company

```
configured VAT rate: 22 -> factor 0.22
sent: price_with_tax "209.00", tax_factor "0.22"  (x3)

STORED IN METAKOCKA:
   P04200014460  net=171.31  gross=209  tax=EX4
   P04200014480  net=171.31  gross=209  tax=EX4
   P04200014500  net=171.31  gross=209  tax=EX4
   net total=513.93  gross total=627
```

Which is the second row of your screenshot, three times over. Gross total 627
still matches the Shopify order exactly. The document was deleted afterwards.

### CLAUDE.md

§3 records that MetaKocka will not infer a line rate, that `"0"` is accepted and
wrong, and that the shop's configured rate is the fallback with `taxable: false`
the only thing meaning zero.

238 tests pass; `tsc`, `eslint` and `prettier` clean. Probe scripts deleted.

---

## 16. The stuck "pending" document, and why it could never recover

SH-1004 sat at `pending` with no request, no response and no exception. Three
faults stacked up, each hiding the next.

### 16a. A search that found nothing killed the job

`get_partner` reports "no match" as **`opr_code 2, "No partner with such
properties."`** — a failure, not an empty list. The client turns any non-zero
code into a throw, so a perfectly normal "this customer is new" took the whole
job down.

### 16b. And a dead job could never be retried

`claimDocument` treated `pending` as "already written". The claim is there to
stop a second document being created, but `pending` means _no write was ever
confirmed_ — only `written` means MetaKocka has it. So the job died after
claiming, and every retry afterwards skipped with "already claimed or written".
The order was stuck for good.

Now only `written` blocks a retry. A `pending` claim can be taken over once its
lease has expired, and the lease is matched to the write queue's
`expireInSeconds` — past that, pg-boss has abandoned the job, so nobody is still
holding it. Anything that throws after the claim also marks the row `failed` on
its way out, so the row is never left in limbo in the first place.

### 16c. `add_partner` returns no `opr_code` at all

Creating a partner answers with the new ids and nothing else — no `opr_code`, no
`opr_desc`. The client required one and rejected the response as "an
unrecognised response envelope". A missing code is now treated as success: an
endpoint that reports failures does so with a code.

---

## 17. `mark_paid` as a follow-up update destroys the document

With the above fixed, the write succeeded and _then_ failed — and the failure
was worse than the original bug.

Marking the document paid was a second `put_document`. Working out what it
needed went:

```
mk_id + mark_paid                    -> "Partner data are missing"
mk_id + partner + mark_paid          -> "Value is require for doc_date"
mk_id + partner + doc_date + mark_paid -> accepted
```

And that acceptance **deleted every line on the document**. A five-line order
came back with no `product_list` and no totals. MetaKocka treats an update as a
replacement: anything left out is removed, silently, reported as success.

**Payment now travels in the `put_document` that creates the order**, which the
documentation shows as a supported shape and which removes the update entirely.
`markDocumentPaid` still exists for a deliberate correction, but it now demands
the whole document and says why in a comment nobody can miss.

A related fix: a document that had already been recorded `written` was being
flipped to `failed` when this follow-up call tripped. A written document is
never un-written by later trouble — that would invite a retry that creates a
second one.

---

## 18. Payment types: read from the register, mapped visually

### They never loaded

`discoverPaymentTypes` existed, was correct, and **was never called from
anywhere**. It also could not have worked: its probe sent a bare ISO `doc_date`,
which MetaKocka refuses, so validation stopped at the date and never reached
`payment_type`. It returned null every time.

With the date fixed it reads the register exactly as intended:

```
discovered: Gotovina, Kartica BA, Prenos preplačila, Transakcijski račun
```

Which is your Registers screen, and it creates nothing — the request is refused
at payment-type validation.

### The mapping that was actually broken

`manual` was mapped to **Gotovina**, and MetaKocka refuses it:

> The payment instrument Gotovina needs to be tax certified, but you do not have
> tax cash registers activated.

That is a mapping to change, not a write to fix, so it now classifies as
`unmapped_payment_gateway` rather than a generic write failure.

### The new screen

- **Load payment types** reads the register from MetaKocka.
- **Add a payment type by hand** for when the parsed error message cannot be
  read — it writes into the same cache, so a typed value and a discovered one
  behave identically everywhere downstream. Reloading replaces the list, which
  is also how you clear a typo.
- **The mapper**: Shopify gateways on the left, MetaKocka types on the right,
  connected by drawn lines. Pick a gateway, pick a type. Several gateways may
  share one type; a gateway connected again _moves_, because `payment_type` on a
  document is a single string.

**The lines did not draw at first and the reason is worth recording:** the paths
were written with percentages (`M 48% ...`). An SVG `d` attribute has no concept
of a percentage — the path is simply invalid and renders nothing, silently,
while looking entirely reasonable in the source. Endpoints are now measured off
the rows themselves in pixels, so they track wrapped text and reflow.

Every connection is also stated in words under its gateway. The lines are
decoration on top of readable state, which is what makes the stacked narrow
layout and a screen reader work — and lines are skipped entirely when the
columns stack, since a line across stacked rows joins nothing.

---

## 19. Orders deleted in Shopify

`orders/delete` is now subscribed. The order is marked `shopify_deleted_at` and
disappears from the orders list, the dashboard counts and the chart. **The
MetaKocka document is left exactly where it is** — it is the accounting record,
it may already be invoiced, and removing it to tidy a screen would destroy a
book entry. Deliberately not an exception: there is nothing for anyone to decide.

---

## 20. Where SH-1004 ended up

```
order status: written
doc SH-1004-GLAVNO status=written mkId=1200049908523 paidAt=2026-08-25T10:51:41Z
open exceptions: (none)
```

Written, paid, clean.

**One thing I could not check:** the mapper's lines render in a page I could not
scroll inside the embedded admin frame. The percentage bug is definitively fixed
— percentages cannot work in an SVG path — but I have not seen the lines myself.
Worth a look.

238 tests pass; `tsc`, `eslint` and `prettier` clean. Probe scripts deleted.

---

## 21. Payment mapping is a table now, and unmapped has an answer

The drawn-line mapper is gone (`src/web/components/payment-mapper.tsx` deleted).
It cost a `getBoundingClientRect` per row on every render, a `ResizeObserver`
and a resize listener, all to keep curves attached to boxes — and it had nothing
to draw at 490 px, where the two columns stack and a line between them crosses
the content instead of joining it. What it was expressing is one sentence:
_this gateway settles into that type_. A row and a select say that, at any
width, and a screen reader can read it.

`app.settings.payments.tsx` is now an `s-table variant="auto"` — one row per
gateway, three columns:

| Gateway                                    | MetaKocka payment type       | Status              |
| ------------------------------------------ | ---------------------------- | ------------------- |
| **Cash on delivery**<br>`cash_on_delivery` | select, 260 px, label hidden | `Mapped` / Fallback |

`variant="auto"` is what makes 490 px work: the table becomes a list of
labelled fields rather than columns that scroll sideways. The raw handle stays
under the friendly label because the handle is what Shopify sends and what this
app stores — a merchant reconciling against Shopify's own reporting needs the
exact string. Labels come from `src/web/lib/payment-gateways.ts`; an unknown
handle falls back to itself rather than to a wrong friendly name.

Several gateways may point at one type, so nothing is deduped or disabled. One
gateway points at one type, because `payment_type` on a document is a single
string.

**The MetaKocka type list is not filtered.** Odd entries exist in real
registers — a one-letter test row, an old name kept for reconciliation — and
hiding them would puzzle whoever created them.

Saving moved to the contextual save bar (`<Form data-save-bar>`, §2.6); the
standalone Save button is gone. Discard fires `reset` on the form, which is what
restores the selects.

### The fallback, which is the point of the refactor

A pinned box below the table: **Fallback for unmapped**, required, blocked on
save with an inline error if empty.

It exists because unmapped gateways had no defined behaviour at write time.
`resolvePayment()` in `src/jobs/handlers/write-metakocka-order.ts` used to raise
`unmapped_payment_gateway` and create the order unpaid — safe, but it means every
new gateway leaves an order waiting on a person. Now:

```
mapped type  →  use it
no mapping   →  use the shop's fallback, event detail viaFallback: true
neither      →  exception, as before
```

This is still not a guess (§8.7 forbids guessing `payment_type`): every
candidate is a string the merchant chose from their own register. The event
trail records `viaFallback` because a payment recorded against a type nobody
picked _for that gateway_ reads differently in a reconciliation than a
deliberate mapping.

Cash on delivery still short-circuits before any of this — it is not paid at
order time, whatever Shopify's financial status says.

Storage: new `PaymentSetting` model (`shopId` unique, `fallbackPaymentType`),
migration `20260825140000_payment_setting`.

238 tests pass; `tsc`, `eslint` and `prettier` clean.

---

## 22. The payment types page submitted itself

Found while testing the new mapping table. The event log recorded a
`payment_types.saved` with `count: 7` and refreshes nobody asked for:

```
11:46:52 payment_types.loaded  {"count":4}
11:46:26 payment_types.loaded  {"count":4}
11:46:24 payment_types.saved   {"count":7,"fallback":"Gotovina"}
11:46:07 payment_types.loaded  {"count":4}
```

Nobody pressed Save. The page held two `<Form method="post">` elements, and
something on it — a submit-typed control inside one of them, most likely — was
submitting them on its own. The save wrote a single payment type, "Gotovina",
across all seven gateways and into the fallback, replacing the one real mapping
the merchant had (`manual` → "Transakcijski račun").

**Restored** to that one row with the fallback back to empty. I did not guess a
fallback on the merchant's behalf.

**Fixed by removing every submittable form from the page.** Both writes now go
through `useFetcher`, called from an `onClick`. There is no form element left
for anything to submit.

The save also stopped sending the mapping as two parallel `getAll("gateway")` /
`getAll("type")` lists. Those only line up while every row renders exactly one
of each in the same order — and when they do not, a payment type lands against
the wrong gateway silently. It travels as one JSON field now, parsed with Zod.

### The save bar never appeared either

`data-save-bar` decides a form is dirty by listening for change events on its
fields. Every value on this screen lives in a hidden input written by React,
which fires nothing a listener can hear, so the bar stayed down and there was
no way to save at all. It is now a `ui-save-bar` driven from the page's own
comparison of state against what the loader returned — which is the thing that
is actually true. Empty and absent compare equal, so mapping a gateway and then
unmapping it again puts the bar away.

**This is worth checking on the product sync settings screen**, which uses the
same `Dropdown` inside a `data-save-bar` form. Its checkboxes and text fields
still raise the bar, so it is not dead — but a visit where the only edit is a
dropdown has the same problem.

### Payment types now load on their own

New queue and handler, `reload-payment-types`, mirroring `reload-warehouses`:

- **Nightly**, from the scheduled tick — not quarter-hourly like the warehouses.
  Reading the register means sending a document that fails validation on
  purpose (§8.7: no endpoint lists the types), and doing that every fifteen
  minutes would fill the merchant's own API log with rejections that are not
  failures. A payment register changes a few times a year.
- **On opening the page**, when the cached list is empty or over a day old. Not
  awaited — §2.5 — so the screen renders from the database and the fresh list
  arrives underneath it. The page revalidates for a minute, then stops.
- Discovered types are **merged**, never replaced, so nothing a mapping depends
  on disappears because one error string parsed short.

The "Add a payment type by hand" field is gone; the automatic read covers it.

A Help action in the page header explains that the types live in MetaKocka under
Settings › Registers › Payment type, and links straight to
`https://main.metakocka.si/index.jsp#nastavitve_sifranti`.

### Still open

`s-table variant="auto"` picks between the column layout and a stacked list by
measuring, and it does not always pick the same way at the same width — the
same screen came back as columns on one load and as stacked labels on the next.
Polaris only accepts `auto` or `list`, so the column layout cannot be pinned.
Both are legible and both save the same thing.

238 tests pass; `tsc`, `eslint` and `prettier` clean.

---

## 23. Edits disappeared whenever the loader ran again

Reported straight after §22: a save blocked by the empty fallback took every
other edit down with it.

The page reset its state from the loader on object identity:

```tsx
useEffect(() => {
  setMapping(savedMapping);
  setFallback(savedFallback);
}, [savedMapping, savedFallback]); // a fresh object on every loader run
```

The loader runs constantly on this screen — after every save, whether it
succeeded or not, and every five seconds while a payment type refresh is in
flight. So each run handed over a new object, the effect fired, and whatever
the merchant had chosen was replaced by what was already in the database. A
rejected save looked like the page had thrown the work away, because it had.

It now compares the stored **values**, not the object:

```tsx
const savedKey = JSON.stringify([normalise(savedMapping), savedFallback]);
if (appliedKey.current === savedKey) return;
```

A revalidation that returns the same data leaves the edits alone. `dirty` is
the same comparison, so the save bar and the reset can no longer disagree.

The fallback error is shorter: "Choose a type. Every unmapped gateway above
uses it." The field is labelled Required, and the row is top-aligned so the
label no longer sinks to the bottom when the error wraps.

238 tests pass; `tsc`, `eslint` and `prettier` clean.

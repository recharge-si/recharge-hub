# Needs a human

Ordered by risk. Each entry has the exact next action.

## T-01 — Install coverage tooling
`npm i -D @vitest/coverage-v8`, then `npx vitest run --coverage` and check
`src/domain/` is near-exhaustive. Blocked in this run by the no-new-dependencies
rule.

## T-02 — Probe get_document by buyer_order on a split order (test company only)
The recovery path treats "a sibling answered" as inconclusive because nobody has
recorded what `get_document` returns when several documents share `buyer_order`.
Create two sales orders sharing `buyer_order: "CLAUDE-VERIFY-SPLIT-1"` on
company 6789, then send and record:
```json
{ "secret_key": "…", "company_id": "6789", "doc_type": "sales_order",
  "buyer_order": "CLAUDE-VERIFY-SPLIT-1" }
```
and the same with `"show_split_orders": "true"`. If it returns all siblings, the
inconclusive branch in `write-metakocka-order.ts` can become fully automatic.

## T-03 — Probe /search by count_code (test company only)
Docs (search_concept.md) show `POST {base}search` answering `result: [{mk_id,
count_code, …}]`. If `query` matches a sales order's `count_code`, recovery can
look up the exact document instead of going through `buyer_order`:
```json
{ "secret_key": "…", "company_id": "6789", "doc_type": "sales_order",
  "query": "SH-1006-GLAVNO", "limit": "10" }
```
Record the response under tests/fixtures/metakocka/.

## T-04 — No database-backed test harness
`claimDocument`, the transactional enqueue, and the write handler's double-run
behaviour are only verifiable against Postgres. Add a vitest project that runs
against the compose `postgres` service (prisma migrate deploy + per-test
truncation) and assert: two concurrent `write-metakocka-order` runs for one
source produce exactly one document row and one MetaKocka call.

## T-05 - Shipping line and discount_value probes (test company only)
Needed before the section 8.6 gap (shipping never on the document) can close:
1. Create a service product (e.g. code POSTNINA) on company 6789, then
   put_document a sales order with a normal line plus
   `{ "code": "POSTNINA", "amount": "1", "price_with_tax": "4.90", "tax_factor": "0.22" }`
   and read it back: does sum_all include it, does the warehouse ignore a
   service line's stock?
2. put_document with `"discount_value": "5.00"` and read back sum_basic /
   sum_all to learn its basis and whether it spreads per line.
Record both under tests/fixtures/metakocka/.

## T-06 - Probe the per-line `discount` field (test company only)
put_document a sales order on company 6789 with one line
`{ "code": "...", "amount": "2", "price_with_tax": "10.00", "tax_factor": "0.22", "discount": "10" }`
and read it back: is `10` a percent or an amount, what does `sum_all` become,
and does `price_with_tax` mean before-discount or after? Repeat with
`"discount": "10.00"`. Record under tests/fixtures/metakocka/. Blocks the
line-discount fix in REPORT.md.

---

# Documented but unbuilt

Added 26 August 2026, from the second hardening pass. Each of these is either a
feature `docs/BUILD_SPEC.md` describes and the code does not have, or a decision
that changes what a merchant sees. None was built unattended.

## T-07 — Unused access scopes, before App Store review
`shopify.app.toml` and `.env` request
`read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders`.

Verified in this pass: the only Shopify mutations in the codebase are
`inventorySetQuantities` and `inventoryActivate`. Nothing writes a Shopify
product, and nothing touches a fulfilment order. So `write_products` and both
fulfilment scopes are currently unused, which section 2.3 ("minimum necessary,
every scope justified") makes a review risk.

**The decision is yours because dropping a scope is not free.** Re-adding one
later forces every installed merchant through a re-consent screen, and both are
scopes this app is expected to need: `write_products` for section 8.9's
MetaKocka-to-Shopify direction (T-09) and the fulfilment scopes for section 8.3
(T-08). Either build those before submitting, or drop the scopes and accept the
re-consent when they land.

## T-08 — Section 8.3 is absent: fulfilment orders are never moved or split
`allocate-order` enqueues `write-shopify-fulfilment` and **nothing consumes
it**. Orders reach MetaKocka correctly; the Shopify side of a split order is
never arranged, so the merchant's fulfilment screen still shows one fulfilment
order at the default location however the app allocated it.

The queue now carries an explicit seven-day retention so unconsumed jobs are
archived rather than accumulating one row per allocated order for ever. Remove
that retention when the handler lands.

Next action: implement the handler using `fulfillmentOrderSplit` and
`fulfillmentOrderMove`, recording the resulting ids on `allocation`. This
changes what a merchant's staff see in the Shopify admin, which is why it was
not done unattended. Note section 2.7's decision **not** to register as a
fulfillment service still holds — these are merchant-managed locations.

## T-09 — Section 8.9's MetaKocka-to-Shopify direction is absent
The field ownership table says SKU/code, price, tax, weight, dimensions and
barcode are mastered in MetaKocka and flow MK to Shopify. Nothing in the code
writes any of them to Shopify: `sync-products` writes *into* MetaKocka and
`sync-catalogue` reads *from* Shopify.

Next action: decide whether v1 ships without it (and say so in
`docs/BUILD_SPEC.md`), or
build it. It is the only reason `write_products` is requested (T-07).

## T-10 — Section 8.5 tracking sync back to Shopify is absent
No job reads tracking codes out of MetaKocka and creates Shopify fulfilments.

Blocked on a real question, not on effort: section 3 records that
`get_document` returns **no tracking field of any kind** on a sales order, so
there is nowhere known to read a tracking code from. Before building anything,
find out where MetaKocka keeps it — a delivery note (`delivery_note`)? the
`search` endpoint's last-tracking-event-change filter? — and record the probe
under `tests/fixtures/metakocka/`.

## T-11 — Section 8.10's nightly cross-checks are mostly missing
Present: the fifteen-minute order reconciliation, the five-minute stock cycle,
the exception re-check, the hourly document poll.

Absent: every Shopify order in the window having the expected number of
MetaKocka documents; every allocation having a corresponding fulfilment order
(which cannot exist before T-08); document totals summing to the Shopify order
total; MetaKocka `free_amount` still agreeing with Shopify available.

Section 8.10 is explicit that every discrepancy becomes an exception rather
than a log line, and that the results surface on the home page (section 2.7).
That is a new exception kind, new home-page copy and a migration, so it is a
piece of product rather than a fix.

## T-12 — Partner resolution matches by name alone as a last resort
`src/adapters/metakocka/partners.ts` (`findPartner`) searches
`partner_tax_number`, then `partner_email`, then `partner_name`, and on an
ambiguous result takes the first match. The code says so plainly and explains
why — creating yet another duplicate is the worse answer, and MetaKocka returns
records in creation order so the oldest wins. What it cannot know is whether
the two records are the same person: two different customers called "Novak"
become one partner in the merchant's ERP, and orders for one are filed against
the other.

Note also that section 3 lists `partner_phone_number` as searchable and this
does not use it. A phone number identifies a person about as well as an email
does, so adding it before the name query is probably free improvement — but it
is still a change to who an order gets filed against.

The alternatives are all trade-offs a person should pick:
1. Stop matching on name and create a new partner instead — safe against
   merging, but produces duplicates for repeat customers who order as guests.
2. Match on name **plus** postcode or street — much safer, still not exact.
3. Raise an exception on a name-only match and let the merchant choose.

Section 3 verified that inline partner data creates a duplicate every time, so
"do nothing" is not among the options: something has to decide.

## T-13 — Section 2.4 encryption at rest for PII in jsonb
`order.raw_payload` and `metakocka_document.request_body` hold customer names,
addresses, emails and phone numbers in plaintext jsonb. Section 2.4 requires
encryption at rest for customer PII, and the app already has AES-256-GCM
(`adapters/crypto/secrets.server`) for the MetaKocka key.

The obstacle is real: `customers-redact` finds affected orders with a jsonb
**path match** on the payload, which an encrypted blob makes impossible, and
the retention job walks the payload's structure. Encrypting these columns needs
a design that keeps both working — probably a searchable index column holding a
keyed hash of the customer email, with the payload encrypted whole.

Full-disk or Postgres-level encryption may satisfy the requirement instead.
That is worth confirming with Shopify's Level 2 reviewers before writing code.

## T-14 — Sixty-seven direct `prisma.*` calls outside `adapters/db`
Section 9 says every query filters by `shop_id`, enforced in the repository
layer so route code cannot forget. Counted this pass: 67 direct `prisma.*`
calls in `src/jobs` and `src/web`.

The two tenancy bugs found in this pass were both inside `adapters/db` or
beside it, so this is not the cause of either — but it is the reason the
rule exists, and every one of those 67 call sites is a place where the filter
has to be remembered by hand.

Not refactored unattended: it is a wide, mechanical change across jobs and
routes, and doing it in one sweep would make every future `git blame` on those
files point at this run. Next action: list the call sites, then move them a
subsystem at a time with the tests green between each.

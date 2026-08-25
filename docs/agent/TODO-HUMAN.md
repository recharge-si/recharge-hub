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

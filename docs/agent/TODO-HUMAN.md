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

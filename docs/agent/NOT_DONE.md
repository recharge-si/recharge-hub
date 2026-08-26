# NOT DONE — remaining work from the overnight hardening run

Everything below was identified but not executed. Items are ordered so the most
valuable work comes first. Ground rules that still apply to whoever picks this up:

- Never call a live MetaKocka company. Fixtures and `docs/metakocka-verification.md` only.
- Every commit must pass `npx tsc --noEmit`, `npx eslint .`, and `npx vitest run` (437 tests green at last commit).
- No `any`, no `as` across a boundary, no invented MetaKocka/Shopify field names.
- Additive migrations only. Branch: `agent/overnight-hardening`.
- Observation numbers (obs N) refer to `observations-full.json` in the session scratchpad;
  each item below carries enough context to work without it.

---

## Batch 1 — money / correctness (in progress, highest value)

### 1. [P1] Presentment currency read from wrong fields (obs 15)
`src/adapters/shopify/order-payload.ts`. The parser stores `currency` from the
presentment currency code, but `totalMinor`, `discountMinor`, `totalTaxMinor` and
line `price` are read from the plain REST fields, which are **shop currency**. On a
multi-currency store the amounts and the currency code disagree, and every MetaKocka
document is priced wrongly.

Fix: read presentment amounts from the `*_set` fields — `current_total_price_set` /
`total_price_set`, `total_discounts_set`, `total_tax_set`, line `price_set`, line
`total_discount_set` — preferring `presentment_money`, falling back to the plain
field when the set is absent. The schema pattern already exists in the same file for
`total_shipping_price_set` (lines ~77–80: `presentment_money: z.object({ amount:
money }).nullish()`); clone it. Add a multi-currency unit test proving the
presentment amount is stored under the presentment currency. Check
`tests/unit/order-payload.test.ts` for assertions that pin the old behaviour.

### 2. [P1] sync_stock echo branch distorts unmanaged stock (obs 7)
`src/adapters/metakocka/sync-stock.ts`, `buildCompleteStockList`. §7: omission
removes, so unmanaged products are echoed back at the value MetaKocka already
holds. But the echo branch applies `Math.max(0, Math.trunc(amount))` — the same
clamp as the managed branch — so a held value of `3.5` or `-2` is *changed* by the
echo, which is exactly the destructive write the echo exists to prevent.

Fix: echo branch sends the exact held value (fractions and negatives preserved);
managed branch keeps its clamp. First read how `StockLine.amount` serializes into
the request body (~lines 130–150) so a fractional/negative number survives
`JSON.stringify`. Update `tests/unit/sync-stock.test.ts` with a fraction and a
negative echo case.

### 3. [P2] Order page crashes on redacted payload (obs 36/40)
`src/web/routes/app.orders.$orderId.tsx`, the `accept-shopify` (mark-sorted)
intent calls `parseOrder` on `order.rawPayload`. After the 90-day §2.4 redaction
that throws, so the button 500s. Fix: use `parseOrderSafe`; when it returns null,
return a friendly action error ("payload redacted, too old to compare") instead of
crashing. Grep the file for other `parseOrder(` call sites while there.

### 4. [P2] Money guards (obs 60, 69)
- `src/domain/money/tax.ts` (obs 69): `Math.round` on negative halves rounds
  toward +∞ in JS (`Math.round(-0.5) === -0`), asymmetric with positives. Decide
  and pin behaviour with a test (refund-shaped negative amounts).
- `src/domain/money/*` split (obs 60): primary share can go negative when
  order-level discount exceeds the primary's own lines. Add a guard/exception
  rather than sending a negative document total. Write the failing test first.

---

## Batch 2 — security / tenancy

### 5. [P1] recordExceptionAttempt is not shop-scoped (obs 13)
`src/adapters/queue/redrive.server.ts` lines ~269–277. `updateMany({ where: { id:
exceptionId } })` — any authenticated shop can increment attempts on another
shop's exception if it guesses an id. Add the shop filter: callers have a
`Principal`; change the signature to take it and filter
`where: { id, shop: { domain } }`. Update all call sites (exceptions page, order
page, recheck-exceptions).

### 6. [P1] setManualAllocations does not verify source ownership (obs 92)
Route action for manual per-line source selection (order page). The chosen
`supplySourceId` is written without checking it belongs to the shop. Verify with a
scoped `findFirst` before writing; reject otherwise.

### 7. [P2] Staff non-owner 500s (obs 12, 18)
`app.products.sync`, `app.settings.payments`, `app.settings.supply-sources`
loaders call `getCredential` which throws `NotPermittedError` for non-owner staff
→ 500 page. Use `getCredentialSummary` where only "is connected" is needed, or
catch `NotPermittedError` and render the not-permitted state the credentials page
already has.

### 8. [P2] Webhook 401 unification (obs 93)
Webhook endpoints answer differently for bad HMAC vs unknown shop vs malformed
body — a probe can distinguish shops. Answer the same 401 for all failure shapes.

---

## Batch 3 — adapter robustness

### 9. [P2] sync-stock error handling (obs 26)
`src/adapters/metakocka/sync-stock.ts`: no `classifyHttpStatus`, and `JSON.parse`
of a non-JSON body throws raw `SyntaxError` (which pg-boss retries as if
retryable). Mirror the client.ts pattern: classify HTTP status, wrap parse
failure in a typed error.

### 10. [P2] sync-stock ack is count-only (obs 25/71)
Same file: the response check compares only the count of acknowledged lines. §7
says a no-op reports success, so verify returned `stock_list` content matches what
was sent (code + amount), not just its length.

### 11. [P2] Reconciler truncates lines at 100 then deletes the rest (obs 42)
Order reconciliation GraphQL reads `lineItems(first: 100)` with no pagination; an
order with >100 lines has its overflow lines treated as removed on compare. Either
paginate (`pageInfo { hasNextPage }`) or hard-guard: if `hasNextPage`, skip the
line diff and raise an exception instead of deleting.

### 12. [P3] api_version drift (obs 41)
Admin client and webhook registration pin different API versions. Single constant.

### 13. [P3] writeOnHand batch locationId assert (obs 100)
Inventory adapter: batch items each carry a locationId; assert every item matches
the batch's location (the one-writer check runs per batch).

---

## Batch 4 — small fixes

- (obs 62) `src/domain/allocation/allocate.ts` contains a stray NUL byte — remove it.
- (obs 61) `localeCompare` used for deterministic ordering in allocation — platform-dependent; replace with a codepoint compare.
- (obs 98) `redactPayload` blanks every key named `name` recursively — `order.name` ("#1006") and line-item names are not PII and the diff/UI use them. Blank names only inside `customer` / `billing_address` / `shipping_address` (already fully blanked). Check `tests/unit/order-payload.test.ts` assertions first.
- (obs 87) `order.redacted` flag derived from `rawPayload === null`; should be `redactedAt !== null`.
- (obs 102) Dashboard `allocatedToday` counts orders with `shopifyDeletedAt` set — exclude them.
- (obs 103) Strip `client_details` / `browser_ip` from the payload at intake — data minimisation (§2.4); never used.
- (obs 104) Dead `orders-create` queue registered but nothing enqueues to it — remove queue + handler wiring.
- (obs 105) `poll-metakocka-documents` runs quarter-hourly; §8.11 says hourly. Move it to the hourly/nightly tick or add an hourly key.
- (obs 106) `scheduled-tick` loops shops; one shop throwing aborts the rest. Per-shop try/catch + Sentry, continue the loop.

---

## Documented-but-unbuilt (needs TODO-HUMAN / REPORT entries, not code)

Write these into `docs/agent/REPORT.md` (finding format) and/or
`docs/agent/TODO-HUMAN.md`; do NOT build them without the human:

- (obs 23/45) `write-shopify-fulfilment` queue has **no consumer** — §8.3 (fulfilment order move/split) is absent entirely. Orders flow to MetaKocka but Shopify fulfilment orders are never moved/split.
- (obs 105b) §8.5 tracking sync back to Shopify: absent.
- (obs 11/44) §2.4 encryption-at-rest for customer PII in jsonb: not implemented. Note: encrypting `rawPayload` would break the `customers-redact` jsonb path matcher — needs design.
- (obs 46) ~60 direct `prisma.*` calls outside `adapters/db` — §9 repository-layer rule is aspirational; list, don't refactor overnight.
- (obs 96) Unused scopes requested: `write_products`, fulfillment scopes — either use or drop before review (§2.3).
- (obs 81/101) `inventory_levels/update` webhook not subscribed, but §7 loop-prevention logic expects it.
- (obs 52/14) §8.10 nightly checks (document count per order, totals vs Shopify, free_amount vs available) mostly missing.
- (obs 27/31) Partner resolution matches by name alone as last resort — two customers named "Novak" merge. Needs a decision.
- (obs 33/34) §12 integration test (webhook in → two MetaKocka bodies asserted field-by-field) does not exist; MSW installed but unused.

---

## Deliverables not yet produced

- **MAP.md** — synthesize from `inventory-*.md` files in the session scratchpad (`C:\Users\grega\AppData\Local\Temp\claude\...\scratchpad`); if gone, regenerate by reading each subsystem.
- **DRIFT.md + CLAUDE.md updates** (Pass 6) — spec-vs-code disagreements found so far are flagged in REPORT.md entries; consolidate.
- **UX.md** (Pass 3) — feed from web observations: 375 px grid overflow (obs 38), exceptions list truncation without "more" (obs 39), save-bar violations (obs 94), breadcrumb (obs 90), hydration mismatches (obs 88), screen-reader table semantics (obs 89).
- **Pass 2** BFS checklist sweep against §2 (systematic, per-requirement).
- **Pass 4** perf: `load-pricelists` runs inline ~60 s in a request (obs 37); product loaders block on live GraphQL (obs 95) — both violate §2.5.
- **Pass 5** test matrix: §12 allocation edge cases missing (obs 33/34/35/80).
- **Final PR-style summary** in REPORT.md: commits, tests added, findings by severity, honest statement of what was not verified.

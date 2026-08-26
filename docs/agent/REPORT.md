# Overnight hardening run — report

Branch: `agent/overnight-hardening`. Base: `3ae84d7` (snapshot of the developer's
in-progress products-phase-3 work, committed as-is so agent changes are separable).
Run date: 2026-08-25/26. Written as the run progresses; sections may be appended
out of order.

## 0. Baseline (ground truth, measured)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (react-router typegen && tsc --noEmit) | 0 errors |
| Lint | `npm run lint` (eslint .) | 0 errors |
| Tests | `npx vitest run` | 29 files, 424 tests, 424 passed, 1.6 s |
| Prisma schema | `npx prisma validate` | valid |
| Compose | `docker compose config` | valid (docker server 28.3.3 present) |
| Import-direction rule | temporary `domain -> adapters` import | eslint fails with `import/no-restricted-paths` — rule works |
| Clock rule | temporary `Date.now()` in `src/domain/types.ts` | eslint fails with `no-restricted-globals` + `no-restricted-properties` — rule works |

- Coverage: **not measurable** — `@vitest/coverage-v8` is not installed and rule 7
  (no new dependencies) forbids adding it. Recorded in TODO-HUMAN.md. Per-directory
  test-file counts are used instead.
- Source size: ~25,500 lines across `src/`.
- Test distribution: all 29 test files are `tests/unit/`; fixtures exist for
  `metakocka/warehouse_list` and the three Shopify compliance payloads only.

## Findings

(appended as passes complete)

### [P0] Ambiguous put_document failure was blindly retried — duplicate ERP sales orders
- **Where:** `src/jobs/handlers/write-metakocka-order.ts` (create path), `src/adapters/metakocka/errors.ts:94-96`, `src/adapters/db/repositories/order.server.ts` (claimDocument), `src/adapters/metakocka/documents.ts` (dead `findDocumentByBuyerOrder`)
- **What:** A `put_document` timeout/5xx/reset was classified `retryable`, the
  document row marked `failed`, and the error rethrown; pg-boss retried (limit 4);
  `claimDocument` re-claims a `failed` row with `alreadyWritten: false`; the
  handler then re-sent `put_document` with the same `count_code` — with no lookup
  first. The stale-`pending` reclaim (job died between claim and record) took the
  same blind path. The resolve-by-lookup function existed
  (`findDocumentByBuyerOrder`) but had **zero callers**, and its response schema
  expected a `result_list` array that neither the official docs nor the live
  verification show — it could never have parsed a real response.
- **Why it matters:** §3 Finding C (verified live): re-sending an existing
  `count_code` silently creates a **second** sales order under MetaKocka's own
  numbering. One timed-out order becomes two ERP documents, both real to the
  merchant's books.
- **Spec:** CLAUDE.md §3 ("an ambiguous timeout must be resolved by lookup, never
  by blind retry"), §8.4.
- **Status:** fixed. `claimDocument` now reports `reclaimed` and
  `previousRejection` (only a recorded `opr_code` — MetaKocka answering "no" —
  proves no document was created); the handler resolves any other re-claim by
  `get_document` with `buyer_order` (the verified searchable reference, Finding
  B) before sending: our `count_code` answers → adopt as written (payment mark
  recorded only when MetaKocka confirms one); "Cannot find document" → definitive
  absent → safe to send; a *sibling* answers (split order, response shape for
  multiple matches undocumented) → exception naming the count code, never a
  send. The request body is also now recorded **before** the call (§8.4), so a
  timeout leaves behind what MetaKocka may be holding. Also rewrote the lookup on
  the verified single-document response shape.
- **Verified by:** `npx vitest run` — 30 files, 428 tests pass (4 new in
  `tests/unit/metakocka-document-recovery.test.ts`: request shape, adopt parse,
  cannot-find → null, any-other-error → throw); `tsc --noEmit` and `eslint .`
  clean. Handler-level double-run needs a database harness that does not exist —
  recorded in TODO-HUMAN.md.

### [P2] A job that ran out of retries vanished silently
- **Where:** `src/adapters/queue/queues.ts` (no `deadLetter` anywhere), `src/jobs/worker.ts`
- **What:** pg-boss moved a job that exhausted its retry budget to its `failed`
  state and nothing consumed that. An order could sit allocated-but-unsent
  forever with a green dashboard; a compliance redaction could fail its 12
  retries and nobody would hear. (The 15-minute order reconciler re-drives
  stalled *order* writes, which is why this is P2 and not P0 - but compliance,
  sync and uninstall work had no such net.)
- **Why it matters:** Section 11 promises retryable failures need no human
  because the queue is dealing with them. Once retries are exhausted the queue
  has stopped dealing with them, and the promise inverts.
- **Spec:** run prompt Pass 1 ("a dead job must raise an exception row"); not
  explicit in CLAUDE.md section 11 - recorded in DRIFT.md as a spec gap.
- **Status:** fixed. New `dead-jobs` queue; `deadLetter` set on every
  order-flow, sync, uninstall and compliance queue (scheduled ticks and nightly
  register reloads deliberately excluded - the next tick re-runs them, so their
  failure stays a Sentry event). Consumer raises a `job_failed` exception
  (new enum value, additive migration 20260826010000) attributed to the shop
  and order where the payload names them, deduplicated per queue for
  queue-level jobs. Exceptions UI copy and the retry mapping know the new kind;
  the re-check sweep leaves it open (safe default confirmed at
  recheck-exceptions.ts:485).
- **Verified by:** `tsc --noEmit`, `eslint .`, `npx vitest run` (428 tests) all
  clean. pg-boss dead-letter SQL read in node_modules (plans.js:1866-1890):
  the DLQ job carries the original `data`, `output`, and `source_name`, which
  is exactly what the consumer reads. Live double-check against a real Postgres
  is in TODO-HUMAN.md T-04.

### [P1] Shipping and order-level discount never reach the MetaKocka document
- **Where:** `src/jobs/order-shares.ts`, `src/adapters/metakocka/documents.ts`
  (`buildSalesOrderBody`), `src/jobs/handlers/write-metakocka-order.ts`
- **What:** `computeDocumentShares` folds shipping, COD surcharge and
  order-level discount into the primary document's *share* - which is what the
  payment is recorded for (`mark_paid.amount = share.totalMinor`) - but
  `buildSalesOrderBody` sends only the product lines. The primary document in
  MetaKocka therefore totals to its lines while carrying a payment for lines
  plus shipping minus discount: on every order with shipping, the ERP shows a
  document over-paid by the shipping amount, and an invoice raised from that
  sales order bills the customer nothing for shipping.
- **Why it matters:** Real money: a merchant invoicing from the sales order
  under-bills shipping on every order. And the section 8.10 nightly assertion
  "document totals sum to the Shopify order total" can never hold.
- **Spec:** CLAUDE.md section 8.6 says shipping and order-level discount "go on
  the primary document only" - the code puts them on the primary *payment*
  only. The spec names no mechanism; the official put_document docs (fetched
  this run) show **no shipping field at all**, and an order-level
  `discount_value` field that this app has never verified live.
- **Status:** needs human - not fixable tonight without inventing MetaKocka
  semantics (rule 8). Proposed design below.
- **Verified by:** reading both files; official docs
  documents_put_document_sales_order.md field list (no delivery/postage field;
  `discount_value` exists).

Proposed design (for review, not built):
```text
1. sales_order_setting gains shipping_product_code (merchant-chosen, validated
   against the catalogue like any SKU, empty = keep today's behaviour).
2. buildSalesOrderBody, primary document only: append a line
   { code: shipping_product_code, amount: "1", price_with_tax/price: shippingMinor }
   with the order's shipping tax factor (Shopify supplies shipping_lines tax).
3. Order-level discount: probe discount_value on company 6789 first (gross or
   net? does it change sum_all? per-line spread?). Until verified, keep
   discount inside the payment share only and raise an exception when
   discountMinor > 0 and a document is written, naming the difference.
```

### [P1] Line-level discounts never reach the document or the shares
- **Where:** `src/adapters/shopify/order-payload.ts:387` (parsed and stored),
  `src/jobs/handlers/write-metakocka-order.ts` (line built from
  `unitPriceWithTaxMinor` alone), `src/jobs/order-shares.ts:44` (share =
  `quantity * unitPriceWithTaxMinor`, discount ignored)
- **What:** A Shopify line's `total_discount` is parsed, stored on
  `order_line.discount_minor`, shown in the order-state diff - and then never
  used. The MetaKocka document line carries the **undiscounted** unit price, so
  `sum_all` overstates the goods by every line discount; an invoice raised from
  that sales order overcharges the customer. The per-document shares have the
  same blindness, so a discounted line on a non-primary source silently shifts
  its discount onto the primary document's payment (the remainder assignment in
  `splitOrderMoney` forces the total to balance, on the wrong document).
- **Why it matters:** Real money on every order using line discounts (sales,
  automatic discounts, B2B price lists). Aggregate payment still matches the
  Shopify total, which is exactly why nobody would notice until an invoice is
  disputed.
- **Spec:** CLAUDE.md section 8.6: "Line-level discounts stay with their line."
  The code does not implement the sentence.
- **Status:** needs human. The official put_document docs show a per-line
  `discount` field (`"discount": "10"`), but whether it is a percent or an
  amount, and its interaction with `price_with_tax`, is unverified - inventing
  it is rule 8. Proposed patch below, gated on the T-06 probe.
- **Verified by:** grep of every `discountMinor` consumer; the only arithmetic
  consumers are `splitOrderMoney` (order-level only) and the diff.

Proposed patch once T-06 answers:
```text
1. order-shares.ts: lineTotalMinor -> quantity * unitPriceWithTaxMinor minus the
   allocation's share of line.discountMinor (proportional by quantity,
   remainder to the larger allocation - proportionalSplit already exists).
2. splitOrderMoney input discountMinor -> order-level discount only
   (order.total_discounts minus the sum of line total_discounts).
3. buildSalesOrderBody line: send the verified discount field, or restate the
   unit price when the probe says that is the only faithful encoding.
4. Tests: a discounted line on a non-primary source keeps its discount on its
   own document; documents still sum to the Shopify total.
```

### [P0] customers/redact was a stale M1 stub — it deleted nothing
- **Where:** `src/jobs/handlers/customers-redact.ts` (whole file)
- **What:** The handler logged an event with `redactedRecords: 0` and returned.
  Its own comment said "M1 stores no customer data at all... When
  order.raw_payload and metakocka_document.request_body exist, redacting them
  belongs here" - and both have existed since M4, along with
  `order.partner_override` (merchant-typed customer details, kept
  indefinitely). A GDPR deletion request acknowledged 200 to Shopify and erased
  nothing. Found independently by two audit passes.
- **Why it matters:** Legal obligation and an App Store rejection criterion.
  Section 2.4: "customers/redact and shop/redact must actually delete. Test
  this."
- **Spec:** CLAUDE.md section 2.4. The spec is right; the code was stale.
- **Status:** fixed. The handler now redacts `raw_payload` (same walker as the
  90-day job, so the decision trail survives), redacts every linked
  `metakocka_document.request_body`, and drops `partner_override` outright, for
  the orders Shopify names in `orders_to_redact` plus any stored payload still
  matching the customer id (number or string). Also fixed alongside:
  **the 90-day retention job never touched `partner_override`** despite
  `savePartnerOverride`'s comment promising it - it does now.
- **Verified by:** `tsc --noEmit`, `eslint .`, `npx vitest run` (433 tests).
  `redactPayload`'s walker behaviour already unit-tested
  (order-payload.test.ts). The full insert-fire-assert-empty test needs the
  Postgres harness (TODO-HUMAN T-04) - said plainly: the handler logic is
  reviewed and typed, not executed against a database in this run.

### [P0] Three cron schedules collided on one upsert key - only the nightly one ever ran
- **Where:** `src/jobs/worker.ts` (the three `boss.schedule` calls)
- **What:** pg-boss upserts schedules `ON CONFLICT (name, key)` with `key`
  defaulting to the empty string (timekeeper.js: `const { tz = 'UTC', key = ''
  ... }`; plans.js:825-833). All three cadences were scheduled on the same
  queue with no key, so each call overwrote the previous row and only the
  last - nightly - survived. The five-minute stock sync, the fifteen-minute
  order reconciler, the exception re-check and the document poller never
  fired. Every guarantee in section 8.10 that "runs on a schedule regardless"
  was quietly not running; webhooks were the only thing keeping the app alive.
- **Why it matters:** The whole self-healing layer - the answer to MetaKocka's
  two-retry webhook, missed Shopify deliveries, stale stock - existed only in
  code. A missed orders/paid webhook would never be recovered; published stock
  could stay wrong for a day.
- **Spec:** CLAUDE.md sections 8.10, 3. The spec is right; the code was wrong.
- **Status:** fixed - each schedule now carries its cadence as `key`, and the
  worker first `unschedule`s the keyless row so an existing database does not
  fire the nightly tick twice.
- **Verified by:** pg-boss source read (upsert key confirmed); `tsc`, `eslint`,
  `vitest run` green. A live scheduler observation needs the compose stack
  (T-04 harness).

### [P0] Re-claiming a failed document row was check-then-act - two concurrent jobs could both pass the duplicate guard
- **Where:** `src/adapters/db/repositories/order.server.ts` (claimDocument)
- **What:** A `failed` row was re-claimed by reading it and returning
  `alreadyWritten: false` to the caller, with no write. Two jobs arriving
  together - the merchant's Retry beside the re-check sweep's re-drive, or a
  pg-boss retry racing either - both read `failed`, both proceeded, and both
  called `put_document` with the same count_code. Section 3 (Finding C,
  verified): that creates two ERP documents. The stale-pending takeover had
  the same shape.
- **Why it matters:** The duplicate guard is the *only* thing preventing
  duplicate ERP sales orders, and it had a hole exactly on the retry path
  where duplicates are most likely.
- **Spec:** CLAUDE.md section 8.4; run prompt Pass 1 ("relies on the
  constraint, not on a prior SELECT").
- **Status:** fixed - the re-claim is now a conditional `updateMany` flipping
  `failed` back to `pending` (the loser sees count 0 and walks away), and the
  stale-pending takeover is the same conditional update with the lease in the
  WHERE clause, which also renews the lease for third arrivals. Alongside it,
  `isDefinitiveRejection` was tightened to the observed validation codes
  {2, 6, 8}: an unrecognised opr_code no longer licenses a blind re-send and
  routes through the buyer_order lookup instead.
- **Verified by:** `vitest run` (recovery tests extended: unknown code "1" is
  not definitive); `tsc`, `eslint` green. True concurrent-writer assertion
  needs the Postgres harness (T-04).

### [P1] Every orders/edited webhook resolved to "unknown order" and was dropped
- **Where:** `src/jobs/handlers/orders-event.ts` (identitySchema)
- **What:** The identity schema read only top-level `id`/`order_id`, but the
  orders/edited payload is an order *edit* - `{ order_edit: { id, order_id,
  ... } }` - whose own `id` is the id of the edit. Every edit therefore matched
  no order and was logged as "Event for unknown order". Section 8.8's whole
  edit pipeline was reachable only through the reconciler's updated_at sweep -
  which the schedule-collision P0 meant never ran either. In production, edits
  were simply invisible.
- **Why it matters:** A merchant edits a line from 1 to 2, MetaKocka keeps
  shipping 1, and nothing anywhere says so.
- **Spec:** CLAUDE.md section 8.8. Spec right, code wrong.
- **Status:** fixed - `orderIdOfEvent` reads `order_edit.order_id` first
  (the edit envelope outranks the top level, where `id` means the edit).
- **Verified by:** new tests in tests/unit/orders-event-identity.test.ts
  covering the edit envelope, refunds, deletes and junk; suite green.

### [P1] A split order turned "written" when its first document landed
- **Where:** `src/jobs/handlers/write-metakocka-order.ts` (two sites),
  now `markOrderWrittenIfComplete` in the order repository
- **What:** Completion was measured as "no document row is unwritten", but a
  sibling write job that died before claiming its row never created one - so
  a 5/3 split whose second job was lost counted zero unwritten rows and marked
  the order written after the first document. Half the goods were never
  ordered from the ERP and every screen said done.
- **Why it matters:** The demo scenario of M4 (an 8-unit order split 5/3) is
  exactly the shape that breaks; the missing half is silent, which is the
  worst kind of missing.
- **Spec:** CLAUDE.md sections 8.2/8.4 imply per-source documents; the
  completeness claim is about the allocation, so it is now measured against
  the allocation: written only when every allocated source holds a written
  document.
- **Status:** fixed in both the create-success and recovery-adoption paths.
- **Verified by:** `tsc`, `eslint`, `vitest run` green. A DB-backed
  two-source assertion belongs to the T-04 harness.

### [P1] Settle-phase payments were dated from the order, not the payment
- **Where:** `src/jobs/handlers/mark-metakocka-paid.ts`,
  `src/jobs/handlers/sync-order-state.ts` (settle enqueue)
- **What:** `mark_paid.date` was `order.receivedAt` - the day the order
  arrived. This job exists precisely for payments that arrive *later* (bank
  transfer, COD), so a COD order collected Friday was booked in the ERP under
  Monday's date, with a comment claiming the opposite ("a payment belongs to
  the day the money moved").
- **Why it matters:** Wrong ledger dates on real payments; VAT periods can
  straddle the gap at month end.
- **Spec:** CLAUDE.md section 8.7: "Mark paid, dated from the Shopify
  transaction."
- **Status:** fixed - the sync that sees the status flip passes Shopify's
  `updated_at` into the job (`paidAt`); retries without one fall back to the
  order's last Shopify change, then the clock. `receivedAt` is no longer used
  for settle-phase dating. (The create path keeps `receivedAt`: an order that
  arrives already paid was paid when it arrived.)
- **Verified by:** `tsc`, `eslint`, `vitest run` green; the date conversion
  itself (`toPaymentDate`, ERP timezone) was already tested.

### [P1] customers/data_request answered "recordsHeld: 0" while holding the records
- **Where:** `src/jobs/handlers/customers-data-request.ts`
- **What:** Another M1 stub: the audit event always recorded `recordsHeld: 0`.
  An operator answering a GDPR access request read a false inventory from the
  app's own audit trail.
- **Spec:** CLAUDE.md section 2.4.
- **Status:** fixed - the event now records which requested orders are held,
  how many ERP request bodies sit beside them, how many carry hand-typed
  customer details, and how many are already redacted. Order ids only, never
  the person, because the event log outlives the payloads.
- **Verified by:** `tsc`, `eslint`, `vitest run` green; DB assertion needs
  T-04.

### [P1] The re-check auto-closed divergence exceptions its raisers never armed
- **Where:** `src/jobs/handlers/recheck-exceptions.ts` (order_diverged verdict)
- **What:** The verdict closed `order_diverged` whenever `order.divergedAt` was
  null - but three raisers never set `divergedAt` (the orphaned-document case
  in allocate-order and mark-metakocka-paid, and the update-blocked/refused
  cases in write-metakocka-order). Their exceptions were auto-closed on the
  next quarter-hour sweep with the note "The order matches what MetaKocka
  holds again", which was false: a stale, possibly paid ERP document still
  stood, and the person told to fix it watched the instruction vanish.
- **Why it matters:** Section 11's own rule - "leave it: the safe direction to
  be wrong in" - inverted for exactly the cases whose remedy is human work in
  the ERP this app cannot observe.
- **Spec:** CLAUDE.md section 11.
- **Status:** fixed - those cases already mark the document (`mkStatus` of
  "no longer allocated", "behind Shopify", "update refused"), so the verdict
  now stays open while any such marker stands. Markers are cleared by the
  successful update path, and "Mark as sorted in MetaKocka" remains the human
  override.
- **Verified by:** `tsc`, `eslint`, `vitest run` green; verdict logic read
  against every order_diverged raiser and against the accept-shopify action.

### [P2] The reconciler advanced its watermark past orders that failed to apply
- **Where:** `src/jobs/handlers/reconcile-orders.ts`
- **What:** A per-order failure was logged and skipped, and the watermark then
  advanced to the run's start time - so the failed order's change was never
  read again unless something else touched it. The comment beside the catch
  claimed "whatever is wrong with that order is still wrong next time", which
  was true of the order and false of the sweep.
- **Spec:** CLAUDE.md section 8.10 ("the watermark only advances over work
  that was actually done" is the stated design).
- **Status:** fixed - the watermark is clamped just below the earliest failed
  order's `updated_at` (never below the window start), failures are counted in
  the audit event, and each failure reaches Sentry. A permanently failing
  order now costs re-reads instead of silence.

### [P2] The background re-check could quietly revert a hand-made allocation
- **Where:** `src/adapters/queue/redrive.server.ts`, recheck-exceptions caller
- **What:** `redriveOrder("allocate")` cleared `allocation_locked_at`
  unconditionally, on the theory that whoever asks for allocation is a person
  changing their mind. The fifteen-minute re-check also asks, and it is not a
  person: an `insufficient_stock` exception whose stock arrived would have its
  hand-picked sources silently re-decided.
- **Spec:** CLAUDE.md section 11 ("a hand-made allocation is locked so the
  next stock sync does not silently revert it") - the lock existed, the
  re-check walked around it.
- **Status:** fixed - `redriveOrder` takes an actor; the re-check passes
  `background` and is refused with a reason, people keep the override.

### [P2] Two write jobs racing an unresolved partner could both create the customer
- **Where:** `src/jobs/resolve-order-partner.ts`
- **What:** Allocation resolves the partner while one job owns the order, but
  the per-source write jobs also call `ensureOrderPartner` as a fallback after
  a blip. Two of a split order's jobs arriving together both read
  `metakockaPartnerMkId: null`, both searched MetaKocka, both found nothing,
  and both called `add_partner` - the duplicated "Grega Rotar" that section 3
  records verbatim.
- **Spec:** CLAUDE.md section 3 (inline/duplicate partner creation is what
  resolution exists to prevent).
- **Status:** fixed - resolution is single-flight behind a conditional-update
  claim (`metakocka_partner_claimed_at`, additive migration
  20260826020000_partner_claim), the same pattern as the payment mark. The
  loser re-reads; a finished resolution is an answer, a running one throws and
  lets the pg-boss retry find the stored id. The claim is released on failure
  so a retry does not wait out the lease.
- **Verified by:** prisma validate, `tsc`, `eslint`, `vitest run` green;
  concurrent assertion belongs to T-04.

### [P2] Shopify-to-MetaKocka stock wrote the whole warehouse every five minutes, changed or not
- **Where:** `src/jobs/handlers/sync-inventory.ts` (pushShopifyStockIntoMetakocka)
- **What:** The reverse direction called `sync_stock` unconditionally on the
  five-minute tick. Section 7 is explicit that writing stock files an inventory
  document in the merchant's ERP - an accounting action - so a quiet store
  still accumulated 288 stock documents a day per warehouse. (In practice the
  schedule-collision P0 masked this; fixing that would have unmasked this.)
- **Spec:** CLAUDE.md section 7 ("write only on change" - stated for the other
  direction and binding harder here).
- **Status:** fixed - the write is skipped when every managed code already
  matches MetaKocka's held amount (absence meaning zero, which the fully
  paginated read makes safe). Unmanaged products are echoes by construction
  and cannot differ.
- **Verified by:** `tsc`, `eslint`, sync-stock unit tests green.

---

## Findings — second pass (26 August 2026)

Worked from `docs/agent/NOT_DONE.md`, batches 1-4. Same rules: no live
MetaKocka company, fixtures only, `tsc` + `eslint` + `vitest` green on every
commit. Baseline 437 tests; 474 at the end of this pass.

### [P1] Every amount was the shop's, every currency label was the customer's
- **Where:** `src/adapters/shopify/order-payload.ts`
- **What:** `parseOrder` set `currency` from `presentment_currency` and then
  read `totalMinor`, `discountMinor`, `totalTaxMinor` and each line's price
  from the plain REST fields, which are the **shop** currency. On any
  multi-currency store the label and the number disagreed by the exchange rate,
  and every MetaKocka document was priced wrongly - internally consistent,
  perfectly plausible, and undetectable downstream.
- **Spec:** CLAUDE.md section 8.6 ("use the Shopify presentment currency and
  amount... never silently convert to shop currency").
- **Status:** fixed - the `*_set` fields are preferred for the total, the
  discount, the tax, the shipping and both line amounts, falling back to the
  flat field a single-currency payload carries. The reconciler's GraphQL mapper
  already resolved presentment, so both paths now agree.
- **Verified by:** a multi-currency unit test asserting the presentment amount
  is stored under the presentment code, plus a fallback test; suite green.

### [P1] Protecting an unmanaged stock value was the write that changed it
- **Where:** `src/adapters/metakocka/sync-stock.ts` (`buildCompleteStockList`)
- **What:** `sync_stock` removes anything omitted from `stock_list`, so
  products this app does not manage are echoed back at MetaKocka's own value.
  The echo branch applied the managed branch's `Math.max(0, Math.trunc())`, so
  a held 3.5 was restated as 3 and a held -2 as 0 - the destructive write the
  echo exists to prevent, performed by the echo.
- **Spec:** CLAUDE.md section 7 ("products this app does not manage are sent
  back at the value MetaKocka already holds").
- **Status:** fixed - the echo is verbatim and the clamp belongs to the managed
  branch alone. `managedAmount` is exported so the caller deciding whether
  anything changed compares the value that would actually be sent: an oversold
  Shopify location reporting -1 against a held 0 was a permanent "change", and
  filed an inventory document in the merchant's ERP every five minutes.
- **Verified by:** fraction and negative echo tests, plus a request-body test
  proving the number survives serialisation.

### [P1] A negative sales order would have been filed without complaint
- **Where:** `src/domain/money/split.ts`, `src/jobs/handlers/write-metakocka-order.ts`
- **What:** Section 8.6 puts the order-level discount on the primary document
  alone. On a split order whose discount exceeds the primary's own lines, that
  produces a document worth less than nothing beside a positive one. MetaKocka
  validates almost nothing (section 3) and would accept it; the pair still sums
  to the Shopify total, so no reconciliation check would notice either.
- **Spec:** CLAUDE.md sections 8.6 and 11.
- **Status:** fixed - `negativeShares` is pure and the writer refuses: an
  exception naming each document and its amount, nothing sent. No arithmetic
  rescues this case - spreading the discount is forbidden and moving it only
  moves the negative - so a person decides.

### [P1] recordExceptionAttempt was not shop-scoped
- **Where:** `src/adapters/queue/redrive.server.ts`
- **What:** `updateMany({ where: { id } })` with no tenant filter. Any
  authenticated shop could increment the attempt count on another shop's
  exception by guessing an id, writing into another tenant's audit trail.
- **Spec:** CLAUDE.md section 9 ("every query filters by shop_id, enforced in
  the repository layer so route code cannot forget").
- **Status:** fixed - it takes the `Principal` its callers already hold.

### [P1] A hand-made allocation could name another shop's supply source
- **Where:** `src/adapters/db/repositories/order.server.ts` (`setManualAllocations`)
- **What:** The order and its lines were scoped; `supplySourceId` came straight
  off the form and was written unchecked. Only a forged post reaches it, and
  what it bought was real: the order page joins the allocation to its source to
  render the name, and the document writer reads that source's warehouse and
  profit centre.
- **Spec:** CLAUDE.md section 9.
- **Status:** fixed - ownership is verified inside the transaction, with its
  own error type so the route answers instead of returning a 500.

### [P1] A truncated order read as an edited one
- **Where:** `src/adapters/shopify/orders.ts`, `src/jobs/handlers/reconcile-orders.ts`
- **What:** The reconciler read `lineItems(first: 100)` with no pagination, and
  `syncOrderState` compares the payload against the stored order line by line.
  Every line past the first page therefore read as **removed**: an untouched
  B2B order would be rewritten without them, allocated again, and its MetaKocka
  document reported as diverged.
- **Spec:** CLAUDE.md sections 8.8 and 8.10.
- **Status:** fixed - an order that reports more lines gets a follow-up read of
  its own, bounded at twenty-five pages. Past that it is skipped whole rather
  than applied in part, the watermark is held behind it, and Sentry hears about
  it. One query for one over-long order is not a query in a loop (section 2.5);
  asking for every order's lines separately would be.

### [P2] Webhooks were registered against one Admin API version and read with another
- **Where:** `shopify.app.toml`, `src/adapters/shopify/shopify.server.ts`
- **What:** The toml said `2026-10`, a version the installed SDK does not have.
  The client speaks `2026-07`, which is what every fixture and every section 7
  verification was captured against.
- **Spec:** CLAUDE.md section 2.1.5.
- **Status:** fixed - the toml is corrected and
  `tests/unit/api-version.test.ts` fails if the two drift again, since the toml
  cannot import the constant.

### [P2] A staff account got a 500 for asking whether MetaKocka was connected
- **Where:** `app.products.sync`, `app.settings.payments`, `app.settings.supply-sources`
- **What:** Three loaders called `getCredential`, which throws
  `NotPermittedError` for anyone but the store owner, to answer a question that
  needs no key: is this shop connected. The throw is right; unhandled in a
  loader it is a broken page.
- **Spec:** CLAUDE.md sections 9 and 2.8.
- **Status:** fixed - `isConnected` for the loaders, `requireCredential` for
  the five actions that genuinely need the key. The latter separates "not
  permitted" from "not connected", because "connect MetaKocka first" is advice
  a staff member cannot act on.

### [P2] The MetaKocka webhook told a prober which shops exist
- **Where:** `src/web/routes/webhooks.metakocka.$shop.stock.tsx`
- **What:** "Not configured" and "Bad signature" were distinguishable 401s, so
  the URL space could be walked to learn which shops are installed here and
  which had finished configuring the webhook.
- **Status:** fixed - one body for both. The reason stays in our own log, where
  a support request can find it.

### [P2] sync_stock failures were unclassified, and success was believed on a count
- **Where:** `src/adapters/metakocka/sync-stock.ts`
- **What:** No HTTP status classification, so an error page's body was read as
  a result; `JSON.parse` of a non-JSON body escaped as a raw `SyntaxError`,
  which pg-boss retried as though it were transient. And the response check
  compared only the *number* of acknowledged lines, so a right-length list of
  the wrong products passed.
- **Spec:** CLAUDE.md sections 7 and 11.
- **Status:** fixed - `classifyHttpStatus` as in `client.ts`, a typed error for
  a body that is not JSON, and the echo checked by product code and amount. A
  field MetaKocka simply omits is "could not tell" rather than a mismatch: the
  alternative raises an exception on every successful write the moment
  MetaKocka trims its response, and a queue of false alarms is a queue nobody
  reads.

### [P2] The retention job deleted the decision trail it promises to keep
- **Where:** `src/jobs/handlers/redact-old-orders.ts`
- **What:** Every key called `name` was blanked wherever it appeared, taking
  `order.name` ("#1042"), every line item's product name and every MetaKocka
  `product_list` name with it. Those are the decision trail, not the customer,
  and the order screen and the diff both read them.
- **Spec:** CLAUDE.md section 2.4 ("the audit log survives; the personal data
  does not" - SKUs, quantities, sources, rule reasons, document ids).
- **Status:** fixed - redaction is aware of where a field sits. A name in the
  order itself or on a line is kept, a name anywhere else is blanked, and the
  containers that actually hold a person are still blanked whole.

### [P2] The shopper's browser and IP address were stored for ninety days
- **Where:** `src/adapters/db/repositories/order.server.ts`
- **What:** `raw_payload` is deliberately Shopify's whole record of the order,
  which correctly includes fields outside today's diff - but `client_details`
  (user agent, accept-language, session hash, IP) and `browser_ip` are read by
  nothing, sent to nothing, and are personal data under the Level 2 approval.
- **Spec:** CLAUDE.md section 2.4 ("do not store what we do not send").
- **Status:** fixed - dropped at the three places a payload is written, so no
  caller can forget. Orders stored before this are left as they were: the
  retention job already covers both keys, and rewriting history to look tidier
  would lose the record of what was actually received.

### [P2] A redacted order did not look redacted, and settling it returned a 500
- **Where:** `src/web/routes/app.orders.$orderId.tsx`
- **What:** The screen tested for an absent payload, but the retention job
  overwrites the personal fields in place and leaves the column there - so the
  banner explaining the missing customer details never appeared. The
  mark-sorted action then handed that payload to `parseOrder`, which throws on
  the string "[redacted]": a 500 on the one button that settles a divergence.
- **Status:** fixed - `redacted_at` is the fact, and the action uses
  `parseOrderSafe` with a message saying the order is too old to compare.

### [P3] Rounding was asymmetric across zero
- **Where:** `src/domain/money/tax.ts`
- **What:** `Math.round` breaks ties toward positive infinity, so the net of a
  refunded gross was not the negation of the net of that gross. Phase 2 maps
  refunds onto credit notes, where a cent of difference is a manual
  reconciliation for a person.
- **Status:** fixed - half-up away from zero, with the negative-zero case
  normalised so it cannot differ under `Object.is`.

### [P3] Two deterministic tie-breaks depended on the host's collation
- **Where:** `src/domain/allocation/allocate.ts`, `src/domain/money/split.ts`
- **What:** `localeCompare` decides by the runtime's collation rules, which
  vary with the Node build, the ICU data and the host locale. In `domain/` that
  chooses which source fills a line and which document carries the shipping
  charge, so two servers running the same code could disagree and a retry that
  landed on the other machine would move the money.
- **Status:** fixed - `compareCodepoints` in `domain/types`: arbitrary, but the
  same everywhere and forever. Display sorting still uses `localeCompare`.

### [P3] An inventory batch was checked for one location and written for several
- **Where:** `src/adapters/shopify/inventory.ts`
- **What:** The one-writer rule is enforced once against `options.locationId`
  while each item names its own, so a batch mixing locations would write every
  item on the strength of a check covering one - including a partner or manual
  location.
- **Spec:** CLAUDE.md section 7 ("enforce in the inventory adapter: it throws").
- **Status:** fixed - `writeOnHand` and `activateOnHand` both refuse such a
  batch before calling Shopify.

### [P3] One shop's failure silently ended the scheduled tick for every shop after it
- **Where:** `src/jobs/handlers/scheduled-tick.ts`
- **What:** The cron fan-out is a loop over tenants with no isolation. An
  unhandled throw halfway down took every shop below it, and did so identically
  on every subsequent tick.
- **Status:** fixed - per-shop try/catch, reported to the log and to Sentry and
  counted in the tick's own log line.

### [P3] The document poller ran four times as often as section 8.11 asks
- **Where:** `src/jobs/handlers/scheduled-tick.ts`, `src/jobs/worker.ts`
- **What:** `poll-metakocka-documents` sat on the quarter-hourly tick. Section
  8.11 says hourly, and every check is a round trip into a slow ERP for an
  answer that only changes when a person does something by hand.
- **Status:** fixed - its own hourly cadence, at seven minutes past so it does
  not land on the quarter-hourly fan-out.

### [P3] A queue with no producer, and a queue with no consumer
- **Where:** `src/adapters/queue/queues.ts`
- **What:** `orders-create` was registered and nothing sent to it or worked it.
  `write-shopify-fulfilment` is worse in kind: `allocate-order` sends to it and
  nothing works it, so every allocated order queues a job that will never run.
- **Status:** partly fixed - `orders-create` removed.
  `write-shopify-fulfilment` is a feature gap (section 8.3) rather than dead
  wiring, so the enqueue stays and the queue gains an explicit seven-day
  retention: an unconsumed job is archived instead of accumulating one row per
  allocated order for ever. The feature itself is T-08.

### Test coverage added
The section 12 integration test now starts from a **recorded webhook payload on
disk** (`tests/fixtures/shopify/orders_create_split.json`) and runs parse ->
allocate -> split -> two request bodies asserted field by field. What nothing
covered before was the seam between the parser's output and what the allocator
and the money split consume; that is exactly where the presentment-currency bug
lived.

### Not attempted in this pass
Everything under "Documented but unbuilt" in `docs/agent/NOT_DONE.md`, which is
now T-07 to T-13 in `docs/agent/TODO-HUMAN.md`, plus the spec disagreements
consolidated in `docs/agent/DRIFT.md`. None of it is a bug to fix quietly: each
is either a missing feature that changes what a merchant sees, or a place where
CLAUDE.md and the code disagree about what was decided.

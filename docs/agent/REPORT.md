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

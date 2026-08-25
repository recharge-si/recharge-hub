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

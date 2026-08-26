# NOT DONE — what is still outstanding

Rewritten 26 August 2026, at the end of the second hardening pass. The first
version of this file listed four batches of code fixes and a set of
deliverables; **batches 1 to 4 are all done** and are written up as findings in
`REPORT.md`. What follows is what is left, and why each piece is left.

Ground rules for whoever picks this up, unchanged:

- Never call a live MetaKocka company. Fixtures and `docs/metakocka-verification.md` only.
- Every commit passes `npx tsc --noEmit`, `npx eslint .`, and `npx vitest run`
  (474 tests green at the last commit of this pass).
- No `any`, no `as` across a boundary, no invented MetaKocka/Shopify field names.
- Additive migrations only. Branch: `agent/overnight-hardening`.

---

## Nothing here is a quiet fix

Everything remaining falls into one of three shapes, and none of them is
"a bug somebody can just correct":

1. **Features CLAUDE.md describes and the code does not have** — §8.3
   fulfilment orders, §8.5 tracking sync, §8.9's MetaKocka-to-Shopify
   direction, §8.10's nightly cross-checks. Each changes what a merchant sees.
   They are `TODO-HUMAN.md` T-08 to T-11.
2. **Decisions with real trade-offs** — which access scopes to ship (T-07),
   how partner matching should behave when only a name matches (T-12), how PII
   in jsonb should be encrypted without breaking `customers/redact` (T-13).
3. **Places CLAUDE.md and the code disagree** about what was decided. All nine
   are in `DRIFT.md`, each with which of the two should move.

---

## Deliverables still not produced

### MAP.md
A subsystem map was never written. The session scratchpad it was to be
synthesised from (`inventory-*.md`) is gone. Regenerating it means reading each
subsystem, which is a day's work and mostly duplicates what the file-level
doc comments already say — several of them are essay-length and current.

**Suggestion before doing it:** decide what a map would be *for*. If it is
onboarding, `CLAUDE.md` §5 plus the doc comments may already be it.

### UX.md (Pass 3)
Never written. The observations it was to be built from are recorded here so
they are not lost, but none has been re-verified in this pass and all of them
need a browser:

- 375 px grid overflow (obs 38). §2.6 requires no horizontal scroll at 375 px.
- The exceptions list truncates with no "show more" (obs 39).
- Save-bar violations (obs 94). §2.6 makes a bespoke Save button in a card a
  rejection criterion.
- A missing back button / breadcrumb on a sub-page (obs 90). §2.6 requires one
  on every sub-page.
- Hydration mismatches (obs 88). §2.5 counts these against CLS.
- Screen-reader table semantics (obs 89). §2.6 requires WCAG 2.1 AA.

**Next action:** run the app, walk each screen at 375 px and at desktop width
with the accessibility inspector open, and write the findings up with a
screenshot each. This is the one remaining pass that genuinely cannot be done
by reading code.

### Pass 2 — the BFS checklist, requirement by requirement
§2 is a list of literal rejection criteria and nobody has walked it end to end.
The fixes in both passes touched several of them incidentally (§2.4 retention
and minimisation, §2.8 error copy, §2.1 API version), which is not the same as
having checked all of them.

**Next action:** take §2.1 through §2.8 in order, and for each numbered
requirement record met / not met / not applicable with the file that settles
it. Expect the answer to be "met" most of the time; the value is in the few
that are not, and in having the list to hand at submission.

### Pass 4 — performance against §2.5's budgets
Two candidates were identified and neither has been measured:

- `load-pricelists` runs inline in a route action with a 60-second client
  timeout (`app.products.sync`). It is a merchant-pressed button rather than a
  page load, so it does not violate §2.5 as written — but a button that can
  take a minute with no progress indication is its own problem.
- The products and product-sync loaders await live Shopify GraphQL
  (`listVariantDetails`, `countVariants`, `listMetafieldDefinitions`) before
  first paint. §2.5's hard rule is about MetaKocka, and these are Shopify calls,
  but LCP ≤ 2.5 s at p75 is measured on the whole thing.

**Next action:** measure before changing anything. §2.5's budgets are numbers,
and none of them has been observed on this app.

### Pass 5 — the test matrix
Mostly done rather than not done. `tests/unit/allocate.test.ts` covers every
case §12 names except one that cannot exist (`DRIFT.md` D-1);
`tests/unit/money-split.test.ts` covers the summing requirement including
three-way splits and odd cents; `tests/integration/order-to-metakocka.test.ts`
is §12's slice test, now driven from a recorded webhook payload.

What is genuinely missing is the database-backed harness — `claimDocument`, the
transactional enqueue and the concurrent-write behaviour can only be asserted
against Postgres. That is `TODO-HUMAN.md` T-04, and it is the highest-value
test work left in the repository: the duplicate guard is the only thing
standing between a timeout and a second sales order in the merchant's ERP
(§8.4), and nothing proves it holds under concurrency.

Coverage is still unmeasured (`DECISIONS.md` D-02, `TODO-HUMAN.md` T-01).

---

## Where the record lives

- `REPORT.md` — every finding from both passes, with where, what, which spec
  section, and what was done about it.
- `TODO-HUMAN.md` — T-01 to T-14, each with the exact next action.
- `DRIFT.md` — the nine places CLAUDE.md and the code disagree.
- `DECISIONS.md` — decisions taken without asking, and how to reverse them.

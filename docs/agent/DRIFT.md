# Where CLAUDE.md and the code disagree

CLAUDE.md is the source of truth, and it says so: "Where this file is wrong or
stale, say so rather than working around it." This is that saying-so.

Each entry names the section, what the code actually does, and which of the two
should move. Nothing here was silently reconciled in either direction — a spec
change is a decision, and so is a code change that makes the spec true.

Written 26 August 2026, from the second hardening pass. Findings that were
plain bugs are in `REPORT.md`; work that is missing rather than wrong is in
`TODO-HUMAN.md`.

---

## D-1 — §12 asks for an allocation test that cannot exist

> `domain/allocation` needs exhaustive unit tests: zero stock, exact stock,
> partial stock, split disabled, **source below minimum**, same SKU on two
> lines, zero quantity, source disabled mid-order, priority ties.

Every case on that list is covered in `tests/unit/allocate.test.ts` except
**source below minimum**, and it is not covered because there is no minimum in
the model. `SupplyLevel` carries `available`, `kind`, `priority`, `canSplit`
and `enabled`, and nothing else. MetaKocka has `minimal_order_quantity` on a
product (§3), which is presumably what the requirement had in mind, but it is
neither read nor stored anywhere in this app.

**Which should move:** the code, if a partner really does refuse orders below a
quantity — that is a real thing partners do, and `canSplit` is already the
shape it would take. Otherwise the line should come out of §12, because a test
list that names something unbuildable makes the whole list read as aspirational.

"Source disabled **mid-order**" is a related but smaller mismatch: `allocate`
is pure and takes one snapshot of supply, so a source cannot change state
during a run. The covering test is "a disabled source is skipped entirely",
which is the only version of that case the design permits.

## D-2 — §7 expects an `inventory_levels/update` subscription that does not exist

> **Loop prevention:** we receive `inventory_levels/update` for our own writes
> — compare against the last value written and drop matching events.

The webhook is not subscribed in `shopify.app.toml` and there is no handler.
The loop is prevented a different and better way: the app writes only on change
(`sync-inventory`), so it never produces the event it would have had to filter.

**Which should move:** the spec. The current design is stronger — filtering
events is a race, not writing them is not — and the paragraph as written sends
the next reader looking for a subscription that should not be added. Note the
consequence that *is* real and should be stated instead: for a
`shopify_to_mk` warehouse the app learns of a Shopify stock change on the
five-minute cycle rather than immediately.

## D-3 — §2.1 says GraphQL Admin API "latest stable version"; the SDK's latest is 2026-07

`shopify.app.toml` had drifted to `2026-10`, a version the installed
`@shopify/shopify-api` (13.1.0) does not define. Corrected to `2026-07` and
pinned by a test. This is not a spec disagreement so much as a warning: "latest
stable" is a moving instruction, and each quarterly bump has to be taken
deliberately, with the §7 write-shape verification redone against it — the
`changeFromQuantity` / `@idempotent` findings in §7 are version-specific and
were established on 2026-07.

**Which should move:** neither, but §2.1 would be more useful as "latest stable
version the pinned SDK supports, bumped as a deliberate change with §7
re-verified".

## D-4 — §8.9's MetaKocka-to-Shopify direction is a table with no code behind it

The field ownership table gives MetaKocka mastery of SKU, price, tax, weight,
dimensions and barcode, flowing MK → Shopify. No Shopify product mutation
exists anywhere in the codebase; the only mutations are the two inventory ones.

**Which should move:** to be decided (T-09). Either the direction is built or
the table gets a "phase 2" marker on those rows. As it stands the table
describes an app that has never existed, and `write_products` is requested on
its strength (T-07).

## D-5 — §8.5's tracking sync is specified against a field §3 verified does not exist

§8.5 says a scheduled job polls MetaKocka `search` for changed sales orders and
extracts tracking codes. §3 then records, from a live probe: "**There is no
status field of any kind on a sales order, and no tracking field.** So there is
no ERP workflow state to poll for, and §8.5's tracking sync will have to find
its codes somewhere else."

The two paragraphs already disagree with each other, and §3 is the one with the
evidence. Nothing is built.

**Which should move:** §8.5, once somebody has found where MetaKocka actually
keeps a tracking code (T-10). Until then it should say that it is blocked on
that question rather than describing a job that cannot be written.

## D-6 — §9's repository rule is a convention, not an enforcement

> Every query filters by `shop_id`, enforced in the repository layer so route
> code cannot forget.

67 direct `prisma.*` calls live in `src/jobs` and `src/web`. The rule is real
and mostly followed; nothing enforces it.

§5's import-direction rule, by contrast, **is** enforced — `eslint.config.js`
carries the full `import/no-restricted-paths` zone list. So the machinery is
already there, and the missing half is one more zone: forbidding
`~/adapters/db/client.server` outside `adapters/db` would make §9's boundary as
real as §5's, without touching a query.

That rule cannot be added today, because 67 call sites would fail it at once.
It is the finishing move for T-14 rather than a starting one.

## D-7 — §2.4's encryption at rest is not implemented for jsonb PII

> **Encryption at rest** for customer PII.

Secrets are encrypted (AES-256-GCM, `adapters/crypto/secrets.server`).
Customer names, addresses, emails and phone numbers sit in plaintext jsonb in
`order.raw_payload` and `metakocka_document.request_body`.

**Which should move:** to be decided (T-13). It may be that disk-level or
Postgres-level encryption satisfies the reviewer, in which case §2.4 should say
so explicitly rather than implying column-level encryption that the
`customers/redact` jsonb path matcher would break.

## D-8 — §8.10's nightly cross-checks are listed but mostly absent

Of the four nightly checks §8.10 names, none is implemented (T-11). What exists
is the fifteen-minute order reconciliation, the five-minute stock cycle, the
exception re-check and — as of this pass — the hourly document poll §8.11 asks
for.

**Which should move:** the code. These are the checks that would have caught
several of the bugs found in the last two passes, including a document total
that no longer matched its order.

## D-9 — §2.7's home page cannot show a reconciliation that does not run

> It shows: setup state, whether syncing is working, and real metrics... last
> stock reconciliation and its result.

The home page shows orders received, allocated and awaiting attention, the last
MetaKocka write, the last stock event, when orders were last read back from
Shopify, and open exceptions by kind. What is missing is the *result* half:
§8.10's nightly cross-checks produce the findings a merchant would want on that
page, and none of them runs (D-8).

**Which should move:** the code, with D-8. The page is already the right shape;
it has nothing to put in that row.

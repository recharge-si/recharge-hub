# PRD 1: API contracts that provably agree, and the first live pass

## 1. Introduction

Recharge data crosses four boundaries: partner feed → integration API → portal API → Recharge Hub → Shopify. A static audit on 2026-10-28 found the Sources API and the vendored feed schema consistent, but also four real risks and a set of stale docs, and the whole chain has never run live (T-27). This PRD closes the risks, makes drift fail CI instead of production, and defines the first live pass.

Repos touched: `t4a-partner-portal-api` (contract owner), `recharge-partners-integration-api`, `recharge-hub`. Branch name in each: `recharge-api-contracts`. Merge order: portal, then integration API, then hub. Merging to `main` in the portal and integration API **deploys**, so each is a production change reviewed by Grega.

## 2. Goals

- No reply the portal can send makes a hub screen say "answered in a form this app does not understand".
- A feed that passes the integration API's validation is never refused by the portal's validator for a rule the integration API does not know.
- A schema or contract change that is not mirrored fails a CI job in the repo that forgot.
- Every env var each service reads is documented next to the service.
- One live pass against the real store, with evidence recorded in `docs/project-status.md`.

## 3. User stories

### US-101: Run the suites that have never run here
**Description:** As a maintainer I need a known-good baseline in the two repos that have no `node_modules` on this machine.

**Acceptance criteria**
- [adapter] In `t4a-partner-portal-api`, `npm ci && npm test` exits 0 with zero network access (run with the network namespace blocked or `--network none` in Docker). Record pass/fail counts.
- [adapter] In `recharge-partners-integration-api`, `npm ci && npm run typecheck && npm run lint && npm test && npm run build` exits 0.
- [adapter] In `recharge-hub`, `npm run build` and `npm run test:e2e` exit 0 (typecheck, lint, vitest are already green: 1359 passed, 94 skipped).
- Any failure found is listed in the PR description with its output, not fixed silently.

**Verification:** command output pasted in the PR. Regression risk: none (no code change).

### US-102: Portal never emits a run the hub cannot read
**Description:** As a merchant I never see "answered in a form this app does not understand" because of an empty id or a relative URL.

**Acceptance criteria**
- [adapter] Portal `getRun` for a run whose scope no longer resolves returns a run with `sourceId` equal to the run's stored scope id, or the request returns 404. It never returns `sourceId: ""`. Test: stub a job document whose `scopeIds` points at a deleted scope; assert `sourceId.length > 0` or status 404.
- [adapter] With `SHOPIFY_PORTAL_RETURN_URL` unset or `"/"`, `GET /api/v1/sources/:id` returns `portalUrl` as `undefined` (omitted). With it set to `https://portal.example/shopify`, `portalUrl` starts with `https://`. Test both.
- [unit] Hub `sourceSchema.parse` accepts the portal's reply in both cases (use the portal's smoke-test reply as the fixture, copied to `tests/fixtures/export-portal/`).
- [unit] Hub `contract.ts` still rejects `portalUrl: "/shopify"` (the schema stays strict; the portal is the one that is fixed).

**Verification:** new tests in `t4a-partner-portal-api/test/sourcesApi.test.js`, `recharge-hub/tests/unit/export-portal-contract.test.ts`. Regression risk: Sources list/detail pages.

### US-103: Feed image URLs: one rule on both sides
**Description:** As a partner-feed owner I want the integration API to refuse what the portal would refuse.

**Acceptance criteria**
- [unit] `validateFeed` in the integration API fails a product with `images[0].url = "http://cdn.example/a.jpg"` with an issue whose path points at that image and whose message contains `https`.
- [unit] `validateFeed` fails the same for a variant image. A feed with only `https://` URLs passes.
- [adapter] Portal `feedValidator` rejects the same two inputs (already true); add the test if missing so the rule is pinned in both repos.
- [unit] `npm run check:schema` still passes, i.e. the https rule is added in `schema.ts` (Zod refine), not by editing the vendored JSON.

**Verification:** `recharge-partners-integration-api/src/lib/feed/*.test.ts`. Regression risk: POINT-7 and Unifiber builders, which must still produce `https` URLs. Run `npm run pull` for each in a sandbox with recorded input (no live partner call).

### US-104: The schema drift guard cannot pass by accident
**Description:** As a reviewer I need `check:schema` to fail when it did not actually compare.

**Acceptance criteria**
- [unit] `scripts/check-schema.mjs` exits non-zero when the portal URL answers 404, when the request times out, and when the body is not JSON. Test with a local HTTP server stub returning each.
- [unit] It exits 0 only when the two schema documents are byte-identical after JSON normalisation, and exits non-zero (naming the first differing path) when one property differs.
- [unit] Without `PORTAL_SCHEMA_URL` the script prints the default URL it uses and says so. The variable is documented in `CLAUDE.md` Env var names.
- The CI workflow fails if the job is skipped (`needs` + `if: always()` pattern checked in the workflow file).

### US-105: Category-tree size is checked before the portal says no
**Description:** As a merchant with a large product-type tree I get a clear message, not a 422 on every autofill batch.

**Acceptance criteria**
- [unit] Hub autofill with 2001 assignable types does not call the portal and records `failed` on each product with the text `The product type list has 2001 entries; the AI can read at most 2000.`
- [unit] With exactly 2000 types the portal is called (stubbed) with 2000 categories.
- [adapter] Same boundary for attributes: 201 attributes → no call and a named message; 200 → called.

**Verification:** `tests/unit/product-autofill*.test.ts`. Regression risk: existing autofill tests.

### US-106: Docs say what the code does
**Description:** As the next agent I do not get misled by stale docs.

**Acceptance criteria**
- [unit] A docs test in the hub (pattern of `tests/unit/api-version.test.ts`) asserts that every key of `fieldSchema` in `contract.ts` appears in the "Shapes" block of `docs/sources.md` (this catches the current miss: `tokens`, `sample`).
- `docs/project-status.md` T-27 "Review before publish" paragraph no longer says the portal side is not built (it is, per `docs/sources.md` and the portal's `sources-api.md`).
- The portal gets a `docs/env.md` (or a section in `docs/deployment.md`) listing `SHOPIFY_PORTAL_RETURN_URL`, `SHOPIFY_PORTAL_WELCOME_URL`, `SHOPIFY_PORTAL_PRERELEASE_RETURN_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, `SHOPIFY_STATE_SECRET`, `SHOPIFY_TOKEN_ENC_KEY`, `SHOPIFY_API_BASE_URL`, `SHOPIFY_API_VERSION`, `APP_NAME`, each with required/optional and what breaks without it. Check: a script greps `process.env.X` in `src/` and fails if any name is missing from the doc (add as a node:test).
- The integration API has a real `.env.example` (README already tells people to copy it). Test: file exists and contains every name `src/env.ts` reads.
- Portal's default `SHOPIFY_API_VERSION` (`2026-04`) vs hub's `2026-07` is stated in the doc as intentional or aligned; one of the two is changed if it is not intentional (Open question).

### US-107: Shared contract fixtures
**Description:** As a maintainer I want one recorded set of Sources API replies that both repos test against, so "both sides pass" means "they agree".

**Acceptance criteria**
- [adapter] The portal's `scripts/sources-api-smoke.js` writes its replies to `docs/fixtures/sources-api/*.json` when run with `--record` (no secrets, ids anonymised).
- [unit] Hub test loads each fixture and asserts `schema.parse` succeeds; a fixture with an added unknown required field in a copy fails (proves the test bites).
- Fixtures cover: `connection`, `source-types`, `sources` (one per `health` value: ok, needs_attention, never_ran, off), `source` with a `tokens` field, `runs` (running, completed, failed), `ai/categorize`, `ai/extract-attributes`, and one error body per status 401, 403, 404, 409, 422, 502, 503.
- Copy to the hub is manual and checked by a `sha256` line in a `fixtures/README` (same pattern as `own-source.v1.json`).

### US-108: First live pass (T-27)
**Description:** As Grega I want evidence that the chain works on the real store before anything is built on it.

**Acceptance criteria** (manual, run by a person with credentials; the agent prepares the checklist and records results)
- [browser] Portal API deployed with `/api/v1` and the two `/ai/*` routes: `GET <portal>/api/v1/connection` with the minted key and `X-Shop-Domain: <store>.myshopify.com` returns 200 and the tenant name; with a key for a different shop returns 403.
- [browser] `/app/sources/connection` in the hub, key pasted: page shows the tenant name and "verified".
- [browser] `/app/sources` lists the real sources; counts equal the portal's own admin page (record both numbers).
- [browser] One source set to *Run now*: a run appears with status `running` then `completed`; `itemCount` equals the portal's own count; the log lines are readable.
- [browser] One product autofilled: the suggestion's type is one of the plan's assignable types, every suggested value passes `suggestedValues` (spot-check three by hand against the product page).
- Results (pass/fail, counts, screenshots) go into `docs/project-status.md` T-27 and the stale "not yet run" text is removed.

**Regression risk:** this is the only story that writes to the live store. It needs explicit human approval before running and a source with a small scope (a single test product).

## 4. Functional requirements

- FR-1: Portal replies must satisfy hub `contract.ts` for every status and health value (US-102, US-107).
- FR-2: Image URLs must be `https` in the integration API's validator (US-103).
- FR-3: `check:schema` must fail on any failure to compare (US-104).
- FR-4: Autofill must refuse to call the portal over its documented limits and say so (US-105).
- FR-5: Every env var read in `src/` is documented (US-106).
- FR-6: Hub and portal share recorded fixtures with a checksum (US-107).

## 5. Non-goals

- No new endpoints and no version bump of `/api/v1`.
- No change to which repo owns which contract.
- No retries added to the hub client (documented design: a person is waiting on a button).
- No hub-side change that loosens `contract.ts` to hide a portal bug.

## 6. Design considerations

None; no UI change. Prototype: not applicable.

## 7. Technical considerations

- Contract-first order. The portal PR changes responses; the hub PR only adds fixtures and tests.
- `recharge-hub/docs/sources.md` is the hub's description of the contract; the portal's `sources-api.md` is the other half. When they disagree about the wire format, the portal's smoke test wins (both docs say so).
- Cosmetic findings left alone on purpose: the portal never emits `queued`/`cancelled` run statuses (hub accepts them, harmless); the hub maps 429 although the portal never sends it; `downloadUrl` and `createdAt` are always null (optional on the hub). Note them in `docs/sources.md` Known limits.

## 8. Success metrics

- Zero "answered in a form this app does not understand" events in Sentry in the 14 days after the live pass.
- `check:schema` and the shared fixtures catch a deliberately introduced drift in a throwaway branch (done once, recorded in the PR).

## 9. Open questions

- Should the portal's default Shopify API version (`2026-04`) move to the hub's `2026-07`? The portal is a separate install; mismatch is not a bug per se.
- Does the portal's health rule `needs_attention` match what the hub's header counts? Needs a look at real run history during US-108.
- Who mints the production key and where is it stored? (Not in this repo.)

## 10. Verification checklist

### Per-change coverage

**C1: portal `sourceId`/`portalUrl` fixes**
- [ ] Backend: unit tests above pass in the portal.
- [ ] Round-trip: hub parses the portal's real smoke-test output.
- [ ] Edge cases: deleted scope; unset/relative return URL.
- [ ] Tenant scoping (`shop_id` / API key binding): a key for shop A cannot read shop B's run (403) — existing test must still pass.

**C2: https rule in feed validator**
- [ ] Validation: http image fails with path and message.
- [ ] Round-trip: POINT-7 and Unifiber recorded inputs still validate.
- [ ] Edge cases: `//cdn…` protocol-relative URL fails; empty string fails; uppercase `HTTPS://` (decide and pin).

**C3: check-schema hardening**
- [ ] Edge cases: 404, timeout, non-JSON, one-property diff, identical.

**C4: autofill limits**
- [ ] Edge cases: exactly at and one over each limit (2000 categories, 200 attributes).

**C5: shared fixtures**
- [ ] Hub parses each; mutated copy fails.

### Test data setup

- Fixtures are recorded files; no database seed needed.
- For US-108 use a store with one test product tagged for the source and a source scope that selects only it. Cleanup: delete the run's product changes afterwards or run against a staging copy of the store.

### Browser end-to-end

- [ ] US-108 steps driven in dev-browser with DOM assertions, zero console errors, network 2xx.
- [ ] Visual parity: N/A (no prototype).

### Suite gates

- [ ] Hub: `npm run typecheck && npm run lint && npx vitest run && npm run build && npm run test:e2e`.
- [ ] Integration API: `npm run typecheck && npm run lint && npm test && npm run check:schema && npm run build`.
- [ ] Portal: `npm test` (offline).
- [ ] Evidence is pasted output, not "looks good".

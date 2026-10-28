# PRD 2: Metafields go live (definitions, values, bulk filling through claude-pool)

## 1. Introduction

Product setup (nav item "Metafields") is a plan: types, attributes, sets, inheritance, and a Shopify field `key` per attribute. **Nothing is created in Shopify** (`docs/project-status.md` T-25, `docs/attributes.md` § Known limits). Values entered on a product's Attributes tab are written with `metafieldsSet`, but with no definition they are untyped metafields, invisible to Shopify's filters and storefront access rules, and the theme reads none of them. Autofill exists end to end but depends on the portal's Claude Haiku call and on a person reviewing each product.

This PRD makes the plan real in Shopify and makes the filling work scale: one page to create definitions with a preview, a rig-ready attribute starter, and a batch runner that uses the team's pooled Claude accounts (claude-pool) to fill the whole catalogue into the existing review queue.

Depends on PRD 1 only for the live pass (US-108 there). Can be built in parallel with PRD 3. Must land the `Metafields` → `Product setup` rename (PRD 3 US-301) first or at the same time.

## 2. Goals

- Every attribute with a Shopify field key can have a metafield definition created from the hub, after a preview, idempotently.
- A value written for an attribute always uses the type of its definition.
- The rig-compatibility attributes (PRD 4) exist in the plan, in the definitions, and on the products that matter.
- The whole catalogue can be run through AI filling in one night, resumable, with a human review before anything is written to Shopify.
- claude-pool exhaustion (exit 75) pauses the run; it never fails it or loses work.

## 3. Key design decisions

1. **Definitions are created by an explicit action, preview first** (`docs/ui-conventions.md` § Destructive writes). The preview lists create / update-compatible / conflict / unchanged and writes nothing.
2. **Namespace `recharge`**, key from the attribute (`recharge.<slug>`), as the plan already does. A key outside `recharge` is allowed (e.g. an existing `custom.*` field) but flagged "not owned by this app" and never deleted by this app.
3. **Type conflicts are never auto-resolved.** If a definition already exists with a different type, the row is a conflict with the existing type shown; Shopify does not allow changing a metafield type, so the fix is a human decision.
4. **Storefront access** (`access.storefront`) is a per-attribute flag, off by default, turned on for attributes the rig builder or theme reads. Whether the Liquid theme needs it, or only the Storefront API does, must be checked against the 2026-07 Admin schema before implementing (Open question 1).
5. **Bulk filling runs where claude-pool lives, not in the web container.** The hub image has no `claude` CLI or Python. A new operator-run script reads the catalogue, calls `claude-pool -p`, and writes suggestions into the same `product_autofill` review queue the portal path uses. Nothing it produces reaches Shopify without the existing apply step. See US-205.
6. **claude-pool is the model provider here and for the rig builder (PRD 4).** Both use the same `claude-pool` invocation rules (argument array, tools off, scrubbed env); share one runner module in `src/adapters/ai/claude-pool.server.ts` instead of two copies.

## 4. User stories

### US-201: Preview which metafield definitions the plan needs
**Description:** As a merchant I want to see, before anything is created, which definitions the plan implies and which already exist.

**Acceptance criteria**
- [unit] `planDefinitions(schema, existing)` (pure, `domain/attributes/definitions.ts`) returns one row per attribute that has a valid key, with `status` in `create | unchanged | conflict | foreign`. Fixture: 6 attributes, existing definitions `recharge.sail_size` (decimal, matches), `recharge.skill_level` (multi_line_text, plan says single_select → `conflict`), `custom.warranty` (not in plan → `foreign`, not a row of the plan). Expected counts: 4 create, 1 unchanged, 1 conflict, and `foreign` listed separately with count 1.
- [unit] Type resolution matches the existing value-write order: the plan's format maps to Shopify type exactly as `docs/attributes.md` § On the product page (text/single select → `single_line_text_field`; multi select → `list.single_line_text_field`; integer → `number_integer`; decimal → `number_decimal`; boolean → `boolean`; date → `date`; measurement with a known unit → the matching measurement type, otherwise `number_decimal`; reference/rich text/JSON → `skipped` with a reason).
- [unit] A select attribute with options yields a definition with `choices` validation equal to its option codes, in order.
- [adapter] The Shopify read of definitions (`metafieldDefinitions` for owner types PRODUCT and PRODUCTVARIANT, namespace `recharge`) is paginated: a fixture with 250 definitions over 3 pages returns 250.
- [e2e] `/app/product-setup/definitions` (new tab, see US-204) shows the preview table with the numbers from the fixture (4 / 1 / 1) and no write call is made (assert zero mutation requests).

**Verification:** tests `tests/unit/attribute-definitions.test.ts`, `tests/unit/shopify-metafield-definitions.test.ts`, `tests/e2e/specs/product-setup-definitions.spec.ts`. dev-browser: open the page against the e2e stub shop. Regression risk: the Attributes tab's type resolution must not change; share the function, do not copy it.

### US-202: Create the definitions
**Description:** As a merchant I want to press one button to create what the preview promised.

**Acceptance criteria**
- [adapter] `applyDefinitions` calls `metafieldDefinitionCreate` once per `create` row (ownerType PRODUCT or PRODUCTVARIANT from the attribute's scope), with `namespace "recharge"`, the key part, the resolved `type`, `name` = attribute name, and `validations` for choices. Asserted against a recorded mutation fixture. It never calls the mutation for `unchanged`, `conflict` or `foreign` rows.
- [adapter] A `TAKEN`/already-exists error from Shopify for a row becomes `unchanged` on a re-read, not a failure (idempotent re-run). A `INVALID` error becomes a per-row failure with Shopify's message and does not stop the other rows.
- [db] Running apply twice leaves the `event_log` with one `attribute_schema.definitions_created` event whose payload counts are `{created: n}` then `{created: 0}`.
- [e2e] After pressing *Create 4 definitions* the page shows 4 rows `Created`, the count in the header drops from "4 to create" to "0 to create", and zero console errors.
- Tenant scoping: [db] a definition run for shop A never reads or writes shop B's plan row.
- Needs scope: `write_products` (already granted) covers `metafieldDefinitionCreate`; confirm in the 2026-07 schema and note the result in `docs/attributes.md`. If a further scope is needed, it is added to `shopify.app.toml` and `.env.example` together (they must stay identical) and the merchant is told to approve it.

**Verification:** `tests/unit/attribute-definitions-apply.test.ts`, `tests/db/attribute-definitions.test.ts`. Regression risk: the store-menu job also creates a definition at runtime (`recharge.product_type_path`); the two must not both own it. The planner marks that key `managed by the store menu` and never lists it as create/conflict.

### US-203: Values are written with the definition's type, and bad values are caught
**Description:** As a merchant I want a value saved on a product to always match its definition.

**Acceptance criteria**
- [unit] Existing precedence stays (definition, then stored type, then format). With a definition of `number_decimal` and the user typing `4,2`, the saved value is `"4.2"` and the type `number_decimal`.
- [unit] A choice attribute rejects a value not in `choices` before the call, with `"<value>" is not one of the options.`
- [adapter] A `metafieldsSet` userError for one key names the attribute (not the raw key) in the message shown on the product page.
- [e2e] Product page, Attributes tab: enter `sail_size = 5,3`, save, reload: field shows `5.3` and the metafield in the stub store has type `number_decimal`.

### US-204: Rig-ready attribute pack
**Description:** As the merchant I want the plan to include the compatibility attributes the rig builder needs, without typing 40 attributes by hand.

**Acceptance criteria**
- [unit] `rigPack()` (`domain/attributes/rig-pack.ts`) returns a plan fragment that passes `parseAttributeSchema` and `schemaProblems` when merged into `starterSchema()` with zero problems, and `schemaHealth` reports no attribute without a Shopify field and no select without options.
- [unit] The pack defines at least these assignable types: Boards, Sails, Masts, Booms, Mast bases / extensions, Fins, Harnesses (windsurf); and attributes with machine-readable values: `sail_area_m2` (decimal), `sail_luff_cm` (integer), `sail_mast_rdm` (single_select: 25, 30, 35 …), `sail_mast_length_cm` min and max (two integers), `sail_boom_min_cm` / `sail_boom_max_cm` (two integers, replacing the starter's text `boom_range`), `sail_wind_min_kn` / `sail_wind_max_kn`, `sail_category` (single_select: wave, freeride, freerace, slalom, freestyle, race), `mast_length_cm`, `mast_rdm`, `mast_imcs` (integer), `mast_carbon_percent`, `mast_base_type` (single_select), `board_volume_l`, `board_width_cm`, `board_length_cm`, `board_fin_box` (single_select: Tuttle, Deep Tuttle, Powerbox, US box, Slot box, Foil), `board_max_sail_m2`, `board_min_sail_m2`, `boom_min_cm`/`boom_max_cm`, `fin_box`, `fin_length_cm`, `extension_length_cm`, `base_type`, `rider_weight_min_kg` / `rider_weight_max_kg`, `skill_level` (single_select: beginner, intermediate, advanced). The exact list is signed off by a Recharge windsurf expert (Open question 2); this list is the draft.
- [unit] Min/max pairs are validated: `min <= max` is enforced by a plan-level check `rangeOrdering` and fails with `"sail_boom_min_cm (180) is greater than sail_boom_max_cm (160)."`.
- [e2e] Settings page has *Add rig attributes*; pressing it on an empty plan adds the pack once (second press is a no-op and says `Already in the plan`), and `Product types` shows the new types.
- The pack is **loaded only on request**, like the starter (`starter.ts` convention).

### US-205: Bulk filling through claude-pool (operator run)
**Description:** As an operator I want to fill missing attribute values for the whole catalogue overnight with the pooled Claude accounts, resumable, and review the results in the usual queue in the morning.

**Acceptance criteria**
- [unit] `buildFillPrompt(product, type, attributes)` (pure) includes the product's title, vendor, tags, description text stripped of HTML, variant titles and options, and, for each empty attribute, key, format, unit, level and options as `code: label`. It excludes attributes that already have a value and never includes secrets or customer data. Snapshot-tested.
- [unit] `parseFillReply(reply, attributes)` accepts only JSON matching a Zod schema; every returned value goes through the existing `suggestedValues` checks (a choice is an option code; numbers read off the front; no ranges; unknown attribute or already-filled dropped). Fixture of 12 replies including: valid, extra keys, a label instead of a code, `"4,2 kg"`, a range `"5.0-5.5"`, prose around the JSON, an empty reply. Expected accepted counts pinned in the test.
- [adapter] `runClaudePool(prompt, {schema})` spawns `claude-pool -p <prompt> --output-format json` (arguments passed as an array, never through a shell), parses the envelope, and returns `{ok:true, value}`, `{ok:false, reason:"exhausted"}` on exit code 75, or `{ok:false, reason:"error", message}` otherwise. Tested with a fake `claude-pool` executable on `PATH` that prints recorded outputs and exits 0, 75 and 1.
- [adapter] On `exhausted` the runner sleeps until the next account resets (reads `claude-pool --pool-status` for the reset time, else 15 minutes), then continues. It never marks the product failed for exhaustion. On three consecutive `error` replies for one product it records `failed` for that product and moves on.
- [db] The runner persists progress in `product_autofill` rows (`queued` → `suggested`), keyed by product id, so killing the process and restarting asks only the products without a row or with a `failed` row (same rule as *Autofill all*).
- [db] Every suggestion is stored with `source = "claude-pool"` and `model` as returned by the envelope, so the review queue can show where a suggestion came from and the AI usage ledger counts the request with cost `null` (subscription, not billed per token).
- [adapter] The runner is invoked with tools disabled: the spawned call includes `--allowedTools ""` (or the CLI's current equivalent; verified by running `claude --help` in CI step and failing if the flag is missing) and no `--add-dir`, so the model cannot read files or run commands. Prompt content from product descriptions is wrapped in a delimited block with an instruction not to follow instructions inside it.
- [e2e] After a run over the 14-product e2e catalogue with the fake executable, `/app/products` → *AI review* shows exactly the products with suggestions (count asserted, e.g. 11 of 14), and *Apply all* writes metafields only for products whose type matched.
- Operator doc: `docs/attributes.md` § AI autofill gets a subsection *Bulk filling with claude-pool* giving the command, required env (`HUB_DATABASE_URL`, shop domain, `CLAUDE_POOL_*`), how to resume, and the stop condition.

**Verification:** `tests/unit/fill-prompt.test.ts`, `tests/unit/fill-reply.test.ts`, `tests/adapter/claude-pool-runner.test.ts` (fake executable), `tests/db/fill-resume.test.ts`. Regression risk: the portal-based autofill path must keep working unchanged (this is a second producer into the same table). Where the script may run: a machine with `claude-pool` and the pool directory, with DB access to the hub (read catalogue + write `product_autofill`); not in the production containers.

### US-206: Same rules, one place
**Description:** As a maintainer I do not want two copies of "which attributes need filling".

**Acceptance criteria**
- [unit] Both producers (portal path and claude-pool path) call `attributesToFill` and `suggestedValues`; a lint-style test (grep of `src/` and `scripts/`) fails if either function is reimplemented elsewhere.
- [unit] A suggestion produced by either path for the same fixture product and the same model reply is byte-identical in storage.

### US-207: Backfill the rig-critical products first
**Description:** As the merchant I want the rig builder's data complete for the products it will recommend, before the long tail.

**Acceptance criteria**
- [unit] `coverage(plan, catalogue)` returns, per rig type (boards, sails, masts, booms, bases, fins), `{products, withAllRequired, missing: {attributeKey: count}}`. Fixture: 20 sails, 12 with all required attributes, 8 missing `sail_boom_max_cm` → `{products: 20, withAllRequired: 12, missing: {sail_boom_max_cm: 8}}`.
- [e2e] The Product setup page shows a *Rig readiness* line per type with those numbers (stated once, no badge, no green), linking to Products filtered to the incomplete ones (the filter returns the 8, not all 20: divergent-data rule).
- The runner accepts `--types sails,masts` to fill these first.

## 5. Functional requirements

- FR-1: Definition planning is pure and shares type resolution with value writing (US-201, US-203).
- FR-2: Creation is explicit, previewed, idempotent and logged (US-202).
- FR-3: The rig pack is opt-in and passes plan validation (US-204).
- FR-4: The claude-pool runner is a second producer into `product_autofill` with the same checks and the same review gate (US-205, US-206).
- FR-5: Exhaustion of the pool pauses, never fails (US-205).
- FR-6: Readiness numbers are visible per rig type (US-207).

## 6. Non-goals

- No deletion or type change of existing definitions.
- No automatic apply of claude-pool suggestions in this PRD (review gate stays; "apply when confident" remains a portal-source feature).
- No bulk entry grid for values (separate idea; `docs/attributes.md` lists it as a known limit).
- No running `claude` inside the production containers.

## 7. Design considerations

Prototype: none for the definitions tab and rig-readiness line (no new interaction pattern; it is the existing `Product setup` tab layout, `s-table`, preview-then-apply, one primary action). Design: no prototype (agent judgement; user asked for local HTML only for the rig builder). The page must follow `docs/ui-conventions.md`: badges are status only, no green for normal, a zero-count problem indicator does not render, numbers stated once, `PageHeader`/`ProcessHeader` from PRD 3 if the run is a background process.

New tab *Definitions* in `ProductSetupNav` (after Attribute sets). Reuse: `ProductSetupNav`, the Store-menu page's progress pattern, `useLiveRevalidation`, `DownloadButton`.

## 8. Technical considerations

- Touchpoints: `src/domain/attributes/{definitions,rig-pack,coverage}.ts` (new, pure), `src/adapters/shopify/metafield-definitions.ts` (new; reuse the runtime definition code in `type-menu.ts`), a job `metafield-definitions-sync` registered in `queues.ts` and `worker.ts`, route `app.product-setup.definitions.tsx`, `scripts/fill-attributes.ts` (the operator runner; imports domain + repositories, not web code). `AGENTS.md` rules apply: `domain/` pure, no `any`, additive migrations, tenant scoping.
- Migration (additive): `product_autofill.source text null`, `product_autofill.model text null`.
- Anthropic usage and the portal: the portal's autofill uses its own `ANTHROPIC_API_KEY` and Haiku. The claude-pool path does not touch it.
- Rate behaviour: one `claude-pool` call per product with at most 20 attributes in one reply; 10 in flight at most (pool throttles itself; start with 2).
- Risk: model output for numeric specs can look right and be wrong (a sail's boom range). Mitigation: review gate, `confidence` per value if the model gives one, and coverage rather than trust.

## 9. Success metrics

- After the run: ≥ 90 % of boards, sails, masts, booms, bases and fins have all required rig attributes (measured by `coverage`), the remainder listed for manual entry.
- A reviewer accepts ≥ 85 % of suggested values for rig-critical attributes without edits on a 50-product sample (sampled by hand before the full run).
- Zero definitions with a wrong type created (conflicts caught in preview).

## 10. Open questions

1. Does the Liquid theme need `access.storefront` for `product.metafields.recharge.*`, or only the Storefront API? Check the 2026-07 docs before US-202 and record the answer in `docs/attributes.md`.
2. Who signs off the rig attribute list and the allowed values (a windsurf expert at Recharge)? Until then the pack is a draft.
3. Can claude-pool's `claude` forward `--allowedTools ""` and a JSON-schema flag in the installed version? Verify with `claude --help` in this environment before building US-205.
4. ~~Terms for pooled accounts~~: decided by Grega 2026-10-28 (claude-pool is used this way).
5. Should variant-scoped values (sail size per variant) come from variant options when the title is ambiguous? The snapshot stores titles only (PRD 4 adds `selectedOptions`).

## 11. Verification checklist

### Per-change coverage

**C1: definitions planning and creation**
- [ ] Frontend: Definitions tab, preview table, one primary action with the count in its label.
- [ ] Validation: unmapped/malformed key rows are listed as `skipped` with a reason, never sent.
- [ ] Backend storage: definitions exist in the stub store with namespace `recharge`, key, type, ownerType.
- [ ] Round-trip: create → reload → counts `0 to create`, 4 `exists`.
- [ ] Edge cases: conflict row; foreign row; 250 existing definitions (pagination); Shopify userError on one row; re-run after partial failure.
- [ ] Shop scoping: shop A's apply does not touch shop B (`[db]`).

**C2: rig pack**
- [ ] Frontend: *Add rig attributes* adds once.
- [ ] Validation: `rangeOrdering` fails with the named message.
- [ ] Round-trip: add → export JSON → import → identical plan.
- [ ] Edge cases: adding the pack to a plan that already has an attribute named `Sail size` (name collision) is reported, not duplicated.

**C3: claude-pool runner**
- [ ] Backend: rows in `product_autofill` with `source = claude-pool`.
- [ ] Validation: the 12-reply fixture.
- [ ] Round-trip: kill mid-run, restart, no product asked twice.
- [ ] Edge cases: exit 75 mid-run; empty reply; non-JSON; a description containing "ignore previous instructions" does not change the output shape (fixture reply asserts the schema still holds; the real guard is that tools are off and nothing is written without review).
- [ ] Shop scoping: runner requires `--shop`; refuses to run without it.

**C4: rig readiness numbers**
- [ ] Frontend: one line per type; no badge when complete.
- [ ] Backend: filter link returns the 8 incomplete, not 20.
- [ ] Edge cases: type with zero products shows `No products` not `0 of 0 complete`.

### Test data setup

Extend the e2e stub catalogue (`tests/e2e/support/`):
- 20 sails: 12 with all required attributes, 8 missing `sail_boom_max_cm`; 6 masts (2 missing `mast_imcs`); 10 boards (3 with no fin box); 4 fins.
- Existing definitions in the stub: `recharge.sail_size` (decimal), `recharge.skill_level` (multi_line_text, deliberate conflict), `custom.warranty` (foreign).
- Second shop with its own plan for isolation tests.
- Cleanup: the e2e database is rebuilt per run.

### Browser end-to-end

- [ ] Data seeded as above.
- [ ] Every `[e2e]` criterion driven in Playwright; DOM asserted, zero page errors beyond the two documented hydration errors (T-29), network 2xx.
- [ ] Full path: empty plan → *Add rig attributes* → Definitions preview (N create) → Create → run fill with the fake executable → AI review shows the counted suggestions → Apply all → Attributes tab of one sail shows the filled value → coverage line updates.
- [ ] Screenshot of the Definitions tab and the rig-readiness line.
- [ ] Visual parity: N/A (no prototype).

### Suite gates

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build && npm run test:e2e`.
- [ ] `npx prisma validate` and the migration applied to a clean database.
- [ ] `docs/attributes.md` and `docs/project-status.md` T-25 updated in the same change.
- [ ] Evidence: command output, not "looks good".

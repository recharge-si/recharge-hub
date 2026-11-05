# Rig builder

The storefront rig builder (PRD 4, `tasks/prd-04-ai-rig-builder.md` on the
`recharge-prds` branch): a buyer on recharge.si describes themselves and gets a
complete, compatible, in-stock windsurf rig they can put in the cart in one
click. This file describes what is implemented in this repository. The page,
section and JavaScript live in the theme repo (`rechargesi`); this repo owns the
contract.

**The rule that keeps it safe:** the AI reads the buyer and writes the
explanations; plain code chooses the products and checks that they fit. The
model never returns a SKU, `build` never calls a model, and every sentence a
model writes is filtered against the rig the engine produced.

## Status of the data it runs on

- **The rules table is a PLACEHOLDER** (`src/domain/rig/rules.ts`, id
  `R1-placeholder`). Its numbers are not advice. Only two are fixed by the PRD:
  an 82 kg intermediate freeride rider in 15-25 knots gets a sail of 5.3-6.2 m2
  and a board of 95-115 L. Recharge staff sign off the real table manually. The
  settings card and `scripts/rig-eval.ts` print a warning while it is the
  placeholder.
- **Launch criterion (open):** all 30 evaluation rows pass, and a Recharge
  windsurf expert has reviewed 10 full rigs by hand and signed the table.
  Sign-off: name _not yet recorded_, date _not yet recorded_.
- The attribute keys the engine reads are the **store's own** (its product
  plan, namespace `recharge`), defined once in `src/domain/rig/keys.ts`; see
  "Attributes the engine reads". The old invented rig pack keys (`sail_area_m2`,
  `mast_rdm`, ...) are no longer read. No data, no check: a rule whose data is
  absent is reported `unchecked`, never passed or failed by guess.

## Architecture

```text
recharge.si  POST /apps/rig/{build,explain,verify}
        |  Shopify App Proxy (signed query string)
        v
hub  /proxy/rig/*   src/web/routes/proxy.rig.*.tsx   (thin resource routes)
        v
src/adapters/rig/api.server.ts   method -> signature (401) -> rate limit (429)
                                 -> body (400/413) -> readiness (409) -> work
        v                                      v
src/domain/rig/   pure engine, checks,   src/adapters/ai/rig-provider.server.ts
profile, words                           RigAiProvider -> ClaudePoolProvider
                                         -> shared runner claude-pool.server.ts
```

- `domain/rig/engine.ts`: `buildRig(profile, candidates, rules, {shopId})` and
  `checkRig(selection, context)`. Deterministic: ties are broken by price then
  variant id. `verify` and `build` call the same `checkRig`.
- `domain/rig/candidates.ts`: snapshot rows to candidates, and `rigReadiness`.
- `domain/rig/profile.ts`: the strict form schema, `parseProfile` for what a
  model said, `mergeProfile` (explicit answers win; `source` per field).
- `domain/rig/words.ts`: prompts, template sentences (en, sl), `acceptWhy`.
- `adapters/rig/api.server.ts`: the three handlers with their dependencies
  injected. `runtime.server.ts` wires the real ones.

## Contract

Examples that the tests keep honest are in `tests/fixtures/rig/api/` (each file
is the real output of the handler; `tests/adapter/rig-contract.test.ts` fails on
drift, and `UPDATE_RIG_FIXTURES=1` regenerates them after a deliberate change).
All bodies are JSON; every response has `Cache-Control: no-store` and no CORS
headers (same-origin through the proxy).

### `POST /apps/rig/build`

Request: `{ text?, answers?, locale?, requestId? }`, unknown keys refused,
`text` at most 1000 characters, at least one of `text` and a non-empty
`answers`. `answers` keys: `discipline` (`windsurf`), `weightKg` 30-200,
`heightCm` 120-230, `skill` (`beginner|intermediate|advanced`), `windMinKn`,
`windMaxKn` 0-60, `budgetEur`, `owns` (any of `board sail mast boom base fin`),
`boardKind` (`freeride|wave`), `ownedBoomMinCm`, `ownedBoomMaxCm`.
**`build` ignores `text`**: it never calls a model. Sending the `requestId` of an
earlier build updates that row instead of adding one (the live rig calls `build`
on every changed answer).

Response 200: `{ requestId?, profile, needs, rigs, unmet, warnings, mode,
snapshotAgeMinutes }`. `mode` is always `plain` for `build`. `needs` lists what
the engine still needs (`weightKg`); then there is no rig and no `requestId`.
A rig is `{ label, items, total, currency, checks, alternatives }`; an item has
`role productId variantId title variantTitle url image price currency available
quantity why specs` (`variantId` is the number `/cart/add.js` takes, `why` is
the template sentence, `url` is storefront-relative). `alternatives` are only
parts that keep every check passing. `unmet` entries are `{role, reason}` with
`reason` `no_compatible_in_stock` or `no_rule`, or `{role:"budget",
reason:"over_budget", overMinor}`. `warnings` are `{code, message}`; switch on
`code`. Codes: `kind_assumed skill_assumed wind_assumed over_budget
stale_snapshot owned_<role>_unchecked mode_plain text_not_read
unsupported_discipline skill_contradiction`.

Errors: 400 `{code:"invalid_body", field, message}` (`field` is e.g.
`answers.weightKg`), 400 `invalid_json`, 401 `unauthorized`, 405, 413
`text_too_long` or `body_too_large`, 429 `rate_limited` with `Retry-After`,
409 `{code:"not_ready", reason:"disabled"|"catalogue"}` (409 and not 503: Shopify App Proxy replaces a 5xx answer with the store error page, so the page could not read the JSON). A catalogue that cannot be read is 409 `{code:"unavailable"}` with `Retry-After: 30`, and is logged. An AI failure is never a
500.

### `POST /apps/rig/explain`

Same body (`requestId` optional). Reads `text` into a profile (when there is
text), rebuilds the rig from the merged profile, then asks for one sentence per
part. Response: `{ requestId, profile, needs, whys, variantIds, mode, warnings }`.
`whys` is keyed by variant id as text; `variantIds` is the rig the sentences are
for (if the text changed the profile, the page should rebuild with the returned
`profile` before applying them). `mode` is `ai` when the model wrote the words,
else `plain` with warning `mode_plain` (model unavailable, busy, exhausted,
timed out, or over its daily budget). `text_not_read` means the text could not
be read. The rig is identical in both modes.

### `POST /apps/rig/verify`

`{ variantIds: number[1..12], answers?, locale? }` returns `{ ok, checks, items,
total, currency, warnings }` using the same `checkRig` as `build`. Unknown
(or other shops') variants, unavailable variants and two parts of one role show
up as failed checks (`unknown-variant-<id>`, `unavailable-variant-<id>`,
`duplicate-<role>`).

### Checks

A rule has three outcomes: it ran and passed, it ran and failed, or it could
not run because a part lacks the data (`unchecked`). Only the first two are in
`checks` (`{ id, ok }`). The third is in `unchecked` (`{ id, missing: [{ role,
key }] }`, on each rig and on `verify`), and there is one warning per missing
key, `unchecked_<role>_<key>` (for example `unchecked_sail_recommended_mast_cm`),
with a sentence the theme can show as it is. A rig is verified only for the
checks that ran.

| id | needs | passes when |
|---|---|---|
| `sail-fit` | sail `canopy_area` | area in the rules table band for the rider |
| `board-fit` | board `volume_l` | volume in the band (unchecked for a board with only a sail range) |
| `board-sail-range` | sail area, board `board_sail_min_m2`/`max_m2` | area within the board's range |
| `rider-fit` | board `rider_mass_min_kg`/`max_kg` (either) | rider weight within; **only runs when the board states it** |
| `sail-mast-diameter` | sail `recommended_mast_diameter` and/or `compatible_mast_diameters`, mast `mast_diameter` | mast diameter is in the union of the sail's |
| `sail-mast-length` | sail `recommended_mast_cm`, mast `length_cm` (+ extension `extension_min_cm`/`max_cm` when one is in the rig) | the mast, stretched by the extension range, reaches the recommended length within the tolerance (PLACEHOLDER 10 cm) |
| `sail-mast-imcs` | sail `recommended_mast_imcs`, mast `mast_imcs` | within the tolerance (PLACEHOLDER 1); **only runs when both exist** |
| `mast-boom-diameter` | boom `compatible_mast_diameters`, mast diameter | listed; **only runs when the boom lists some** |
| `sail-boom-range` | sail `boom_min_cm`/`boom_max_cm` (else `recommended_boom_cm`), boom `boom_min_cm`/`boom_max_cm` | the boom covers the sail's whole range (the recommended length as a point) |
| `mast-extension-diameter` | mast and extension `mast_diameter` | equal |
| `extension-base-connection` | extension and base `base_connection` | equal |
| `fin-box` | board `fin_box_types`, fin `fin_box` | the fin's box is one the board lists |
| `fin-length` | fin `length_cm`; board `board_fin_min_cm`/`max_cm`, else board `volume_l` with the placeholder table | fin length within the range or band |
| `owned-boom` | sail boom range, the range the buyer gave | the owned boom covers the sail's range |

A check involving gear the buyer owns is not computed; only an owned boom with
its range given produces `owned-boom`, otherwise the warning
`owned_boom_unchecked`. There is no rule between a mast and a base alone: the
store has no key that joins them; the base is checked against an extension.

Boom rule: the boom must open over the **whole** range the sail asks for
(`boom.min <= sail.min` and `boom.max >= sail.max`). The PRD prose states the
inequalities the other way round, but its examples (150-190 passes 165-175,
170-210 fails 160-170) only hold with this reading.

## The engine

1. Sail: the category (`boardKind`, default freeride) and the rules row for the
   rider's weight and the middle of the wind range give an area band; sails in
   band, in stock and complete are tried closest to the middle first (up to 8).
2. Mast, then an extension when the mast alone falls short, then a base: no rule
   that ran may say no (diameter, length, IMCS), plain masts before masts that
   need an extension, and of the compatible ones the ones with the fewest rules
   left unchecked. If no base is stocked the mast is kept and `base` is unmet.
3. Boom covering the sail's range (and listing the mast's diameter if it lists
   any). 4. Board of the sail's kind whose volume is in the band (a board with
   no volume is kept if its sail range takes the sail) and that has a fin that
   fits; then a fin of its box and length.

Kind: a freeride rider gets sails and boards whose plan type is Freeride or
Beginner, a wave rider Wave or Freewave (the leaf type name, "Freeride sails"
gives `freeride`). Foil, race, slalom and WindSUP parts are not offered. A part
on the role's own type (no discipline) is allowed.
5. The first sail that gives a complete rig wins; otherwise the best partial rig
   is returned with `unmet`.

Parts other than the sail are the lower median by price ("recommended"). With a
budget, an over-budget rig is replaced by the cheapest compatible one; if that is
still over, it is returned with `unmet` budget and the amount over.

Left out, with the count under `missingAttributes` (keys): a variant that lacks
what the rules need to place it (below). Only parts with `availableForSale` and
more than zero units are offered (open question 6: no "on order" parts). A
**null quantity is unknown, not stock**: such a part is left out and the
warning `stock_not_read` says how many. Owned gear is dropped from
the rig and its checks; the engine still picks a reference part to size the rest.
Not implemented: harness (optional in the PRD), Good/Better/Best.

## Attributes the engine reads

All in namespace `recharge`, variant scope with a fall back to the product's
(and the other way round). One map: `src/domain/rig/keys.ts`.

| role | keys |
|---|---|
| sail | `canopy_area` (m2), `recommended_mast_cm`, `recommended_mast_diameter` (rdm\|sdm), `recommended_mast_imcs`, `compatible_mast_diameters` (list), `boom_min_cm`, `boom_max_cm`, `recommended_boom_cm` |
| mast | `length_cm`, `mast_diameter` (rdm\|sdm), `mast_imcs`, `carbon_percent` |
| boom | `boom_min_cm`, `boom_max_cm`, `compatible_mast_diameters` |
| mast extension | `extension_min_cm`, `extension_max_cm`, `base_connection`, `mast_diameter` |
| mast base | `base_connection` |
| fin | `fin_box` (tuttle, power_box, deep_tuttle, slot_box, us_box, mini_tuttle), `length_cm` |
| board | `volume_l`, `board_sail_min_m2`, `board_sail_max_m2`, `board_fin_min_cm`, `board_fin_max_cm`, `fin_box_types` (list), `rider_mass_min_kg`, `rider_mass_max_kg` |

### Stored formats (`src/domain/rig/values.ts`)

Read from the production store; the parsers are unit-tested with these exact
shapes.

- `number_decimal`: `{"type":"number_decimal","value":"5.0"}` (a string).
- `dimension` / `weight` / `volume`:
  `{"type":"dimension","value":"{\"value\":37.0,\"unit\":\"CENTIMETERS\"}"}`
  (a JSON string). Unit-aware: converted to the unit the key names (cm, kg,
  m2, L); a unit it does not know gives no value, never a guess. A plain number
  is taken in the unit the key names.
- `single_line_text_field`: a bare code, lower-cased.
- `list.single_line_text_field`: a JSON array string, `"[\"rdm\",\"sdm\"]"`;
  sorted and de-duplicated; empty or unreadable means no data.

### Derived facts (`src/domain/rig/derive.ts`)

Only when the metafield is missing, only these, and each is flagged: the item
carries `derived: [field, ...]` and readiness counts them.

- mast length: the variant option Size ("490", "460 cm"), 370-520 cm.
- sail area: option text like "5.8 m2 / Orange" (or m²), 1-14 m2.
- fin length: option Size in millimetres ("440" is 44 cm, divided by 10 over
  100), or "36 cm Power Box" in cm; 15-70 cm.
- mast RDM / SDM from the product title ("HD RDM C75"; both or neither gives
  nothing) and carbon percent from "C75" (10-100).

No compatibility fact (boom range, mast requirement, fin box, rider mass) is
ever derived.

## Candidates and readiness

A product is a candidate for a role when the plan's type for it (the existing
`typeForProduct`: chosen type, category, then product type) or an ancestor is
named **Boards, Sails, Masts, Booms, Mast extensions, Mast bases** or **Fins**
and the path runs through **Windsurf** (the plan also has Wing and SUP boards).
The old pack's single "Bases and extensions" type still works: a variant with
`extension_min_cm`/`max_cm` is an extension. Variant metafields win over product
ones.

What a candidate needs to be **placed** (it is "complete"; anything else is
counted under its key and left out): sail `canopy_area`; mast `length_cm` and
`mast_diameter`; boom `boom_min_cm` and `boom_max_cm`; fin `fin_box`; board
`volume_l` or both `board_sail_min_m2`/`max_m2`, and `fin_box_types`; extension
its min and max; base nothing. Derivations count toward this.

`rigReadiness` (domain) counts per role: active products, **complete**
products, complete products **in stock**, variants whose stock is unknown, the
keys variants lack with counts (most common first), the products to fix, and how
many values were derived. The builder is **ready** when each of board, sail,
mast, boom and fin has at least 3 complete in-stock products (the base and the
extension are reported, not gating). The merchant lines
(`src/web/lib/rig-readiness.ts`, Product setup types and definitions pages)
read "7 of 8 ready - missing canopy_area (1)" and add "stock not read yet:
refresh the catalogue" when no variant of the role has a quantity (a snapshot
older than the stock columns). The **Rig builder** card on Product setup >
Settings shows complete and in-stock per role, and the switch
(`shop.rig_builder_enabled`) cannot be turned on while it is not ready, nor
while the installed `claude` lacks the `--tools` flag. The proxy answers 409
`not_ready` while the switch is off (with `detail: "stock_not_read"` when that is
why). The card also shows `Plain mode N of last 50`.

The **Add rig attributes** card (Settings) adds the old example pack, whose
keys the engine does not read. It is hidden once the plan already has the keys
that place the five gating roles (`src/domain/rig/plan.ts`), so a store with
its own plan is not given a second, unread set. Remapping the pack to the
store's keys is a follow-up.

## Cache

`loadRigSource` reads the catalogue in two steps: a light read to find the
products the plan makes rig parts (about 250 of 1,300), then the heavy columns
(metafields, variants, options) for those only. The prepared candidates are
cached per shop (`src/adapters/rig/snapshot-cache.ts`): **fresh for 300 s**, then
**served stale while one background refresh runs** (single flight, a failed
refresh keeps the stale snapshot and is logged), and a caller waits only when
there is no snapshot or it is older than 30 minutes. Shopify's App Proxy gives
up near 5 s, and a full read took about 3 s. `snapshotAgeMinutes` is computed
at answer time.

## Snapshot

`catalog_product` gained `online_store_url` and `description` (plain text, at
most 2000 characters); `catalog_variant` gained `options` (selectedOptions),
`inventory_quantity` and `available_for_sale` (nullable, so old rows keep
working until the next read; a null counts as not available). The bulk query
reads them; `products/update` (REST-shaped payload) updates them, with
availability read the way Shopify sells (untracked is always available, tracked
when units remain or overselling is allowed). Because stock is in the snapshot,
a quantity change now writes the row; the old "nothing moved" skip only applies
when stock is also unchanged.

Freshness: `snapshotAgeMinutes` is the age of the newest snapshot or webhook row.
Beyond 30 minutes the response carries `stale_snapshot` and each item
`checkAvailability: true` (open question 5: no live inventory read). A shop with
the builder on gets a snapshot about hourly instead of nightly.
Measuring the bulk read duration on the real store is still to do.

## Model: claude-pool

`ClaudePoolProvider` (`src/adapters/ai/rig-provider.server.ts`) wraps the shared
runner (`claude-pool.server.ts`): argument array, all tools off (`--tools ""`),
no MCP, no slash commands, scrubbed environment (only `PATH`, `HOME`, `USER`,
locale and `CLAUDE_POOL_*`), empty working directory, a dedicated empty `HOME`,
process-group kill on timeout, exit 75 meaning `exhausted`. On top: concurrency
`RIG_AI_MAX_CONCURRENT` with no queue (the next call is `busy` at once), a whole
explain budget `RIG_AI_TIMEOUT_MS` (default 20 s) shared by the two calls, one
retry on a transient error (never on 75, busy or timeout), and a daily budget
`RIG_AI_DAILY_CALLS` counted from `ai_usage` rows with `provider='claude-pool'`
(one row per spawn: purpose `rig_profile` or `rig_why`, `latency_ms`, cost null).
The translation usage pages read only `provider='openai'` rows.

Prompts carry only the buyer's text (quoted as data, e-mail addresses and angle
brackets removed) or the engine's facts. No IP, cookie, customer id or e-mail.
`acceptWhy` keeps a sentence only if it is keyed by an item in the rig, at most
220 characters, has no link or markup and names no other product (scan against
every candidate title); otherwise the template sentence is used. Profile replies
go through `parseProfile`: ranges as in the form, numbers only from numeric
strings, pounds and inches and Beaufort converted in code, out-of-range values
`invalid` and never clamped. Twelve recorded replies are pinned in
`tests/fixtures/rig/profile-replies/`.

## Limits and storage

- Per caller (salted HMAC of the forwarded IP, in this process's memory):
  `explain` 3 per minute and 10 per hour; `build` and `verify`
  `RIG_BUILD_PER_MINUTE` / `RIG_BUILD_PER_HOUR` (60 and 600). **Deviation from
  the PRD:** it asked 10 builds an hour, which cannot work with the live rig that
  builds on every answer; the limits that guard cost are on `explain`. The
  counts reset on restart and are per web process.
- `rig_request`: `id` (`rb_` + 24 hex), `shop_id`, `created_at`, `explained_at`,
  `profile` json, `rig_variant_ids` int8[], `mode`, `ip_hash`, `latency_ms`,
  `ai_cost_micro_eur`. No raw text and no customer column; the privacy webhooks
  need no change. Job `purge-rig-requests` (nightly per shop) deletes rows older
  than 90 days.
- Logs carry `requestId`, mode and latency, never text. Sentry breadcrumbs per
  build are not added yet.

## Image and configuration

- `shopify.app.toml`: `[app_proxy] url = https://recharge-hub.time-4-action.com/proxy/rig`,
  `prefix = "apps"`, `subpath = "rig"`. `npm run deploy` after merging; whether a
  single-merchant app may use an App Proxy is still to be verified on the dev app.
  The SDK answers 400 for a bad signature; the routes turn every failure into 401.
- `Dockerfile` (runtime stage): `python3`, `claude` pinned by
  `CLAUDE_CODE_VERSION`, the vendored `ops/claude-pool/claude-pool` (0.16.2, pinned
  by `CLAUDE_POOL_SHA256`). **Not built or run yet**; whether the native `claude`
  runs on Alpine (musl) is unverified. If not, move the runtime stage to
  `node:22-bookworm-slim`.
- `docker-compose.yml` (web): the pool directory mounted read-only at
  `/run/claude-pool` (host path `CLAUDE_POOL_DIR_HOST`, default `./data/claude-pool`)
  and a writable volume for `CLAUDE_POOL_STATE` and `CLAUDE_POOL_LOG`. The worker
  does not call the model.
- Variables are in `docs/development.md` § Environment variables.

## Quality gate

`npx tsx scripts/rig-eval.ts --csv rows.csv --snapshot snapshot.json` (or `--shop
DOMAIN [--export snapshot.json]` to read the database and save the snapshot for
offline repeats). Columns: `text, weightKg, skill, windMinKn, windMaxKn,
boardKind, budgetEur, owns, expectedSailMinM2, expectedSailMaxM2,
expectedBoardMinL, expectedBoardMaxL, notes`. The run needs no model: the eval
uses the structured answers. It prints pass/fail per row and rule and exits 1 on
any failure. `tests/fixtures/rig/eval-sample.csv` is a **placeholder** sample.

## Known limits

- Windsurf only; wing, foil and SUP later. English and Slovenian sentences; the
  Slovenian strings are drafts for review.
- Single web process assumed for rate limits and the catalogue cache (300 s, stale while revalidate).
- Stock is Shopify's `inventoryQuantity`, not the hub's `SupplyLevel`.
- `/apps/rig/*` is not yet verified end to end against Shopify (no dev store
  was used); the signature check is `authenticate.public.appProxy`.

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
- The attribute keys the engine reads are those of the rig attribute pack
  (PRD 2 US-204); they are defined in `src/domain/rig/keys.ts` and must match
  the pack. No metafield, no rig.

## Architecture

```text
recharge.si  POST /apps/rig/{build,explain,verify}
        |  Shopify App Proxy (signed query string)
        v
hub  /proxy/rig/*   src/web/routes/proxy.rig.*.tsx   (thin resource routes)
        v
src/adapters/rig/api.server.ts   method -> signature (401) -> rate limit (429)
                                 -> body (400/413) -> readiness (503) -> work
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
503 `{code:"not_ready", reason:"disabled"|"catalogue"}`. An AI failure is never a
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

`sail-fit`, `board-fit`, `board-sail-range`, `sail-mast-rdm`, `sail-mast-length`
(mast plus extension), `sail-boom-range`, `mast-base-type`,
`mast-extension-type`, `fin-box`, `fin-length`, `owned-boom`. A check involving
gear the buyer owns is not computed; only an owned boom with its range given
produces `owned-boom`, otherwise the warning `owned_boom_unchecked`.

Boom rule: the boom must open over the **whole** range the sail asks for
(`boom.min <= sail.min` and `boom.max >= sail.max`). The PRD prose states the
inequalities the other way round, but its examples (150-190 passes 165-175,
170-210 fails 160-170) only hold with this reading.

## The engine

1. Sail: the category (`boardKind`, default freeride) and the rules row for the
   rider's weight and the middle of the wind range give an area band; sails in
   band, in stock and complete are tried closest to the middle first (up to 8).
2. Mast, extension, base together: RDM equal, length in the sail's range, plain
   masts before masts that need an extension, only combinations with a base of
   the mast's type. If none has a base the mast is kept and `base` is unmet.
3. Boom covering the sail's range. 4. Board in the volume band that takes the
   sail's size and has a fin that fits; then a fin of its box and length band.
5. The first sail that gives a complete rig wins; otherwise the best partial rig
   is returned with `unmet`.

Parts other than the sail are the lower median by price ("recommended"). With a
budget, an over-budget rig is replaced by the cheapest compatible one; if that is
still over, it is returned with `unmet` budget and the amount over.

Left out, with the count under `missingAttributes` (keys): a variant without a
required attribute. Only parts with `availableForSale` and more than zero units
are offered (open question 6: no "on order" parts). Owned gear is dropped from
the rig and its checks; the engine still picks a reference part to size the rest.
Not implemented: harness (optional in the PRD), Good/Better/Best.

## Candidates and readiness

A product is a candidate for a role when the plan's type for it (the existing
`typeForProduct`: chosen type, category, then product type) or an ancestor is
named **Boards, Sails, Masts, Booms, Bases and extensions** or **Fins**. Bases
and extensions share a type; a variant with `extension_length_cm` is an
extension. Variant metafields win over product ones.

`rigReadiness`: each of board, sail, mast, boom and fin needs at least 3 products
with an in-stock variant that has every required attribute (the base is reported,
not gating). The **Rig builder** card on Product setup > Settings shows it per
role, and the switch (`shop.rig_builder_enabled`) cannot be turned on while it
is not ready, nor while the installed `claude` lacks the `--tools` flag. The
proxy answers 503 `not_ready` while the switch is off. The card also shows
`Plain mode N of last 50`.

Gap to raise with PRD 2: the pack has no per-board fin length range. The fin
length rule is therefore part of the rules table (by board volume).

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
- Single web process assumed for rate limits and the 60 s catalogue cache.
- Stock is Shopify's `inventoryQuantity`, not the hub's `SupplyLevel`.
- `/apps/rig/*` is not yet verified end to end against Shopify (no dev store
  was used); the signature check is `authenticate.public.appProxy`.

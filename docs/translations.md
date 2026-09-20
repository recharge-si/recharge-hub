# Translations

The store's languages and their translations, managed from inside the app:
add a language, publish it, translate the store with AI, correct a
translation by hand, and see what the AI cost. Shopify is the source of truth
throughout; this app adds the AI, the memory of what it wrote, and the
bookkeeping.

This document is the design and the map of the implementation. Where the code
and this document disagree, the code is right and this document is the bug.

## What the module owns, and what it does not

| Shopify owns                                                            | Recharge Hub owns                                                                        | Environment owns                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| Which locales exist, which is primary, which are published              | AI translation settings per language (on, automatic, content scope, overwrite policy)    | `OPENAI_API_KEY`                          |
| The market web presences each locale is served on                       | The glossary: terms to translate a given way, terms never to translate                   | `OPENAI_TRANSLATION_MODEL`                |
| Every original string and its digest                                    | Per-resource source-language overrides                                                   |                                           |
| Every translated string, its `outdated` flag and `updatedAt`            | Ownership: what this app wrote, per field and language, hashed                           |                                           |
|                                                                         | Syncs, their items and errors; a coverage cache; AI usage with an estimated cost per row |                                           |
|                                                                         | What the AI learnt: the store profile, the store's terminology, translation memory       |                                           |

**Two vocabularies, kept apart on every screen.** "Shopify" says whether a
language is the default, published or unpublished. "AI translation" says
whether this app works on it and how. A language is never shown as published
because AI is on, and never as "on" because it is published. Nothing about a
locale's own state is stored here: `shopLocales` is read on every page that
shows it.

**No copy of the catalogue.** A page of translatable resources is read, acted
on and forgotten. The only per-resource rows this app keeps are the source
override and the ownership record, both of which are about what this app
decided or did, not about the content. What the engine *learns* is kept
apart from the catalogue too: a model-written profile of the store, the
terms the store's own data supports, and short strings with their
translations — never a description, never a customer, never an order.

## Architecture

```text
web (React Router)                                    worker (pg-boss)
  /app/translations …  ──shopLocales / translatableResources──▶ Shopify Admin GraphQL
  editor save  ──translationsRegister──▶ Shopify
  Translate store / language actions ──startSync──▶ translation-sync ──▶ engine ──▶ OpenAI
                                                                        └──▶ translationsRegister
  webhooks/products/{create,update} ──▶ translation-resource-event (one product, inline)
  nightly tick ──▶ automatic sync per language; translation-coverage per shop
```

- `src/domain/translations/` — pure: resource types and content groups
  (`types`), the per-field plan and ownership rules (`plan`), the prompt and
  its strict reply parser (`prompt`), the versioned pricing table (`pricing`),
  estimates (`estimate`), coverage counting (`coverage`); and the
  intelligence layer — the source-locale decision (`source`), locale
  fallbacks (`locale`), the bounded store sample (`snapshot`), the store
  profile prompt and parser (`profile`), terminology discovery
  (`terminology`), translation memory rules (`memory`), resource context
  rendering (`context`), post-translation validation (`validate`), language
  detection with calibrated confidence (`detection`), and the text
  mechanics they share (`text`). No clock, no Shopify, no OpenAI.
- `src/adapters/shopify/locales.ts` — `shopLocales`, `availableLocales`,
  `shopLocaleEnable` / `Update` / `Disable`, `markets` with web presences.
  `src/adapters/shopify/translations.ts` — `translatableResources` (one aliased
  `translations(locale:)` per target locale), `translatableResourcesByIds`,
  `translationsRegister`, `translationsRemove`, title search.
- `src/adapters/ai/openai.server.ts` — **the one provider path.** Every request
  to OpenAI goes through `callModel`, and every attempt that reaches the
  provider is an `ai_usage` row.
- `src/adapters/shopify/store-context.ts` — the bounded store snapshot
  (shop, menus, collections, a few pages of products, blogs) and the per-page
  facts behind resource context (`nodes`: products, collections, articles,
  metafields, options).
- `src/adapters/translations/engine.server.ts` — source → plan → memory →
  provider → validate → register → record ownership → learn, for one
  resource into its target languages; `intelligence.server.ts` — what a pass
  knows beyond the fields (profile, terms, memory, contexts), loaded once;
  `profile.server.ts` — keeps the store profile and terminology current;
  `context.server.ts` — where each resource of a page sits;
  `coverage.server.ts` — the store-wide count; `syncs.server.ts` — create a
  sync and queue it; `inline.server.ts` — one resource, now, as a sync.
- `src/adapters/db/repositories/translations.server.ts` — every table below,
  tenant-scoped; `translation-intelligence.server.ts` — the profile, terms
  and memory, with `INSERT … ON CONFLICT` merges for concurrent workers.
- `src/jobs/handlers/translation-sync.ts`, `translation-coverage.ts`,
  `translation-resource-event.ts`; the nightly branch of `scheduled-tick.ts`.
- `src/web/routes/app.translations.*` — the screens; `web/lib/translations*`
  — labels and the shared languages overview.

## Data model

All tables are shop-scoped and cascade from `shop`.

- `translation_language` — the engine's settings for one locale: `ai_enabled`,
  `auto_translate_new`, `auto_update_outdated`, `content_scope` (content
  groups), `overwrite_policy`, and `last_sync_at` / `last_successful_sync_at`.
  A locale with no row has the defaults. Removing the locale in Shopify
  deletes the row; nothing else is deleted.
- `translation_coverage` — derived counts per (locale, resource type):
  resources, fields, translated, outdated, missing, and the source characters
  behind the missing and outdated fields. Replaced whole by one read, with
  `read_at`. A cache, never an authority.
- `translation_glossary_term` — `translate` terms (source → target, for one
  locale or every locale) and `protect` terms (never translated, every locale).
  The note is for the merchant's team and is never sent to the model. No
  unique index: the glossary page refuses a rule that would contradict one
  already there (`domain/translations/glossary`, `glossaryConflict`) — same
  term, case and surrounding space aside, where one is protected, or both
  translate it for the same language or one of them for every language. Two
  translations for different languages coexist.
- `translation_source_override` — the language a resource is written in when
  it is not the primary locale, plus `detected_locale` and
  `detected_confidence`, a suggestion that decides nothing.
- `translation_ownership` — per (resource, key, locale): `owner` (`ai` or
  `manual`), `value_hash` (SHA-256 of the value as written, base64url),
  `source_digest`, `sync_id`, `written_by`, `written_at`.
- `translation_sync` — kind (`translate_store`, `language`, `automatic`,
  `resource`), mode (`missing`, `missing_outdated`, `force`), status, source
  and target locales, resource types (and ids for a resource sync), the
  estimate shown beforehand, the cursor, counts, `cancel_requested`.
  `source_locale = ""` means "the store's default", learnt on the first pass.
- `translation_sync_item` — one resource in one language inside one sync:
  `translated`, `copied`, `skipped` or `failed`, with the field count, the
  skip reasons, the error, and `trace` (§ Explainability).
- `translation_store_profile` — one row per shop: the model-written
  `profile` (`StoreProfile`), its one-line `summary`, a `version` that
  counts rebuilds, the `prompt_version` and `model` that made it, the
  normalised `vocabulary` and `sample_stats` it was built from (for drift),
  the two settings `use_store_context` and `learn_terminology`,
  `generated_at`, `checked_at`, and `generating_at` — the build lease.
- `translation_term` — per (shop, source locale, normalised term): the
  spelling, a `classification` (brand, model, product family, category,
  discipline, technical, abbreviation, material, attribute, generic), a
  `confidence`, the `origin`, the `evidence` (`{ vendor: 12, menu: 1 }`) and
  `occurrences`. Rebuilt from the store on every profile check; capped at
  600.
- `translation_memory` — per (shop, source locale, target locale, source
  key): the source and target text of a short string, its `origin` (`ai` or
  `manual`), `usage_count`, `conflicts`, and where it was last seen.
- `ai_usage` — one provider request: sync, resource, source and target
  locale, purpose (`translate`, `detect` or `profile`), `prompt_version`, model, input / cached input /
  output / total tokens, result, error, `pricing_version`,
  `estimated_cost_micros`.

## Ownership and overwrite

The rule that matters most: **a translation a person wrote or touched is never
sent back to the model unless the language's policy is `overwrite_all`.**

Each field of a resource in a target language has one state, decided by
`domain/translations/plan`:

| State      | Means                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `missing`  | Shopify holds no translation, or an empty one                                                           |
| `outdated` | Shopify holds one and marks it outdated: the source changed since                                       |
| `ai`       | This app wrote it and Shopify's value still matches the hash it recorded                                |
| `manual`   | This app wrote it as a person's edit, **or** wrote it as AI and the value has since changed — a person corrected it |
| `existing` | Shopify held it before this app; treated as human work                                                  |

Three policies per language:

- `protect_existing` — fill missing fields only.
- `update_ai_managed` (default) — fill missing fields; in `missing_outdated`
  and `force` modes also rewrite fields the AI itself wrote and nobody has
  touched. `manual` and `existing` are skipped with the reason
  `protected_manual`.
- `overwrite_all` — every field in scope may be rewritten.

An outdated translation a person wrote is still theirs: the sync item says
"protected (edited by a person)" and the merchant decides in the editor.

Saving in the editor records the field as `manual`. Emptying a field is
`translationsRemove` and forgets the ownership row. `handle` is never sent to
the AI (a translated handle changes the URL of every localised page) but can
be edited by hand. Fields whose Shopify content type is not prose (URIs, JSON,
numbers, dates, references) are never translated.

## Source language

The primary locale is the source. `translation_source_override` names another
language for a resource written in it — an article in Slovenian in an English
store — and translation then goes **directly** from that language to each
target, never through the default. When the override equals a target locale,
the original text is registered verbatim as that locale's translation (item
status `copied`, no provider request).

One function decides the source for every resource, `resolveSourceLocale`
(`domain/translations/source`): a person's override first, then the locale
Shopify reports on the resource's own translatable content when it differs
from the primary, then the primary. The decision and its reason go into the
item's trace, so the prompt never says "from Slovenian into Slovenian" for
English content without the trace showing why the source was decided as it
was. A detection nobody confirmed never decides; it is carried as
`disputedBy` when it disagrees.

Detection (`detect-source` in the editor) asks the model for a language and
records it as `detected_locale` with `detected_confidence`; the source
changes only when a person sets it. Short e-commerce strings are the hard
case — "Foil" identifies no language — so the request carries the store's
own language, its other languages and the text next to the resource (a menu
link's siblings, a product's collections), and the answer's confidence is
**capped by the length of the sample** (`confidenceCap`: under four letters
0.2, one word 0.45, three words 0.6, eight 0.8). The editor says "possibly"
or "hard to tell" rather than showing 0.99 for a three-letter label.

**Limit.** Shopify does not accept translations for the primary locale, so a
resource written in Slovenian cannot be given an English translation by this
module: its English text is the resource itself, edited in the Shopify admin.
The editor says so.

## The engine

`translateResource` (adapters/translations/engine.server.ts), per target
language of one resource:

1. `resolveSourceLocale`, then `planResource` over the fields, Shopify's
   translations, this app's ownership records, the mode and the policy.
2. **Memory first.** Each field to translate is looked up in translation
   memory for the language pair. An established answer (`reuseVerdict`) is
   written without a provider request; an uncertain one becomes a hint.
3. **One provider request** for the rest, carrying the store context, the
   resource context, the merchant's glossary, the established translations
   found in these fields and the store's terms that appear in them
   (§ Translation intelligence). The reply is JSON keyed by field number; a
   reply that leaves a field out or answers one that was not asked fails the
   whole item (`parseTranslationReply`), so a resource is never half written
   with no record of which half.
4. **Validation** (`validateTranslation`). A hard violation — broken markup,
   a lost placeholder, a changed number, a code or URL gone, a glossary rule
   ignored, ordinary words left untranslated — is sent back to the model once
   as a correction request naming each violated invariant against its field.
   If a hard violation remains the item fails and nothing is written. Soft
   violations are recorded in the trace and let the write proceed.
5. `translationsRegister` with the source digest per field; copies from the
   source ride in the same call.
6. `recordOwnership` as `ai` with the hash of each value written.
7. **Learn.** The short plain-text pairs the model produced go to memory as
   `ai`; a reused answer teaches nothing new.

Most intelligence comes from what was precomputed (profile, terms, memory,
context) and one model request; a second request happens only when
validation objected, and a third never.

Failures are per resource and language. A sync continues past a failed item.

## Translation intelligence

The translator is a localisation team, not a dictionary: it reads every
string as part of *this* store, in the place it appears, and writes what a
shopper of the target market expects to read there. No industry's vocabulary
is built in. "Wing" is a watersports discipline in a store whose menu, product
types and product titles say so, an aircraft part in a store of aviation
spares, and neither in a kitchen shop — the store's own data decides, and
the tests hold the code to that.

### Store profile

Before the first translation, and again when the store has changed, the
engine reads a bounded **snapshot** of the store from Shopify
(`readStoreSnapshot`: name and description, every menu, up to a hundred
collections with a short description, up to 250 products by title order with
vendor, type, tags and option names, the blogs — never a price, a customer or
an order), reduces it to a deterministic **sample** (`buildStoreSample`, with
the limits in `SAMPLE_LIMITS`: 120 menu labels, 60 collections, 40 vendors,
40 product types, 60 tags, 120 product titles chosen round-robin across
product types so every family is seen), and asks the model once what kind of
store this is. The answer is a strict JSON **profile** (`storeProfileSchema`):
a description, industries, audience, important terminology with a
classification and meaning, likely brands, product families, technical
vocabulary, common abbreviations and localisation notes. It is persisted with
`PROFILE_PROMPT_VERSION`, the model, and the sample's normalised vocabulary.

`ensureStoreProfile` runs before every pass and, once a day at most (once an
hour while there is no profile yet, so a missing key or a failed build never
means a snapshot read per page), re-reads the snapshot and decides whether
the profile is **stale**: none yet, an older
prompt version, more than 45 days old, a vocabulary overlap under 0.8 with the
one it was built from, or a product count that moved by more than a quarter.
Only a stale profile costs a model request; the check itself is Shopify only.
A lease on the profile row (`generating_at`, ten minutes) means two workers
never build it together and a dead build is taken over. The merchant can read
the store again from the Store context page; it never needs to be filled in.

The profile is rendered once (`renderStoreContext`, a few hundred tokens) and
carried in the system message of every translation request for the shop, so
the provider's prompt caching pays for it once. It can be switched off per
shop (`use_store_context`).

### Automatic terminology

`discoverTerminology` (`domain/translations/terminology`) reads the same
snapshot deterministically and names the words that carry weight here, each
with a classification, a confidence and its evidence: a vendor is a brand
(0.99 with several products); a product type is a product family (0.9,
rising with count); a menu label or collection title is a category (0.92 /
0.9, lifted when the tags or types corroborate it); a tag or a recurring
option value is an attribute; a token that recurs across product titles is a
model when it mixes letters and digits, an abbreviation when it is short and
upper-case, and a technical term otherwise, with confidence rising with the
number of titles it appears in. Title filler — a word in more than 60% of
titles — and bare numbers and sizes are never terms. The profile's own lists
are merged in as evidence too, so a term the data and the model agree on
nears certainty. The result is capped at 600 and written with
`replaceDiscoveredTerms`, an `INSERT … ON CONFLICT` merge that keeps ids and
forgets auto-inferred terms the store no longer has.

Terms are **evidence, never rules**. For a request, `relevantTerms` picks the
terms that appear in the fields (a field that *is* the term first, then by
confidence, at most 40) and the prompt shows each with what it is in this
store — "Wing: category (menu label, collection title, 48 product titles)".
The model chooses the target market's established form for that thing. A
brand, a model code or an abbreviation is also what lets validation accept an
unchanged answer (§ Unchanged text). Nothing protects a word globally; the
glossary is where a rule lives, and it always wins.

Confidence is used operationally — corroboration, ordering, what counts as
form-stable — and shown to a merchant only as a word (certain, likely,
probable, possible).

### Translation memory

`translation_memory` remembers how each short plain-text string (200
characters or fewer, no markup — a menu label, an option value, a product
type, a collection title; never prose) was translated into each locale.
Entries are written after every successful write with origin `ai`, and by
the editor's save with origin `manual`; an emptied field forgets its entry.
The merge rule is one SQL statement (`rememberTranslations`): a person's
translation replaces the machine's and is never replaced by it; the machine's
answer for a string remembered the same way counts one more use; remembered
differently, the earlier answer stands and the disagreement is counted — the
point is that "Wing" is never "Wing" on one product and "Krilo" on another.

For a request the engine looks up every field as a whole and every phrase of
up to four words inside it (`lookupKeys`, capped at 400 keys, one query).
An exact match is **reused** without a model request when
`reuseVerdict` says so: a person's translation always; the machine's when it
was used more than once or was made for the same kind of content (a menu
label for a menu label); and never when the field is prose or over 120
characters, or when a glossary rule the entry does not honour has since been
added. Otherwise the match is a hint. Phrases found inside the fields are
hints too (`selectMemoryHints`, a person's first, then by use, at most 30),
shown as ESTABLISHED TRANSLATIONS the model must follow.

Memory is per exact locale: `de-AT` and `de` are different entries, and a
lookup for `de-AT` consults `["de-AT", "de"]` with the most specific winning
(`localeChain`). So a market can settle on its own word without touching the
language's.

### Resource context

Each request carries a compact block saying where the text sits
(`renderResourceContext`), built by `ContextSource` from a few reads per
page: the menus once per pass, and one `nodes` query for the page's products,
collections, articles, metafields and options. A **menu link** is placed in
its menu with its parents, every label at its level in order, its sub-items
and what it links to — so "Wing" is read beside "Windsurf · Foil · SUP ·
Kite". A **product** carries its vendor, type, collections, tags and options;
a **collection** its product count and a few product titles; an **article**
its blog; a **metafield** its owner and definition name and description. A
product option carries its values; option values carry nothing beyond the
store's terminology, because the Admin API does not point them back at their
product. A resource nothing is known about is translated with the store
context and terminology alone.

The fields of one resource are translated in one request, numbered, so a
title, its description and its SEO fields understand each other.

### The prompt

`buildTranslationMessages` (`domain/translations/prompt`,
`TRANSLATION_PROMPT_VERSION`) writes a system message that is the same for
every request of a shop and language pair — the specialist's brief (read
from context; when a word has an everyday and a specialised meaning infer
which from the store, the resource and the terminology; keep an international
term the trade keeps and use the market's term where it has one; localise
ordinary e-commerce language and never leave it in the source language; keep
brands, codes, numbers, URLs, placeholders, markup and rich-text structure;
never invent claims), the store's name, the STORE CONTEXT and the answer
format — and a user message with, in order of authority, the RESOURCE
CONTEXT, the merchant's TERMINOLOGY OVERRIDES (absolute), the ESTABLISHED
TRANSLATIONS from memory, the STORE TERMINOLOGY notes and the FIELDS. Nothing
about any industry is in the system message unless this store's profile put
it there. `buildCorrectionMessages` appends the model's previous answer and
each violated invariant against its field number.

### Validation

`validateTranslation` (`domain/translations/validate`) runs before every
write. Hard: a field missing or empty; placeholders (`{{x}}`, `{0}`, `%s`,
`${x}`, `[[x]]`) not identical; the HTML tag skeleton (tags, order, nesting,
`href`/`src`) changed; a rich-text document's structure changed or lost; a URL
or e-mail gone; a source number missing (digits compared with separators
removed, so `5.0` → `5,0` passes); a model code or identifier missing
(letters-and-digits tokens compared without separators and case); a protected
glossary term not present exactly; a translate-as rule ignored in a field of
three words or fewer; ordinary words left untranslated (§ Unchanged text).
Soft: a translate-as rule not found inside longer prose (it may inflect); a
single ordinary word unchanged; a translation under a quarter or over four
times the source's length.

### Unchanged text

An answer equal to its source is legitimate for a brand, a code, an
abbreviation, a term memory has seen kept, or a string of those and numbers:
`Wing → Wing`, `SUP → SUP`, `Duotone Wing Unit 4.0 → Duotone Wing Unit 4.0`.
It is a translation that did not happen when two or more ordinary words came
back as they were between different languages: `All Products → All Products`
for Slovenian is refused and corrected. One ordinary word unchanged is a
doubt only — it may be the market's established form — and between regional
variants of one language nothing is doubted.

### Explainability

Every sync item carries a `trace` (`TranslationTrace`): the prompt version,
the profile version, the source locale with the reason it was decided and any
detection that disagreed, the target, the kind of resource context, the
model, the number of provider requests, the fields answered from memory, the
memory entry ids shown, the glossary hits, the term ids shown, and each
attempt's validation result. No prompt text and no content is stored. The
sync page shows it in one subdued line per item. `ai_usage` rows carry the
`prompt_version` too.

### Terminology overrides

The glossary keeps its table and its two kinds of rule, and is presented as
**Terminology overrides**: a store translates well with none, and a rule is
for the word a business wants exactly so. In the prompt the rules come first
and are named as absolute; validation enforces them (§ Validation); memory
never reuses an answer a rule contradicts. From Store context a learnt term
opens the dialog with the term filled in ("Override"), and an established
translation opens it with the term, the translation and the language
("Make it a rule"), so an override is one confirmation away from the thing
it overrides (`glossaryPrefill`, `glossaryUrl` in `web/lib/translations`).

### Concurrency and scope

Everything learnt is scoped by shop, source locale and, for memory, target
locale. Terms and memory are written with single-statement `INSERT … ON
CONFLICT DO UPDATE` merges, so pages of one sync running on two workers, or
two syncs, never lose or corrupt each other's learning; the profile build is
guarded by a lease. All of it cascades from `shop` on uninstall and redaction.

## The provider

`adapters/ai/openai.server.ts` reads `OPENAI_API_KEY` and
`OPENAI_TRANSLATION_MODEL` (default `gpt-4.1-mini`) from the environment on
each call. The key is never returned, stored or logged; a deployment without
one is one where `isConfigured()` is false and every page says so, while
languages can still be managed and translations edited by hand.

Three purposes go through it: `translate` (one request per resource and
language, plus at most one correction), `detect` (the editor's language
suggestion) and `profile` (one per shop, rebuilt rarely). Chat completions,
`response_format: json_object`, temperature 0.2 (0.1 for the profile), a
120-second timeout, up to three attempts on 429 and 5xx. **Every attempt that
reaches the provider is one `ai_usage` row** — success, failure with usage,
retry — priced under `PRICING_VERSION` at the time. A network failure is a
row with zero tokens, so the ledger shows the request was made. Skipped
translations never reach the provider and never appear.

The AI usage page reads that ledger for one period at a time, measured in
UTC: totals (`usageTotals`), a trend (`usageTrend`, SQL `date_trunc` by day
for a month and by month for all time, gaps filled in `web/lib/usage`) and
the four breakdowns (`usageBreakdown`), each row with its share of the
period's estimated cost (`domain/translations/usage`). A breakdown by sync
names the sync as its page does and links to it; a request outside any sync
is language detection.

## Coverage and estimates

`translation-coverage` reads every translatable resource of every supported
type once, counting per (locale, type) with the same field test the planner
uses, and replaces the cache. It runs after a sync completes, on request from
the Languages and Translate store pages (throttled), and nightly.

"Translate store" estimates from that cache in the browser as the choices
change: fields and source characters for the mode → tokens at about 3.5
characters a token plus a fixed overhead per request (700 tokens: the brief,
the store and resource context and the terminology, most of it served from
the provider's prompt cache) → cost from the pricing table. The estimate is stored on the sync it started so the sync page can
show estimated against actual. A model not in the table yields "Not priced";
tokens are still recorded.

## Jobs

| Queue                        | Trigger                                                        | Does                                                                                                    |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `translation-sync`           | `startSync` from a page or the nightly tick; itself, per page  | One page (10 resources) of the current type through the engine, records items, advances cursor, re-enqueues; checks for cancel between pages; completes, marks the languages' last successful sync, asks for coverage |
| `translation-coverage`       | After a sync; page buttons; nightly per shop                   | The store-wide count, replaced whole                                                                    |
| `translation-resource-event` | `products/create`, `products/update` webhooks                  | The product, inline, for every language with automatic translation on (one `resource` sync per mode)   |
| `translation-profile`        | Store context page: Build now / Read the store again           | `ensureStoreProfile` with `force`: re-reads the snapshot, rebuilds the profile, rediscovers the terms   |

`translation-sync` and the others run under `policy: "short"` so the singleton
key per sync holds; the cursor moves only over recorded work, so a retried
pass repeats a page rather than skipping one, and every write to Shopify is a
replace. A sync untouched for six hours is marked failed by the quarter-hourly
tick. A sync that finished with failed fields raises one `translation_failed`
exception linking to the syncs page.

The nightly tick starts one `automatic` sync per shop and mode over the
content scope of every language with automatic translation on — which is what
reaches collections, pages, articles, navigation and metafields, none of which
have a webhook here.

## Screens

```text
Translations        /app/translations                       Languages: Shopify state, AI state, coverage, needs work, last sync
  Add language      /app/translations/add                   one card: language picker · Shopify visibility · AI translation · existing content; a sidebar with the summary, the scope estimate and the one button
  Language          /app/translations/languages/:locale     In Shopify (publish / unpublish, markets, remove) · AI translation · Coverage · Translate · Recent syncs
  Editor            /app/translations/editor                workspace: a rail of resources beside the one open; each field's source beside its translation; source language; translate now
  Translate store   /app/translations/translate             source · languages · content · mode · estimate · start
  Syncs             /app/translations/syncs, /:syncId       list; one sync with result, usage, every item and its reason and trace; stop
  Store context     /app/translations/context               what the AI knows about the store; two switches; the learnt terms; established translations per language; forget; read the store again
  Overrides         /app/translations/glossary              Terminology overrides (the glossary): one table of rules, searchable, filtered by rule and language; add / edit in a dialog, prefilled when opened from Store context; remove behind a confirmation
  AI usage          /app/translations/usage                 one period (today / this month, the default / last 30 days / all time): cost, tokens, requests, resources; cost by day or month; by language, content, model, sync
```

The editor is one screen, not a list and a page. The rail on the left —
language, content, status, search, then a page of resources — stays put
while the resource on the right is edited, and choosing another resource
swaps the right side without leaving the page: the route loader reads the
rail, and the pane fetches its resource from the same loader with
`part=resource`; `shouldRevalidate` keeps a change of resource from
re-reading the rail, while every save and translation revalidates both. The
address carries the open resource so a reload or a bookmark returns to it.
Below about 760px of width the two take turns, the rail until something is
chosen and the pane with a way back after. The pane's columns are capped so
prose is never stretched across a wide window; a longer window is for the
rail beside them. Unsaved edits hold a change of resource behind the save
bar's own leave confirmation.

### Languages

A locale is named the same way on every screen (`domain/translations/
languages`, `LanguageLabel`): a flag, Shopify's English name, the
language's own name for itself when it differs, and the locale. Nothing
about a language is hand-typed: the native name comes from
`Intl.DisplayNames` and the region from `Intl.Locale` — the locale's own
region (`de-AT`) or, for a bare language, CLDR's likely subtag (`de` →
Germany), and none where that is not a country (Esperanto). The flag
(`LocaleFlag`) is one of about a hundred `country-flag-icons` SVGs compiled
into the bundle, one chunk shared by the screens that show it; a region
outside the set gets a globe rather than a wrong flag. Flags are decoration:
the name is always written out.

Add language is one card and a sidebar. The picker (`LanguagePicker`) is a
field that opens a floating, scrolling list with a search box — Polaris has
no combobox, so it is `s-clickable`, `s-popover` and `s-search-field` with
a listbox's keyboard on top — searching English name, native name, code,
locale and country, accents and case aside, best match first
(`searchLanguages`). Languages the store already has are listed under
"Already added" and open their own page instead of being chosen twice. The
booleans are switches; the two automatic rows are disabled, not hidden,
while AI translation is off. A language Shopify has just enabled holds no
translations, so existing content is a two-way choice — translate it now or
not — and "now" is a `missing` sync. When it is chosen, the sidebar shows
the scope from the coverage cache: the source side of any counted locale
with every field missing (`coverageForNewLocale`), priced like any other
run; with nothing counted it says so rather than guessing. The one button is
in the sidebar with the reason it is closed; success is the language's page
with a toast (`?added=1`).

Every Shopify mutation shows what Shopify answered, not what was asked.
Removing a language explains that Shopify deletes its translations, and
Shopify decides whether the removal is allowed. Retranslate everything and
Stop are behind confirmations.

## Required scopes

`read_locales`, `write_locales` (languages); `read_translations`,
`write_translations` (content); `read_markets` (which markets a language is
served in); `read_content`, `read_online_store_pages`,
`read_online_store_navigation` (the editor's title search for articles,
blogs, pages and menus only). Added 2026-09-20; the merchant approves them on
next open. Until then the pages say the app has not been granted permission.

## Known limits

- Only products have a webhook; other content is translated automatically
  nightly.
- Product options and option values do not point back at their product in
  the Admin API, so they are translated with their own values and the
  store's terminology, not their product's title.
- Terminology discovery runs on the snapshot's product sample (250 products
  by title), not the whole catalogue; the profile's own reading of the store
  and the terms that recur in navigation, collections, types and tags cover
  the rest.
- The store profile is a model's reading and can be wrong. The Store context
  page shows it, a wrong term can be forgotten there, and a glossary rule
  overrides anything learnt.
- The primary locale's own text cannot be written (see Source language).
- Theme, email template and app-embed strings are out of scope: their keys are
  dynamic and their strings are the theme's.
- The editor's status filter applies within the page it read (25 resources);
  Shopify's `translatableResources` has no filter of its own.
- Cost is estimated from list prices in `domain/translations/pricing.ts`; the
  provider reports tokens, not money. Update the table and bump
  `PRICING_VERSION` when prices change.

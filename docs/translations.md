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
  webhooks/products/{create,update} ──▶ translation-resource-event ──▶ one collecting `resource` sync ──▶ translation-sync
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
  groups), `overwrite_policy`, `keep_original` (fields kept in the source
  language, § Kept in the original language), and `last_sync_at` / `last_successful_sync_at`.
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
- `translation_failure` — per (resource, locale): the last failure's
  `source_key` (hash of the keys and source digests sent), consecutive
  `attempts`, `last_error`, `failed_at`, `retry_after` (null: not until the
  source changes). § Failures.
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

### Kept in the original language

A language may keep some fields in the source language
(`TranslationLanguage.keepOriginal`, `KEEP_ORIGINAL` in
`domain/translations/types`): product names, product types, product option
names and values, collection names. The planner skips them with the reason
`kept_original` in every mode, `force` included, and whoever asks — a sync, a
webhook or the editor's "translate this". Shoppers see the original.
Checking one removes what the AI wrote for the field (§ Switched off); a
person's translation stays until they change or delete it. Neither coverage
nor the editor counts a kept field — the editor badges it "Kept in
original" — so the language does not look forever incomplete. Set on the
language page under AI translation.

### Switched off

Saving a language's settings with a content group taken out of "What gets
translated", or a field newly kept in the original, removes the AI's
translations of it (`removalScope` in `domain/translations/types`): the
group's types whole, the kept field's keys only. Only a field whose state is
`ai` — this app wrote it and Shopify's value still matches the hash — goes;
`manual` and `existing` stay. The work is `translation-remove` with a
`scope`, one job per shop, language and scope; the event is
`translation_language.ai_translations_removed` and coverage is counted
again at the end. Putting content back in scope removes nothing and
translates nothing until the next sync.

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
each violated invariant against its field number. The reply is
`{"translations": {...}, "already_in_target": [...]}`: the second list
names the fields the model returned unchanged because they are already
written in the target language (§ Unchanged text). It is optional, and a
number in it that names no field is ignored.

### Validation

`validateTranslation` (`domain/translations/validate`) runs before every
write. Hard: a field missing or empty; placeholders (`{{x}}`, `{0}`, `%s`,
`${x}`, `[[x]]`) not identical; the HTML tag skeleton (tags, order, nesting,
`href`/`src`) changed (§ HTML structure); a rich-text document's structure changed or lost; a URL
or e-mail gone; a source number missing (digits compared with separators
removed, so `5.0` → `5,0` passes); a model code or identifier missing
(letters-and-digits tokens compared without separators and case); a protected
glossary term not present exactly; a translate-as rule ignored in a field of
three words or fewer; ordinary words left untranslated (§ Unchanged text).
Soft: a translate-as rule not found inside longer prose (it may inflect); a
single ordinary word unchanged; a translation under a quarter or over four
times the source's length.

`VALIDATION_VERSION` is bumped whenever a rule changes what is accepted;
with `TRANSLATION_PROMPT_VERSION` it is part of a remembered failure's key
(§ Failures).

### HTML structure

`htmlSkeleton` (`domain/translations/text`) reads both the source and the
answer the lenient way a browser reads supplier markup, then compares the
two element trees. Supplier descriptions (Unifiber, Patrik exports) leave
`<p>`, `<li>`, `<td>` and `<tr>` unclosed, carry Word comments, empty styled
spans and `<p>&nbsp;</p>` spacers; a model writing the answer closes and
tidies them. So these are the same skeleton:

- `<br>`, `<br/>`, `<br />` (void elements have no children whichever way
  they are written); `<b>`/`<strong>` and `<i>`/`<em>`; tag-name case;
- an unclosed `<p>`, `<li>`, `<dt>`/`<dd>`, `<td>`/`<th>`, `<tr>`,
  `<thead>`/`<tbody>`/`<tfoot>`, `<option>` closed where a browser would
  close it, a stray end tag ignored, anything left open closed at the end;
- comments, doctype and processing instructions;
- attributes other than `href` and `src`, their order and quoting, and
  `&amp;` versus `&` in a link;
- an element that shows nothing — no text, no image, table, list or link
  under it (an empty `<span style>`, `<p>&nbsp;</p>`, `<p><br></p>`).

Still hard: an element, a list item, a cell, a link or an image added,
dropped, merged or moved, a changed `href` or `src`, plain text wrapped in
new markup. The correction request says where the two first part ("after
`<li></li>` the source has `<li>` where your answer has `</ul>`"). URLs in
text are compared with `&amp;` read as `&` too.

### Unchanged text

An answer equal to its source is legitimate for a brand, a code, an
abbreviation, a term memory has seen kept, or a string of those and numbers:
`Wing → Wing`, `SUP → SUP`, `Duotone Wing Unit 4.0 → Duotone Wing Unit 4.0`.
It is a translation that did not happen when two or more ordinary words came
back as they were between different languages: `All Products → All Products`
for Slovenian is refused and corrected. One ordinary word unchanged is a
doubt only — it may be the market's established form — and between regional
variants of one language nothing is doubted.

A word's shape makes it stable too, with no term needed: a short all-caps
abbreviation (`RPM`, `SL`, `HD`, `SDM`; not inside a heading written all in
capitals), a word with a capital after a lower-case letter (`iWindsurf`), a
unit symbol (`cm`, `kg`, `m²`, …). So `Unifiber - RPM iWindsurf 280 (SL)`,
`HD SDM C75` and a spec line of model names, numbers and units pass as they
are.

**Already in the target language.** A store's default-language field often
holds copy written in the target language (a Slovenian description in an
English store). The prompt tells the model to return such a field unchanged
and list it in `already_in_target`; an unchanged field it listed is
accepted (a soft `unchanged` in the trace) and written as the translation,
so the next pass finds it current. The claim is taken for prose — four or
more words — only: a short label such as `All Products` returned unchanged
is still refused whatever the model says. An unchanged answer the model did
not claim is refused as before.

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

## AI usage

The AI usage page reads that ledger for one period at a time, measured in
UTC (the clock every row was stamped in). The period is a half-open span
(`web/lib/usage`: today, last 7 or 30 days, this month, the previous month,
all time, or a custom span of two inclusive dates), carried in the address
as `?period=…&from=…&to=…`; the default is the last thirty days. Every read
takes a `UsageScope` — the span, or one sync, or the rows outside any sync —
so the page and the per-sync dialog are the same sums over different rows:

- `usageTotals`: requests, failed requests, input / cached / output / total
  tokens, estimated cost, unpriced requests and distinct resources, one SQL
  aggregate.
- `usageTrend`: the same sums per hour, day or month (`date_trunc`), the
  bucket chosen from the span's length (`trendBucketFor`), gaps filled in
  `web/lib/usage` so an idle day is an empty slot rather than a missing bar.
- `usageBreakdown`: grouped by target locale, content type or model.
- `usageBySync`: grouped by the request's own `sync_id` and left-joined to
  the sync, sorted, filtered by language or mode, and paged in one query
  (the group count comes back as a window function). A request outside any
  sync — language detection — is one row of its own; a deleted sync's
  requests are still counted.
- `usageRequests`: the rows one by one, newest first, for the dialog.

Each breakdown row carries its share of the period's estimated cost, or of
its tokens when nothing in the period is priced (`sharePercent`); the page
says which. The sync ledger is sorted and paged by the server through the
address (`sort`, `dir`, `page`, `locale`, `mode`), the way the orders index
is; a row opens a dialog that reads the sync's own totals, breakdowns and
last fifty requests from the same loader (`?part=sync&sync=<id>`, or
`sync=none` for the rows outside any sync). Cost is written to two places
everywhere except in the dialog's request list, where the exact sub-cent
figure is shown (`web/lib/usage-format`).

The chart is inline SVG (`web/components/usage-chart`), drawn at the card's
measured width and a fixed height, switchable between cost, tokens — stacked
as input, cached input and output — and requests, with the bucket's figures
in a tooltip that the pointer or the arrow keys move.

## Coverage and estimates

`translation-coverage` counts every translatable resource of every supported
type, per (locale, type), with the same field test the planner uses — and
leaves out the fields a language keeps in the original language.

For a language with AI translation on, the languages overview and the
language page's headline count only the content in its scope ("What gets
translated"): a group taken out — metafields, say — is left alone, not
owed, so its missing and outdated fields do not keep the language looking
unfinished. The language page still lists the group, marked "Not
translated". A language with AI off counts everything.

A count runs in **chunks**: each pass reads ten pages of fifty resources of
the current type and re-enqueues itself with the cursor and that type's
counts so far in the job data (`readCoverageChunk`). A type read whole
replaces its own rows in the cache (`replaceCoverageForType`), so the tables
fill in as the count goes and a reader never sees half a type. It used to be
one job over the whole store, which on a large catalogue outlived its expiry
and started again, with nothing to show meanwhile.

Its progress is one row per shop, `translation_coverage_scan`: a run id,
kinds of content done out of the total, the type being read, resources read,
the resources the previous count saw (the denominator of the percentage; on
a first count the kinds of content are), the types Shopify would not read,
and a heartbeat every pass moves. `requestCoverageRefresh` starts a count
under a new run id unless one is running and moving — a pass of a replaced
run stops — and a count whose heartbeat is fifteen minutes old has stopped
and is replaced by the next request. `describeCoverageScan` turns the row
into what the Languages overview and a language's sidebar show
(`CoverageCount`): a progress bar with what is being read while counting
(the pages poll), "The count stopped" with Count again, or the content that
could not be read.

A count starts when a sync a person or the night started completes, when a
language's translations are deleted, from the page buttons, and nightly.
**Not** after a sync collected from product webhooks: those complete all day,
and recounting the store after each one kept a count queued for ever. A type
Shopify will not read costs that type, not the count; the count still ends,
naming it.

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
| `translation-coverage`       | `requestCoverageRefresh`: a person's or the nightly sync completing, delete all, page buttons, nightly; itself, per chunk | Ten pages of the current type; a finished type replaces its rows; moves the progress row; re-enqueues with cursor and carried counts |
| `translation-resource-event` | `products/create`, `products/update` webhooks                  | Plans the product for every language with automatic translation on and puts it on the collecting `resource` sync (one per mode) only where something would be written; drops the echo of this app's own write |
| `translation-profile`        | Store context page: Build now / Read the store again           | `ensureStoreProfile` with `force`: re-reads the snapshot, rebuilds the profile, rediscovers the terms   |
| `translation-remove`         | Language page: Delete all translations, or saving settings that switch content off; itself, per page | One page (50 resources) of the current type: `translationsRemove` for every key translated in the language — or, with a `scope`, only the scope's keys the AI wrote and nobody touched (§ Switched off) — forgets ownership and remembered failures; re-enqueues with its cursor in the job data; asks for coverage at the end |

`translation-sync` and the others run under `policy: "short"` so the singleton
key per sync holds; the cursor moves only over recorded work, so a retried
pass repeats a page rather than skipping one, and every write to Shopify is a
replace. A sync untouched for six hours is marked failed by the quarter-hourly
tick. A sync that could not run raises one `translation_failed` exception
for the sync; failed fields are raised per resource (§ Failures).

The nightly tick starts one `automatic` sync per shop and mode over the
content scope of every language with automatic translation on — which is what
reaches collections, pages, articles, navigation and metafields, none of which
have a webhook here.

### Automatic translation

Shopify sends `products/update` once per product, and a CSV import, a bulk
edit, a stock sync or a sale campaign sends hundreds in a minute. One sync
per webhook was a syncs page nobody could read, so changed products are
**collected** (`collectChangedResource`): the event handler appends the
product to the queued `resource` sync with the same languages and mode
(`appendToCollectingSync`, no person behind it) or opens one, whose job is
sent once, `COLLECT_WINDOW_SECONDS` (two minutes) after opening, under the
sync's singleton key. `beginSyncPass` claims the sync before it reads it,
so the pass sees every product that arrived; a sync that has started takes
no more, and the next change opens the next one. A `resource` sync pages
through its list ten at a time, the cursor's `after` being the offset.

Most of these webhooks change no text at all: a stock level, a price or a
metafield (a metafield change sends `products/update` too, and metafields
are their own resources, in their own content group). So before collecting,
the handler reads the product's translatable content and plans it for each
automatic language as the sync would (`automaticWorkFor` in the engine:
kept fields, overwrite policy, mode, and a failure still backing off all
apply). A product is collected only for the languages where something would
be written; one whose text did not change opens no sync and costs one
Shopify read.

Two things keep the list honest. The webhook Shopify sends when *this app*
registers a product's translations is the echo of that write: a product the
engine wrote in the last fifteen minutes (`wroteResourceSince`, from the
ownership record) is dropped, or every store-wide sync would be followed by
a sync of everything it touched. And a collected sync that finds nothing to
translate — the change was a price or a stock level — is deleted at
completion rather than recorded (`translation_sync.nothing_to_do` in the
event log), since it made no provider request and says nothing a person
needs. The syncs, language and usage pages name a collected sync by its
size ("12 changed products", `syncName`); "One resource" is the editor's.

### Failures

A resource that fails in a language — the reply left a field out, was cut
short, broke an invariant twice, or Shopify refused the write — used to be
sent again by every automatic pass. With `products/update` arriving on
every stock sync, that was the same failed product paid for many times a
day, often twice (translation and correction) and up to three times per
request on timeouts. So the failure is remembered (`translation_failure`,
one row per resource and language) with a hash of the keys and source
digests that were sent. Automatic work — the nightly sync and collected
webhook syncs, i.e. `requestedBy` is null — skips a resource whose remembered
failure matches the current source, with the reason `failed_before`, for 1,
then 3, then 7 days after consecutive failures, and after the fourth not at
all until the source changes. A sync a person started and the editor always
try. A success, and **Delete all translations**, forget the failure.

The key also carries `TRANSLATION_PROMPT_VERSION` and `VALIDATION_VERSION`.
A release that changes the prompt or the rules therefore makes every
remembered failure stale, given-up ones included: the next automatic pass
(the nightly sync for every language with automatic translation on, or the
next webhook for a product) tries each failed resource once more. One that
now translates is written, its failure forgotten and its Needs attention
row closed by the sync job; one that still fails updates its row with the
new reason and starts the back-off again from 1 day. A language without
automatic translation is retried by a person's sync (Translate missing).

A failure is shown on Needs attention as **one row per resource**
(`translation_failed`, dedupe key `translation-resource:<id>`,
`domain/translations/failure-notice`): the resource's name, linking to it
in the editor in the language that failed, the languages and the reason,
and a link to the sync. Failing again updates the same row; the sync job
closes it (resolved by `app`) once the resource translates and no failure
is remembered for it. It used to be one row per sync — "1 fields could not
be translated in a sync" — and collected webhook syncs made thousands that
named nothing. `recheck-exceptions` rewrites those older rows per resource
in batches (`convertLegacyTranslationExceptions`), skipping resources that
have translated since, and closes them.

### Delete all translations

The language page's Translate card deletes every translation in the
language from Shopify, AI and human alike, through `translation-remove`.
The language stays. Automatic translation for the language is switched off
in the same action, or the nightly sync would fill it again; it is refused
while a sync for the language is running, and the page shows the job's
state while it works. Removing the language itself (In Shopify card) is
the other way to lose every translation, and takes the language with it.

## Screens

```text
Translations        /app/translations                       Languages: Shopify state, AI state, coverage, needs work, last sync
  Add language      /app/translations/add                   one card: language picker · Shopify visibility · AI translation · existing content; a sidebar with the summary, the scope estimate and the one button
  Language          /app/translations/languages/:locale     In Shopify (publish / unpublish, markets, remove) · AI translation · Coverage · Translate · Recent syncs
  Editor            /app/translations/editor                index: kind tabs (All, each group; Navigation is a tree of menus and their items) · language · search · status, then resources — picture, name, one line under it, what needs a person; a row opens the resource in a dialog: each field's source beside its translation, source language, translate now, save
  Translate store   /app/translations/translate             source · languages · content · mode · estimate · start
  Syncs             /app/translations/syncs, /:syncId       list; one sync with result, usage, every item and its reason and trace; stop
  Store context     /app/translations/context               four tabs (`?tab=`): Overview — counts, the two switches, a line of the profile; Terminology — learnt terms and established translations per language, 20 a page, a row opens its detail, tick rows to forget several; Product knowledge — the profile's brands, families, abbreviations, meanings and vocabulary as one filtered table; AI instructions — what the AI is told in full, the switches explained; read the store again
  Overrides         /app/translations/glossary              Terminology overrides (the glossary): one table of rules, searchable, filtered by rule and language; add / edit in a dialog, prefilled when opened from Store context; remove behind a confirmation
  AI usage          /app/translations/usage                 one period (last 30 days by default; today, 7 days, this or the previous month, all time, custom): five figures; cost, tokens or requests over time; by content type, language, model; the sync ledger, sorted, filtered and paged, each sync opening its own usage in a dialog
```

Every page is `s-page inlineSize="large"`. The editor's index reads each
page's cards (`readResourceCards`: a product's picture, type and draft or
archived status; a collection's picture and product count; an article's
picture and blog) in one `nodes` request beside the resources themselves,
so a row looks the way the admin's own product index does.

The editor is an index with a dialog over it, not a list and a page. The
index is the page: a row of tabs for the kinds of content — All, then each
content group, a group with several kinds naming the kind in the bar — then
the language, the search across the width and the status filter in the bar
above the columns, then a page of resources as the admin's own product
index draws them — picture, name, one line under it, what the translation
needs, who wrote its fields. Shopify offers no query on
`translatableResources`, so a status filter is applied here: with one on,
the loader reads forward a hundred at a time until it has a page of matches
or has read six hundred, and pages on from the last match (each resource's
own cursor) so nothing between is skipped; the footer says how many were
read. "All" is an overview — up to eight of every kind, searched across the
kinds that can be searched, no paging — and a kind is chosen to page
through it. **Navigation is a tree**, not two flat lists: every menu with
its items nested under it, read whole (`adapters/shopify/navigation`,
`readNavigationTree`), each branch opening and closing, and a search or a
state filter keeping the menus above a match so a match is never shown
without saying which menu it is in. A menu's title is a `MENU` resource named by
the menu's own id, so those are read by id. An item's is a `LINK` one, and
how that id relates to the `MenuItem` id the navigation query returns is
not in Shopify's reference (`Menu` and `Link` have `translations`;
`MenuItem` has none). Asking about a `MenuItem` id is not answered with
silence but with a GraphQL error — which is what turned this tab into an
Application Error the first time — so nothing is asked for by a guessed id:
the `LINK` resources are **listed** with the same documented query the sync
job uses and matched to the tree by the number in their ids. An item
nothing matches is listed as having nothing to translate rather than
pointed at a resource that may not be its own. Every read here fails soft
and logs: a tree whose translations could not be read is still a tree worth
seeing, and one tab must never take the page down. The queries are checked
against the schema (`read_online_store_navigation`, `read_translations`). Choosing a row opens
the resource in a dialog with every field's source beside its translation,
the AI's buttons, the previous and next resource, and Save in the footer;
the route loader reads the index, and the dialog fetches its resource from
the same loader with `part=resource`; `shouldRevalidate` keeps a change of
resource from re-reading the index, while every save and translation
revalidates both. The address carries the open resource so a reload or a
bookmark returns to it; closing the dialog takes it out of the address but
keeps what was typed for that resource while the page lives. Unsaved edits
close the way to the previous or next resource and to the AI until they are
saved or discarded, so nothing is walked away from by accident. A field's
source box is as tall as its text and never stretched to the field beside
it.

**A field that holds HTML is edited as prose.** A description is rendered
on both sides — the source read rather than decoded, the translation in a
`contenteditable` with a small toolbar (undo and redo, then bold, italic,
heading, paragraph, the two lists, a link row, clear formatting) — and an **HTML** view shows
the source itself for anyone who wants the tags. A field with an embed or a
table in it opens as HTML and stays there, because rich text editing
rewrites what it is given and an `<iframe>` does not survive that; the
switch says so. The editor is built from `contenteditable` and Polaris
buttons rather than a rich text framework, which would be a second design
system and a large dependency for bold and a list (docs/BUILD_SPEC.md
section 2.6); `document.execCommand` is what the platform offers without
one — including undo and redo, which go through the field's own history, so
the buttons and the keyboard's own shortcuts step back through typing and
toolbar commands alike. What the browser writes is normalised back into the
document's own vocabulary (`<b>` → `<strong>`), and the field is compared
to the *normalised* markup before it is ever rewritten: rewriting it would
clear the browser's undo history, which is the history those buttons use. A field's two columns are built the same way — one header line and one
box, the toolbar inside the box rather than above it — so the source and
its translation start on the same line and end on the same line; the strip
over the source carries a copy of it into the translation, which Discard
takes back like any other edit. A long field can take the dialog to itself
(**Open the full editor**) and give it back, so a description is edited at
the height of the screen rather than a fifth of it. Nothing is rendered or
pasted unsanitised:
`web/lib/html` is an allowlist of tags and attributes with no dependency
and no DOM, so a description that once had a script or a handler in it
cannot run inside the admin, and a paste from a word processor brings its
words rather than its markup.

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

A language's page is a form and a sidebar (`PageColumns`). The main column
holds what changes the language: AI translation (switches, then what gets
translated and what stays in the original language as checkbox grids of up
to three columns, the overwrite policy, the glossary), the translate
actions, recent syncs, and finally markets with the two destructive rows —
delete all translations, remove language. The sticky sidebar states where
the language stands: its label, published or not with the one button that
changes it, and coverage as one stacked bar (translated, outdated, missing)
with a bar per content group linking to the editor. Two equal cards side by
side left half the page empty beside the tall settings card.

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
  nightly. A product edited within fifteen minutes of the engine writing it
  is taken for the engine's own echo and waits for the nightly sync too.
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
- "Already in the target language" is the model's word for a prose field
  that came back unchanged (§ Unchanged text); nothing checks the language
  deterministically. A model that wrongly claims it for an untranslated
  description leaves that description in the source language. Short labels
  are never accepted on the claim alone. HTML is sent to the model as it
  is, not in a protected form; the lenient comparison (§ HTML structure)
  absorbs the tidying models do, and real changes are corrected once.
- Theme, email template and app-embed strings are out of scope: their keys are
  dynamic and their strings are the theme's.
- The editor's status filter applies within the page it read (25 resources);
  Shopify's `translatableResources` has no filter of its own.
- Cost is estimated from list prices in `domain/translations/pricing.ts`; the
  provider reports tokens, not money. Update the table and bump
  `PRICING_VERSION` when prices change.

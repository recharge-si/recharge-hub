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

**Two vocabularies, kept apart on every screen.** "Shopify" says whether a
language is the default, published or unpublished. "AI translation" says
whether this app works on it and how. A language is never shown as published
because AI is on, and never as "on" because it is published. Nothing about a
locale's own state is stored here: `shopLocales` is read on every page that
shows it.

**No copy of the catalogue.** A page of translatable resources is read, acted
on and forgotten. The only per-resource rows this app keeps are the source
override and the ownership record, both of which are about what this app
decided or did, not about the content.

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
  estimates (`estimate`), coverage counting (`coverage`). No clock, no Shopify,
  no OpenAI.
- `src/adapters/shopify/locales.ts` — `shopLocales`, `availableLocales`,
  `shopLocaleEnable` / `Update` / `Disable`, `markets` with web presences.
  `src/adapters/shopify/translations.ts` — `translatableResources` (one aliased
  `translations(locale:)` per target locale), `translatableResourcesByIds`,
  `translationsRegister`, `translationsRemove`, title search.
- `src/adapters/ai/openai.server.ts` — **the one provider path.** Every request
  to OpenAI goes through `callModel`, and every attempt that reaches the
  provider is an `ai_usage` row.
- `src/adapters/translations/engine.server.ts` — plan → provider → register →
  record ownership, for one resource into its target languages;
  `coverage.server.ts` — the store-wide count; `syncs.server.ts` — create a
  sync and queue it; `inline.server.ts` — one resource, now, as a sync.
- `src/adapters/db/repositories/translations.server.ts` — every table below,
  tenant-scoped.
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
- `translation_source_override` — the language a resource is written in when
  it is not the primary locale, plus `detected_locale`, a suggestion that
  decides nothing.
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
  skip reasons and the error.
- `ai_usage` — one provider request: sync, resource, source and target
  locale, purpose (`translate` or `detect`), model, input / cached input /
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

Detection (`detect-source` in the editor) asks the model for a language and
records it as `detected_locale`; the source changes only when a person sets it.

**Limit.** Shopify does not accept translations for the primary locale, so a
resource written in Slovenian cannot be given an English translation by this
module: its English text is the resource itself, edited in the Shopify admin.
The editor says so.

## The engine

`translateResource` (adapters/translations/engine.server.ts), per target
language of one resource:

1. `planResource` over the fields, Shopify's translations, this app's
   ownership records, the mode and the policy.
2. One provider request for every field to translate, with the glossary for the
   language and the store's name. The reply is JSON keyed by field number;
   a reply that leaves a field out or answers one that was not asked fails the
   whole item (`parseTranslationReply`), so a resource is never half written
   with no record of which half.
3. `translationsRegister` with the source digest per field; copies from the
   source ride in the same call.
4. `recordOwnership` as `ai` with the hash of each value written.

Failures are per resource and language. A sync continues past a failed item.

## The provider

`adapters/ai/openai.server.ts` reads `OPENAI_API_KEY` and
`OPENAI_TRANSLATION_MODEL` (default `gpt-4.1-mini`) from the environment on
each call. The key is never returned, stored or logged; a deployment without
one is one where `isConfigured()` is false and every page says so, while
languages can still be managed and translations edited by hand.

Chat completions, `response_format: json_object`, temperature 0.2, a
120-second timeout, up to three attempts on 429 and 5xx. **Every attempt that
reaches the provider is one `ai_usage` row** — success, failure with usage,
retry — priced under `PRICING_VERSION` at the time. A network failure is a
row with zero tokens, so the ledger shows the request was made. Skipped
translations never reach the provider and never appear.

## Coverage and estimates

`translation-coverage` reads every translatable resource of every supported
type once, counting per (locale, type) with the same field test the planner
uses, and replaces the cache. It runs after a sync completes, on request from
the Languages and Translate store pages (throttled), and nightly.

"Translate store" estimates from that cache in the browser as the choices
change: fields and source characters for the mode → tokens at about 3.5
characters a token plus a fixed overhead per request → cost from the pricing
table. The estimate is stored on the sync it started so the sync page can
show estimated against actual. A model not in the table yields "Not priced";
tokens are still recorded.

## Jobs

| Queue                        | Trigger                                                        | Does                                                                                                    |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `translation-sync`           | `startSync` from a page or the nightly tick; itself, per page  | One page (10 resources) of the current type through the engine, records items, advances cursor, re-enqueues; checks for cancel between pages; completes, marks the languages' last successful sync, asks for coverage |
| `translation-coverage`       | After a sync; page buttons; nightly per shop                   | The store-wide count, replaced whole                                                                    |
| `translation-resource-event` | `products/create`, `products/update` webhooks                  | The product, inline, for every language with automatic translation on (one `resource` sync per mode)   |

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
  Syncs             /app/translations/syncs, /:syncId       list; one sync with result, usage, every item and its reason; stop
  Glossary          /app/translations/glossary              translate-as terms per language or all; never-translate terms
  AI usage          /app/translations/usage                 today / this month / all time; by language, content, model, sync
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
- The primary locale's own text cannot be written (see Source language).
- Theme, email template and app-embed strings are out of scope: their keys are
  dynamic and their strings are the theme's.
- The editor's status filter applies within the page it read (25 resources);
  Shopify's `translatableResources` has no filter of its own.
- Cost is estimated from list prices in `domain/translations/pricing.ts`; the
  provider reports tokens, not money. Update the table and bump
  `PRICING_VERSION` when prices change.

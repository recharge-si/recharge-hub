# Handoff — Translations module

Task: build the Translations module (Shopify language management, AI
translation with OpenAI, translation editor, syncs, AI usage accounting) from
nothing. Spec is the brief pasted into the 2026-09-20 session; the durable
version is `docs/translations.md` once written. Nothing translation-related
existed before this work.

## Design decisions (settled)

- **Shopify is the source of truth** for locales (exist / published / primary),
  original content, translated content and `outdated`/digest. The app reads
  `shopLocales` live on every Languages page load and never stores locale
  state. Our tables hold only: engine settings per language, glossary, source
  overrides, translation ownership, syncs and their items, AI usage, and a
  **coverage cache** (derived counts with a timestamp, refreshed by a job).
- **Scopes added**: `read_locales, write_locales, read_translations,
  write_translations, read_markets, read_content, read_online_store_pages,
  read_online_store_navigation` (the last three only for the editor's search).
- **OpenAI**: one server-side key `OPENAI_API_KEY`, model from
  `OPENAI_TRANSLATION_MODEL` (default `gpt-4.1-mini`). Every request goes
  through `adapters/ai/openai.server.ts`, which records an `ai_usage` row for
  every attempt that returns usage (including retries and failures). Pricing
  is a versioned table in `domain/translations/pricing.ts`; cost is stored as
  micro-USD with the pricing version and always labelled "Estimated cost".
- **Ownership**: `translation_ownership` records what the app wrote (owner
  `ai` or `manual`, hash of the value). On the next pass, an AI-owned
  translation whose Shopify value no longer matches the hash was edited by a
  person and flips to `manual`. A translation with no row is a pre-existing
  Shopify translation and is treated as human work.
- **Overwrite policy per language**: `protect_existing` (missing only),
  `update_ai_managed` (default: missing + outdated that the AI itself wrote),
  `overwrite_all`.
- **Source language**: the primary locale, unless `translation_source_override`
  names another for a resource. Translation is always direct source → target.
  When the override equals a target locale, the original text is registered as
  that locale's translation verbatim (no AI). The primary locale's own text
  cannot be written by translation (Shopify does not accept translations for
  the primary locale) — documented limit.
- **Syncs** run in the worker (`translation-sync` queue, `policy: "short"`,
  singleton per sync), one page of resources per job run, cursor on the sync
  row, re-enqueue until done. Estimates for "Translate store" derive from the
  coverage cache (`translation-coverage` job), not a live scan in a loader.
- **Automatic translation**: `products/update` and `products/create` also feed
  `translation-resource-event`; the nightly tick creates an `automatic` sync
  for every language with automatic translation on.

## Status

See git log for what is committed. Remaining work and last validation are
tracked at the bottom of this file while the task is in progress.

## Progress

- [ ] schema + migration
- [ ] domain/translations
- [ ] adapters: shopify locales/translations, openai, repositories, engine
- [ ] jobs: sync, coverage, resource event, nightly automatic
- [ ] routes: languages, language, add, editor, translate store, syncs, usage, glossary
- [ ] scopes, env, docs, tests

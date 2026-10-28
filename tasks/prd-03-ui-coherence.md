# PRD 3: A coherent merchant UI

## 1. Introduction

`docs/ui-conventions.md` already says how the app should look and behave. A read-only audit on 2026-10-28 (grep and partial reads, no browser) found places where the code does not follow it, and a navigation that names the same things differently. This PRD turns the rules into code that enforces them, then fixes the violations. File and line references are from `main` @ 28b0d09 and must be re-checked when the work starts; items marked *unverified* were not read in full.

## 2. Goals

- One name per concept, in the navigation, headings, URLs and docs.
- One component for "is this process healthy, when did it run, when does it run next".
- One polling hook; no per-route intervals.
- Colour marks exceptions only.
- Rules that can be checked by a test are checked by a test, so they stay true.

## 3. Findings the stories fix

| # | Finding | Evidence | Story |
|---|---|---|---|
| F1 | Nav says "Metafields"; docs, a component and URLs say "Product setup"; the area also holds types, sets and a menu | `navigation.ts:49`, `product-setup-nav.tsx:25`, `product-overview.tsx:453`, `app.sources.categorization.tsx:182` | US-301 |
| F2 | Two pages headed "Products" (Shopify workspace, MetaKocka catalogue) | `app.products._index.tsx:413`, `app.metakocka.products._index.tsx:194` | US-302 |
| F3 | "Last run / next run" re-implemented in at least four places; Sales, Translations syncs, Locations, Store menu have none | `source-overview.tsx:208,233,297`, `sources-list.tsx:44-50,171`, `app.metakocka.products._index.tsx:301`, `product-overview.tsx:226` | US-303 |
| F4 | Hand-rolled `setInterval` polling in about nine routes, skipping hidden-tab pause, 15 s unstick and refocus refresh | `app.sales._index.tsx:194`, `app.sales.$campaignId._index.tsx:399`, `app.translations._index.tsx:76`, `app.translations.syncs._index.tsx:65`, `app.translations.syncs.$syncId.tsx:261`, `app.translations.context.tsx:421`, `app.translations.languages.$locale.tsx:470`, `app.metakocka.locations.settings.tsx:502,558`, `app.orders.settings.payments.tsx:403` | US-304 |
| F5 | Green used for normal states and success banners | `app.metakocka.locations.settings.tsx:1009`, `app.orders.settings.payments.tsx:621`, `app.settings.metakocka.tsx:436`, `app.translations.languages.$locale.tsx:1152`, `product-attributes.tsx:714,282`, `campaign-summary.tsx:104`, `app.sales._index.tsx:398`, and more | US-305 |
| F6 | Badges used for configuration or metadata | `source-editor.tsx:144`, `app.translations.context.tsx:1017` ("Person"), `app.orders.$orderId.tsx:1414` ("Primary") | US-305 |
| F7 | Same setting editable on two pages | `transferOrders`/`transferBacklog` in `app.setup.tsx:1617,1642` and `app.orders.settings._index.tsx:768,792`; order reference pattern in both | US-306 |
| F8 | Integrations awaited in loaders (portal in five Sources routes) | `app.sources._index.tsx:80`, `app.sources.$sourceId._index.tsx:115`, `…runs._index.tsx:29`, `…runs.$runId.tsx:37`, `app.sources.new.tsx:49` | US-307 |
| F9 | Forbidden words in merchant copy: "article", "feed", "exception", "blocked" | `app.setup.tsx:775,1884`, `app.orders.settings._index.tsx:319`, `app.metakocka.products.sync.tsx:371,396`, `app.sources._index.tsx:364`, `app.metakocka.locations.settings.tsx:1074`, `app.settings.taxes._index.tsx:102` | US-308 |
| F10 | Area navigation differs: tabs in Translations and Product setup, none in Sources | `TranslationsNav`, `ProductSetupNav`, Sources routes | US-309 |
| F11 | Save bar vs inline save split without a rule | `useSaveBar` pages vs `app.sources.*`, `app.translations.context.tsx`, `…glossary.tsx`, `app.product-setup.sets.tsx`, `…menu.tsx` | US-310 |
| F12 | Overlapping entry points: Settings → Product sync vs MetaKocka → Products → sync; Settings → Locations vs MetaKocka → Locations; Settings → Export portal vs Sources → Connection | `app.settings._index.tsx:46-85` | US-302 |
| F13 | Loading and empty states differ per list; only Products sets the table `loading` prop | `app.products._index.tsx:572` | US-311 |
| F14 | Hydration mismatch on every page (T-29) | `docs/project-status.md` T-29 | out of scope, noted |

## 4. User stories

### US-301: One name for the area: "Product setup"
**Description:** As a merchant I see the same name in the menu, the page heading and the address.

**Acceptance criteria**
- [unit] `NAV_ITEMS` (`web/lib/navigation.ts`) contains an entry with label `Product setup` and href `/app/product-setup`, and no entry labelled `Metafields`.
- [unit] A copy test scans `src/web/**/*.tsx` string literals and fails if `Metafields` appears as a section name (allowed only inside a sentence about Shopify metafields, enumerated in an allowlist file).
- [unit] The `ProductSetupNav` accessible label is `Product setup sections`.
- [e2e] Opening `/app` and clicking `Product setup` lands on `/app/product-setup/types`; the `<h1>`/page heading is `Product setup`; zero page errors beyond T-29's two.
- [e2e] A bookmark to `/app/product-setup/attributes` still returns 200 (URLs do not change).
- `docs/ui-conventions.md` glossary gains: *Product setup* (the plan: types, attributes, sets, menu), *metafield* (Shopify's stored value; used only where Shopify's own concept is meant).

### US-302: Entry points that do not overlap
**Description:** As a merchant I find each thing in one place.

**Acceptance criteria**
- [unit] Navigation tree test pins the structure below (labels and order).
- [e2e] `Products` page title is `Products`; the ERP catalogue page title is `MetaKocka products` (and its `<title>`), and the Products page links to it by that name.
- [e2e] From the Settings hub, the cards for *Locations*, *Product sync* and *Export portal connection* are links that land on the page that owns them (under MetaKocka or Sources), not a second editable copy. Asserted by: the destination route is the same route as the owner's, and the Settings page contains no form elements for those settings.
- [unit] Legacy redirects (`/app/locations/*`, `/app/products/sync`, `/app/settings/payments`, `/app/settings/sales-orders`, `/app/settings/supply-sources`, `/app/metakocka/products/:id`) still respond with a redirect to the owner (table-driven test).

**Target navigation** (proposal; Open question 1):
```
Home · Needs attention · Orders · Sales · Products · Product setup · Translations · Sources · MetaKocka · Settings
Products:   Shopify products | MetaKocka match (tab or column) | Name sync
Sources:    Sources | Review | AI categorization | Connection
MetaKocka:  Connection | Locations | Products | Name sync
Settings:   Orders | Payments | Taxes   (connection pages live under their own area)
```

### US-303: One process header
**Description:** As a merchant, every page that owns a background process answers "healthy, last run, automatic or manual, next run" the same way.

**Acceptance criteria**
- [unit] `ProcessHeader` (`web/components/process-header.tsx`) renders from `{health, lastRun?: {at, outcome}, mode: "automatic"|"manual", nextRunAt?}`: for `health = "needs_attention"` it renders the loudest element on the page and a link; for `ok` it renders neutral text and no badge, and no green (no `tone="success"` anywhere in its output). Table-driven test over all four health values and both modes, with and without `lastRun`/`nextRunAt`.
- [unit] Relative times use one formatter: `2 min ago`, `yesterday 14:05`, never a raw ISO string. Fixture clock injected.
- [e2e] The header appears, with the same wording structure, on: Sources list, a source page, MetaKocka products (catalogue sync), Translations syncs, Locations stock sync, Product setup → Store menu, Sales. A parametrised Playwright test visits each route and asserts the header's text matches `/^(Healthy|Needs attention|Never run|Off) · .*/`.
- [unit] The old per-page implementations are deleted; a grep test fails if `Last run` or `Next run` is rendered outside `process-header.tsx` and the allowlist.
- Pages whose process has no schedule say `Manual` and omit next run; they do not invent one.

### US-304: One polling hook
**Description:** As a merchant, pages that show a running process update without reload, pause in a hidden tab, and never freeze.

**Acceptance criteria**
- [unit] A repo test fails if any file under `src/web/routes` or `src/web/components` calls `setInterval(` or `useLivePolling`; the only allowed file is `web/lib/live.ts`.
- [unit] Each of the nine routes in F4 calls `useLiveRevalidation({active})` with `active` true only while its process is `queued`/`running`; `useWatchWindow` is used in the payments page after save.
- [e2e] On the translation sync page with a stubbed running sync, the page re-reads within 5 s (assert request count rises from 1 to ≥ 2 inside 7 s), stops re-reading within 35 s after the sync is stubbed `completed` (request count stable over 40 s at the slow rate), and makes zero requests while `document.visibilityState = "hidden"` for 10 s.
- [e2e] A stalled re-read (stub holds for 20 s) is replaced after 15 s (pattern of `tests/e2e/specs/store-menu.spec.ts`).
- Regression risk: ticks on selected rows and open editors survive a re-read (existing behaviour; add one assertion per migrated route that has selection or an editor).

### US-305: Colour and badges mean one thing
**Description:** As a merchant, the only coloured thing on a healthy screen is nothing.

**Acceptance criteria**
- [unit] A repo test fails on `tone="success"` or `tone="positive"` for `Badge`/`s-badge` and on `s-banner tone="success"` outside an allowlist file that lists, per entry, a reason (e.g. a toast). Initial allowlist is empty; every F5 location is migrated to neutral text or a toast.
- [unit] `Complete`, `Mapped`, `Checked`, `Published`, `verified`, `active`, `Translated` render neutral, with no icon colour.
- [e2e] For each page in F5, the page's DOM contains zero elements with `tone="success"`.
- Badges for configuration/metadata are replaced: source on/off becomes a row in `SettingRows` (`source-editor.tsx:144`); "Person" becomes plain text `Edited by a person`; "Primary" becomes `Primary` text in the row.
- A failure or attention state still uses the loudest element (existing `critical`/`warning`) — assert on a page with a stubbed failed run that exactly one critical element is present above the fold.

### US-306: Each setting has one editor
**Description:** As a merchant I never change a value in one place and find it different in another.

**Acceptance criteria**
- [unit] After `shop.setup_completed_at` is set, `/app/setup` renders `transferOrders`, `transferBacklog` and the order reference pattern as a line (current value) plus a link to `/app/orders/settings`, and contains no input/pattern editor for them. Before completion, setup keeps its first-run controls (documented exception).
- [e2e] After completing setup, changing `transferOrders` on Order settings and visiting setup shows the new value, with the link; no `form` with those field names exists in setup's DOM.
- [unit] Stock sync is editable in exactly one of Settings → MetaKocka and Locations settings (*unverified which; decide at implementation and render the other as a line*).

### US-307: Pages do not wait for the portal
**Description:** As a merchant, opening Sources never blocks navigation on a slow portal.

**Acceptance criteria**
- [e2e] With the portal stub delayed 7 s, `/app/sources` renders its shell (heading, nav, a skeleton for the list) in < 1.5 s and the list arrives afterwards; with the portal stub returning 500 the page shows the existing `PortalRead` failure state with *Try again*.
- [unit] The loader returns the page shell without awaiting the portal call (the call is a deferred promise or a client fetcher); a test asserts the loader resolves before a never-resolving portal stub.
- Applies to the five routes in F8; `app.metakocka.products.sync.tsx:153` (`metakockaNamesFor`) is *unverified* — if it awaits MetaKocka on the loader path it violates `AGENTS.md` ("no page load may await MetaKocka") and is fixed here or logged as a defect in `project-status.md`.
- Note: `docs/sources.md` currently calls the await deliberate ("one call per page, 8 s timeout"). This story changes that design and updates the doc; confirm (Open question 2).

### US-308: Words
**Description:** As a merchant I read the same word for the same thing.

**Acceptance criteria**
- [unit] A copy test over merchant-facing strings fails on `article` (as a product synonym), `feed` (outside the Sources area's own noun, allowlisted), `exception` (use "needs attention"), `blocked` in user-visible messages, and on exclamation marks and the word `successfully`. Allowlist file with reasons.
- [unit] Every button label begins with a verb (a simple check on `<s-button>`/`Button` children in a fixture render of each page is not feasible; instead lint the literals in a `labels.ts` used by new code, and spot-check by e2e on the five busiest pages).
- All F9 locations rewritten.

### US-309: The same tab row everywhere
**Description:** As a merchant, areas with sub-pages look the same.

**Acceptance criteria**
- [unit] A shared `AreaNav` renders from `{items, current}`; `TranslationsNav`, `ProductSetupNav` and a new Sources nav are built on it. Table test: current item is marked with `aria-current="page"` and no other item is.
- [e2e] Sources pages show tabs `Sources | Review | AI categorization | Connection`; `/app/sources/review` marks `Review`.
- Keyboard: Tab reaches each item, Enter activates (e2e).

### US-310: A written save rule
**Description:** As a developer I know which pattern a new form uses.

**Acceptance criteria**
- `docs/ui-conventions.md` gains § Saving: persistent settings use the contextual save bar; one-off actions (run now, apply, create) use a button; a card that edits in place with Edit/Save uses `SettingRows`.
- [e2e] Source detail and Translations context editors follow it: unsaved edits show the save bar; *Discard* restores the previous values; navigating away with unsaved edits asks for confirmation.

### US-311: Loading, empty and error states in one set
**Description:** As a merchant, a list never shows a blank white box.

**Acceptance criteria**
- [e2e] For Products, MetaKocka products, Sales, Sources and Translations lists: with the loader delayed, the table shows `loading`; with no rows it shows an empty state that says what to do next in one sentence; with the loader failing it shows an error state with *Try again*. 5 pages × 3 states = 15 assertions in one parametrised spec.
- [unit] The empty-state sentences are in one file (`web/lib/empty-states.ts`) so copy review is one diff.

## 5. Functional requirements

- FR-1: Navigation labels and area names come from one module (`navigation.ts`) and the glossary.
- FR-2: `ProcessHeader` is the only renderer of last/next run.
- FR-3: `web/lib/live.ts` is the only polling code.
- FR-4: No success-tone badge or banner exists; a test enforces it.
- FR-5: A setting has one editor; other pages show a line and a link.
- FR-6: No loader awaits an integration unless documented in `AGENTS.md`/`docs/` as allowed.

## 6. Non-goals

- No visual redesign, no new theme, no change to Polaris web components.
- No URL changes (bookmarks keep working).
- T-29 (hydration mismatch) is not fixed here, but the e2e tolerance for it stays exactly two errors.
- No measurement pass for the Built for Shopify checklist (separate work in `project-status.md`).

## 7. Design considerations

Prototype: none (user asked for local HTML only for the rig builder; this PRD changes naming, structure and state rendering of existing screens, not their look). Visual contract = `docs/ui-conventions.md`. Reuse: `PageColumns`, `SettingRows`, `Advanced`, `ReadinessList`, `useLiveRevalidation`, `useWatchWindow`, `useSaveBar`, `PortalRead`.

## 8. Technical considerations

- Enforcement tests live in `tests/unit/ui-rules.test.ts`; they read source files and fail with `file:line` so the next violation names itself.
- Do the renames and the enforcement tests first, then migrate routes in small commits (one finding per commit) to keep review light.
- Rebase point: PRD 2 adds a *Definitions* tab and must use the final area name and `AreaNav`.
- The audit did not render pages in a browser; run each story's e2e before and after to avoid fixing a state that was never broken.

## 9. Success metrics

- Number of distinct implementations of last/next run: 4+ → 1.
- `setInterval` calls in `src/web`: 9+ → 0.
- Zero `tone="success"` badges/banners.
- A new merchant can find "where do I change the order reference" with one click from Orders (checked by the e2e path above).

## 10. Open questions

1. Is the target navigation acceptable (Products tabs; MetaKocka as its own area; Settings reduced)? It moves entry points, not URLs.
2. May Sources move to deferred loading (US-307), reversing the documented "deliberate" await?
3. Which one of Settings → MetaKocka and Locations settings owns stock sync? (Needs a read of both.)
4. Do we want Slovenian merchant copy (the app has Slovenian labels in attributes)? Out of scope here but affects the copy test.

## 11. Verification checklist

### Per-change coverage

**C1: rename Metafields → Product setup (US-301)**
- [ ] Frontend: nav label, heading, a11y label.
- [ ] Round-trip: old bookmarks 200.
- [ ] Edge cases: every `Metafields` literal either renamed or allowlisted with a reason.

**C2: ProcessHeader (US-303)**
- [ ] Frontend: seven pages render it.
- [ ] Validation: unknown health value falls back to `Needs attention` and logs once (decide; pin in test).
- [ ] Edge cases: never run; manual; off; missing outcome.

**C3: polling (US-304)**
- [ ] Round-trip: sync running → completed → polling slows.
- [ ] Edge cases: hidden tab; stalled request; selection preserved.

**C4: colour/badges (US-305)**
- [ ] Frontend: zero `tone="success"`.
- [ ] Edge cases: failure still loudest.

**C5: one editor per setting (US-306)**
- [ ] Round-trip: change in owner → visible as line elsewhere.
- [ ] Shop scoping: `shop_id` isolation unchanged (existing tests).

**C6: deferred portal reads (US-307)**
- [ ] Edge cases: portal slow, 500, not configured (`EXPORT_PORTAL_URL` unset).

### Test data setup

- E2E stub shop with: a source in each health state, a running and a completed translation sync, a failed run, a campaign, products with and without MetaKocka matches. Divergent counts: 4 sources (2 ok, 1 needs attention, 1 off) so the header count `1 needs attention` differs from the total 4.
- Second shop for isolation.

### Browser end-to-end

- [ ] Parametrised specs for US-301 to US-311 pass.
- [ ] Screenshots before and after for Sources list, Product setup, Settings hub.
- [ ] Visual parity: N/A (no prototype). Instead: a before/after side-by-side for the pages whose structure changed, reviewed by Grega.

### Suite gates

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build && npm run test:e2e`.
- [ ] `docs/ui-conventions.md` and `docs/architecture.md` updated.
- [ ] Evidence is output, not "looks good".

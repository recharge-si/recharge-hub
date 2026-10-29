# Sources

What the **export portal** pushes into the store — stock, new products,
prices, descriptions and images from a catalogue export or a brand feed,
each stocked at one Shopify location with its own settings — configured and
watched from inside this app, and carried out by the portal. The portal
(Time 4 Action's _Product Sync_, `time-4-action/t4a-partner-portal`) is a
separate internal product with its own Shopify app, used by other partners
as well; Recharge Hub is one client of it. Nothing about a source is stored
here; the one thing this app keeps is the API key that connects the two.

This document is the design, the map of the implementation, and **the
contract the export portal implements**. The portal's side of the same
contract is `t4a-partner-portal-api/docs/sources-api.md`. Where the code and
this document disagree about this app, the code is right; where the two
documents disagree about the wire format, the one that matches the portal's
smoke test (`scripts/sources-api-smoke.js` there) is right.

**Status (2026-09-22):** both sides are built. The portal serves `/api/v1`
from its API server, mints keys per connected store on its Shopify
integration page under _API access_, and passes an end-to-end smoke test;
this app is complete against the contract. What has not happened yet is a
live run with the real Recharge store's key (T-27).

## Why it is built this way

Two Shopify apps cannot share a screen: an embedded app's session token is
bound to its own `client_id`, so the portal's pages cannot be framed inside
this one. What can be shared is an API. The portal keeps its own Shopify
install on the store (its own token, its own webhooks, its own writes of
stock and products), gains an API key per connected store generated on its
Shopify integration page, and exposes what that page can do behind the key.
This app gets a `Sources` area that is nothing but a view onto that API.

On the portal's side a _source_ is one entry of a connection's
`config.scopes[]` (a catalogue export or an Own Source feed at one
location), a _run_ is one `shopify_sync_jobs` document, and the fields are
its per-scope push settings; the portal's `sources-api.md` has the mapping.

"One development" is kept by one rule: **the portal describes its own
forms.** Each source kind comes with the list of fields it has — type,
label, help, options — and this app renders them with the design system's
controls and nothing else. A new kind of export, or a new setting on one,
appears here without a change to this app.

## What the module owns, and what it does not

| Export portal owns                                                                            | Recharge Hub owns                                                                            | Environment owns    |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| Every source: its kind, name, settings, schedule, location                                    | The API key for the store, encrypted, and whether it was verified                            | `EXPORT_PORTAL_URL` |
| Every run, its outcome and its log                                                            | The tenant name the portal answered with, as a label                                         |                     |
| Which kinds of source exist and which fields each one has                                     | An audit trail of what was asked for from here (`event_log`)                                 |                     |
| Its own Shopify install and every write into the store, except approving a draft under review | Approving a product under review: status to active, review tag off (§ Review before publish) |                     |
| Which key belongs to which connected store                                                    |                                                                                              |                     |

## Architecture

```text
web (React Router)                                    export portal
  /app/sources …        ──GET /api/v1/sources──────▶  reads its own tables
  /app/sources/:id      ──PATCH /api/v1/sources/:id─▶  validates, stores, answers
  Run now               ──POST …/runs──────────────▶  queues a run
  /app/sources/connection  saves the key here, then GET /api/v1/connection
```

- `src/domain/export-portal/` — pure: the contract as Zod schemas
  (`contract`) and the rules for a schema-driven form (`fields`): reading
  posted strings into typed values, which values are worth sending, how a
  stored value becomes an input. No clock, no fetch.
- `src/adapters/export-portal/` — the HTTP client (`client.server`), the
  one classification of failures (`errors`), and the service both web and
  jobs call (`service.server`): "a client for this shop, or why not".
- `src/adapters/db/repositories/export-portal-connection.server.ts` — the
  key at rest, encrypted; a mask for the screen; who may change it.
- `src/web/lib/sources.ts` and `sources.server.ts` — words, addresses, and
  the one shape every page uses when the portal cannot be read.
- `src/web/components/portal-fields.tsx` — the fields the portal described,
  as Polaris controls; consecutive switches share a two-column grid.
- `src/web/components/sources-list.tsx` — the list page's summary row and
  table; `source-overview.tsx` — the source page's read-only cards and
  the runs table; `source-editor.tsx` — one group of fields edited in
  its card: the hook, the fields, the card.
- Screens under `app.sources.*`.

No worker involvement: a run is the portal's job, started with one call and
watched by polling the page. There is nothing for `jobs/` to do yet.

### A page load that calls an integration

The rule elsewhere is that no page loader waits on MetaKocka: the UI reads
cached PostgreSQL state. The Sources pages _do_ call the portal as they
open, deliberately. The area is a view onto the portal, nothing about a
source is stored here, and the Translations pages already read Shopify's
locales live for the same reason. What keeps it safe: one call per page
with an 8 second timeout, every failure is a state the page renders
(`PortalRead`) rather than an error it throws, and the portal is an
internal service on the same network. If it ever becomes slow, the answer
is a cache of the source list, not a job.

## Connection

One API key per shop, generated in the portal's admin for that store and
pasted into `/app/sources/connection`. It is encrypted with the same
AES-256-GCM scheme as every other secret (`adapters/crypto/secrets.server`)
and stored in `export_portal_connection`; the screen sees a mask and
nothing else.

Saving the key tests it at once — `GET /connection` says which tenant the
key is and that it was issued for this shop — and the answer's tenant name
and time are recorded. A key the portal refuses stays saved so the person
can read what the portal said and paste again.

**Who may do what.** Saving and forgetting the key is the store owner's
(or a job's), like the MetaKocka credential; the same T-21 gate applies.
_Using_ the key — listing, editing and running sources — is open to any
signed-in staff member: it is day-to-day work, the key is only ever used
server-side, and the portal decides what the key may do.

**The key is the whole credential, and the portal binds it.** Every call
carries the key as a bearer token _and_ the shop domain as a header, and
the portal must refuse (403) a key that was not issued for that shop. That
is the check that stops a pasted key from configuring another partner's
sources, and it lives in the portal because only the portal knows which
key is whose.

**Disconnecting forgets the key and nothing else.** The sources, their
settings and their runs live in the portal and are untouched; the page
just stops showing them. This is unlike MetaKocka, where disconnecting
resets the store — nothing here derives from the connection. Note that a
MetaKocka disconnect _does_ take the portal key with it, because
`resetShop` deletes the shop row and everything cascades from it.

`EXPORT_PORTAL_URL` is per deployment, not per shop: the portal is one
internal tool with one address, and a URL a merchant could type is a URL
this server would call. Without it the Sources pages say the portal is not
configured, a key can still be saved, and nothing else in the app changes.

## The contract

Base: `EXPORT_PORTAL_URL` + `/api/v1`. JSON in and out. Timestamps are ISO
8601 strings. Every request carries:

```http
Authorization: Bearer <api key>
X-Shop-Domain: <shop>.myshopify.com
Accept: application/json
```

| Method   | Path                      | Reply                           | Notes                                                        |
| -------- | ------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/connection`             | `{ tenant, shop, key? }`        | The connection test. 401 bad key, 403 key not for this shop. |
| `GET`    | `/source-types`           | `{ types: SourceType[] }`       | What can be created, with each kind's fields.                |
| `GET`    | `/sources`                | `{ sources: SourceSummary[] }`  | Every source of the tenant.                                  |
| `POST`   | `/sources`                | `{ source: Source }` (201)      | Body `{ kind, name, values }`.                               |
| `GET`    | `/sources/:id`            | `{ source: Source }`            | Fields and values included.                                  |
| `PATCH`  | `/sources/:id`            | `{ source: Source }`            | Body `{ name?, enabled?, values? }`, all partial.            |
| `DELETE` | `/sources/:id`            | empty (204)                     |                                                              |
| `POST`   | `/sources/:id/runs`       | `{ run: Run }` (202)            | Starts a run. May refuse (409) while one is running.         |
| `GET`    | `/sources/:id/runs?limit` | `{ runs: Run[] }`               | Newest first.                                                |
| `GET`    | `/runs/:runId`            | `{ run: Run, log?: LogLine[] }` |                                                              |
| `POST`   | `/ai/categorize`          | `{ results: CategoryResult[] }` | AI autofill: one of the caller's categories per product.     |
| `POST`   | `/ai/extract-attributes`  | `{ values: AttributeValue[] }`  | AI autofill: the caller's attributes, read from one product. |

Refusals are `{ error: { code?, message? }, errors?: [{ field, message }] }`.
`errors` rides on a 422 (or 400) and names the field's `key`; the editor
puts each message under its input. This app reads the kind of failure from
the status code alone: 401, 403, 404, 400/422, 409, 429, 5xx. A **409** is a
state the portal names in its message and this app shows verbatim — a run
already in progress, a source switched off, a store that must be reconnected
in the portal (also the answer to _every_ call while the store's connection
there is not active).

### Shapes

```ts
SourceType    { kind, label, description?, fields: Field[] }
Field         { key, label, type, help?, placeholder?, required?, options?, tokens?, sample?, group? }
              type ∈ text | textarea | number | boolean | select | secret | url | email
              options: [{ value, label }] — select only
              tokens: [{ key, label, example? }] — text only: the {placeholders} the value may use
              sample: { label, after } — with tokens: the real record the examples come from
              group: a heading the field is listed under
SourceSummary { id, name, kind, kindLabel, enabled, destination?, schedule, health, lastRun? }
              schedule: { mode: manual | automatic, description?, nextRunAt? }
              health ∈ ok | needs_attention | never_ran | off
Source        SourceSummary + { fields: Field[], values, createdAt?, updatedAt?, portalUrl? }
              values: { [key]: string | number | boolean | null }
Run           { id, sourceId, status, triggeredBy?, queuedAt?, startedAt?, finishedAt?,
                itemCount?, message?, downloadUrl? }
              status ∈ queued | running | completed | failed | cancelled
LogLine       { at, level: info | warning | error, message }
Connection    { tenant: { id, name }, shop: { domain }, key?: { name?, createdAt? } }
```

The exact schemas, including which members are optional, are
`src/domain/export-portal/contract.ts`; that file is the authority and a
reply it does not parse is shown as "answered in a form this app does not
understand".

### Fields

The portal owns the meaning of every field; this app only knows its type.

- A **`secret`** is never returned. `values[key]` is a mask (`"••••1234"`)
  or `null` when nothing is stored. This app sends the key only when a
  person typed a new value; a blank input means "keep it". To clear a
  secret, the portal's own admin is the place.
- A **`boolean`** is posted as `"true"` or `""`; this app turns it into a
  real boolean before sending.
- A **`number`** is sent as a number; blank on an optional field is `null`.
- A **`select`** value must be one of `options`; this app checks that
  before sending and the portal checks it again.
- A **`text`** field with `tokens` is a pattern in the name pattern's own
  syntax (`{field|filter}`, `[optional groups]`), filled in per product by
  the portal — today the title prefix (`{vendor}`, `{category}`, …). It is
  edited like the MetaKocka name: the pattern editor across the card, chips
  picked from a list with the portal's example beside each, and under it the
  portal's `sample` product as it would come out ("UF-1: Dakine - Seeker
  Vest"). An unknown field or filter is flagged before saving; the portal
  refuses it too. Posted as the plain string it is
  (`web/lib/portal-field-tokens.ts`).
- `required` is enforced here, with the field's own label in the message,
  and again by the portal.
- A `PATCH` carries only the values that changed against what the portal
  returned, so its audit trail records real changes.

### Health

`health` is the portal's one-word answer to "is this working", so the two
admins never disagree about it. `needs_attention` is expected to mean the
last run failed or the source cannot run as configured; `never_ran` and
`off` are calm states. The Sources page counts `needs_attention` for its
header and marks nothing else.

## Failures

`adapters/export-portal/errors.ts` classifies every failure into one kind
and turns it into one sentence for a merchant. A validation refusal uses
the portal's own words because they name the field; every other kind is
said in this app's words so no hostname, stack or status reaches a screen.
Nothing is retried: a person is waiting on a button, and the page offers
_Try again_.

The API key is never logged, never in an error, never in the audit trail.
The audit trail records which fields of a source changed, never their
values, because a value may be a secret.

### A run that never finishes

The portal runs a source in its own process and records the run as
`running` until it ends. A run killed with the process (a deploy, a crash)
used to stay `running` until the store's next run started — and this app
disables *Run now* while a run is going, so nothing ever started one. Two
guards now close it:

- **Portal:** at startup it marks every run still `running` failed
  ("Interrupted — the portal restarted during this run"), and the same for
  its AI categorization runs (`failInterruptedRuns`,
  `failInterruptedCategorizationRuns`). A single API instance is assumed,
  as for its per-store lock.
- **This app:** a run still queued or running six hours after it started
  is *stale* (`isRunStale`, `web/lib/sources.ts`): it is shown as *Stopped
  responding*, the page stops polling for it, and *Run now* is offered
  again — and starting a run is what makes the portal close the dead one.
  No real run comes near six hours; every Shopify call the portal makes
  times out in thirty seconds.

## Screens

```text
Sources            /app/sources                      every source, how it is doing,
                                                     when it last ran, when it runs next
  New source       /app/sources/new                  kind → name → the kind's fields
  Source           /app/sources/:sourceId            one source, read: summary, one card
                                                     per group of settings, each edited
                                                     in place; recent runs; Run now,
                                                     Turn off/on, Open in portal, Delete
    Runs           /app/sources/:sourceId/runs       every run the portal remembers
    Run            /app/sources/:sourceId/runs/:runId  what happened and the log
  AI categorization /app/sources/categorization      which sources' new products the AI
                                                     sorts into product types
  Connection       /app/sources/connection           the API key (store owner only);
                                                     also linked from Settings
```

The principle across the three: the **list** is for watching and operating
every source, the **source page** is for understanding one, and **editing**
is one group of settings at a time, in its own card. No page is a form.

- **Sources** is a wide page (`inlineSize="large"`). It opens with the
  figures every page owning a background process answers
  (docs/ui-conventions.md § Page header) as one row: sources, how many
  need attention, how many are on or running, the last run, the next run.
  The count of sources needing attention is the one figure with a colour,
  and it is said once there, not again in a banner. Then
  one table with a status and kind filter and a search, all client-side
  (the portal answers with every source at once): source with its kind
  and destination, one status badge (running, then off, then health),
  the schedule in words, the last run and its item count, the next run,
  _Run now_ and a menu (View, Turn off/on, Delete — which asks first).
  The whole row opens the source; the buttons do not. A running source
  is polled every five seconds, and the table shows a spinner rather
  than emptying. No sources is an empty state, not an empty table. When
  the portal cannot be read the page says why and offers _Try again_,
  and for a refused key a link to the connection.
- **New source** is a kind (a row of cards up to four kinds, a dropdown
  beyond), a name, and the kind's fields. Nothing exists until the portal
  has accepted it; a refusal comes back against the field.
- **Source** is two columns. The main column: a summary strip (health,
  last run, items, next run), then one read-only card per group the
  portal described its fields under — the name and kind first, ungrouped
  fields as _Settings_ — each with one _Edit_ button, then the latest
  five runs with a link to all of them, then the delete line at the end.
  The sidebar: on/off and health with the last successful run; what the
  last run reported when the source needs attention (laid out as counts
  when the portal's line is a tally, `attentionItems`); the schedule in
  words with the expression the portal appended kept there and nowhere
  else (`describeSchedule`); kind, destination, dates and the portal
  link. The schedule is stated, not edited: it is the portal's.
- **Editing** is in the card (`EditableCard`, `useSourceEdit`,
  `SettingRows`): Edit puts each field's control where its value was,
  with Save and Cancel; nothing opens over the page. It starts
  from what the portal holds, _Save_ is disabled until something differs,
  and it posts only the fields it showed — the action reads only the
  fields present in the form, so one group's save never touches
  another's. It is done only once the portal has accepted; a refusal
  stays in the card, against the field it names. Cancel discards what
  was typed. Each card has its own fetcher, so one group's refusal is
  never shown in another. Read or edited, a group is the same rows in
  the same order: every field's name with the help the portal gave under
  it (a setting whose effect is not said where it is changed is a
  guess), and beside it the value — a switch as On or Off, a choice by
  its name alone (`shortLabel`: the part before the dash) — or, editing,
  the control. Edit therefore changes only the value column; the card
  does not reflow. A group led by a switch states only that switch
  while it is off. Each choice's longer explanation is behind the
  card's question mark.
- **Runs** is every run the portal remembers, newest first, up to 100.
- **Run** is read-only.

Words: a **source** is one configured export; a **run** is one execution
of it; the **export portal** is the other product. All three are the
portal's own terms, kept so a person moving between the two admins reads
the same thing.

## Review before publish

A source can be told to hold its new products for a person instead of
publishing them. The setting is the portal's, a field on the source like
any other, so it appears among the source's settings here without anything
in this app knowing it. The contract between the two is Shopify tags, and
nothing about a product under review is stored in this app.

**What the portal does in review mode.** A product the run creates (not one
it updates) is created with status `DRAFT` and two tags (outside review
mode it is created `ACTIVE` with `portal-source:<id>` alone, so its source
is known for AI categorization):

- `awaiting-review`, which puts it in the queue;
- `portal-source:<sourceId>`, which says which source it came from.

It is published to the source's sales channels as usual; a draft is shown
on none of them. Later runs update the product's content and stock but
**never write `status`**, so a run can neither publish a draft nor unpublish
an approved product. A run's `message` may count them (`12 awaiting
review`), which the run pages already show as an attention item.

**What this app does.** `/app/sources/review` lists Shopify's drafts
carrying `awaiting-review`, newest first, filterable by source and by
search (`reviewQuery`, `domain/export-portal/review.ts`). A row's title
opens the product's workspace in this app (`/app/products/:id`). Each row says
which of the store's published languages still lack a translation of the
product (`translationGaps`, counted as coverage counts: a field the
language keeps in the original is not missing), and offers:

- **Translate**: fills what is missing or outdated in every published
  language. One product is translated while the person waits
  (`translateResourceNow`); several selected are a `resource` sync.
- **Edit translations**: the translation editor on that product.
- **Approve**: `productUpdate` to `ACTIVE` and `tagsRemove` of
  `awaiting-review`, in one request for up to 25 products
  (`adapters/shopify/review-products.ts`). A product that is no longer
  a draft with the tag is reported and left alone, so a stale page cannot
  publish what someone has since archived. Missing translations warn
  before approving; they do not stop it. Each approval is an
  `event_log` entry (`product.review_approved`).

This is the one write into the store this app makes for Sources, and it is
deliberately this app's: the review happens here, next to the translations,
and the portal only has to leave `status` alone. The Sources list and each
source's page say how many products are waiting.

## AI autofill

The portal has an AI categorizer (Claude Haiku) that sorts its catalogue
into category sets. The same model, with this app's own catalogue model
handed to it per call, is what suggests a product's type and attribute
values here (docs/attributes.md § AI autofill). Two calls on the same key
and shop binding as everything else; both are stateless on the portal —
nothing is stored and nothing is written to the store; only the token
usage is logged there (`aiAnalytics`, operation `sources-api:<connection>`).

```ts
AiProduct      { code, shopifyProductId, name, vendor?, productType?, category?, tags?,
                 description?, options?, variants?: [{ id, title, sku?, options? }] }
POST /ai/categorize
  body         { products: AiProduct[] (1–50), categories: [{ id, label }] (1–2000) }
  CategoryResult { code, categoryId: string | null, confidence: number | null, reason: string | null }
POST /ai/extract-attributes
  body         { product: AiProduct, attributes: Attribute[] (1–200) }
  Attribute    { id, name, description?, format, unit?, options?: [{ code, label }],
                 level: product | variant }
               format ∈ text | integer | decimal | boolean | date | choice | choices | measurement
  AttributeValue { attributeId, variantId: string | null, value: string | string[] }
```

- `code` is echoed back so results match products; this app sends the
  product GID. `categorize` answers one result per product sent, in order;
  `categoryId` is null when none of the categories fits, and is never one
  that was not sent. A label is the category's full path joined with
  ` > `.
- `extract-attributes` answers only what the product's data settles; an
  attribute it cannot tell is absent. A `choice` value is one option code,
  `choices` a list of codes, a number is digits in the attribute's unit,
  a boolean `"true"`/`"false"`, a date `YYYY-MM-DD`. A `variant` attribute
  has one entry per variant it can tell, by the variant id sent.
- **The portal adds what it knows.** For a product it created in the
  store (found through its `shopify_product_map` by `shopifyProductId`), it
  adds the supplier's own category, tags and description and its own
  category labels to what the model reads. The store's data alone is
  enough; this only adds evidence.
- Refusals: 422 `invalid` with `errors[].field` for a malformed request,
  503 `ai_unavailable` when the portal has no model key, 502 `ai_failed`
  when the model fails or declines. For a 502 or 503 this app shows the
  portal's own message, which is written for a merchant.
- The request body is at most 100 kB (the portal's JSON limit): this app
  sends ten products per categorize call with descriptions clipped to
  1,200 characters, and one product per extraction.
- This app checks every answer again before showing it (§ AI autofill in
  docs/attributes.md); the portal's checks only keep malformed answers
  from leaving it.

The portal's side is `t4a-partner-portal-api/docs/sources-api-ai.md`,
`src/services/ai/productAutofill.service.js`, and its smoke test
`scripts/sources-api-ai-smoke.js`.

## AI categorization per source

Whether a source's new products are put to AI autofill as they arrive is
this app's setting, not the portal's: it is about this app's product types.
`source_autofill` holds one row per shop and portal source id (`enabled`,
`fillAttributes`, `autoApply`); no row is off.

- **Where.** **Sources › AI categorization** (`/app/sources/categorization`,
  also in the Sources header) lists every source with a switch and, while
  on, what to fill — *Product type and attributes* or *Product type only* —
  and when to apply it — *Apply when confident* or *Wait for review* —
  each row saved as it changes. It opens with what the feature needs (the
  portal connected; product types to sort into, and how many have
  attributes) and how many suggestions wait on Review. Each source's page
  has the same setting as a card in its sidebar.
- **When.** products/create fans out to `source-product-autofill`
  (`jobs/handlers/source-product-autofill.ts`, guarded by webhook id). A
  product carrying `portal-source:<id>` whose source is on is queued with
  `requestAutofill`, recorded as requested by `source:<id>`, with the
  source's choice of what to fill; the suggestion waits for review like
  every other, unless the source applies confident suggestions on its own
  (`autoApply`, docs/attributes.md § AI autofill). A source that is off, a
  product without the tag, or a portal that cannot be asked is passed over
  quietly.
- **Which products.** Every product a source creates, once the portal tags
  each created product with `portal-source:<id>` whether or not it is held
  for review (the portal's `sources-api.md` § Review before publish).
  Products created before that carry no tag and are autofilled from
  Products or a product page instead. The page says so.

## Required scopes

`write_products` (already held) for approving a product under review.
Nothing else: the portal reads and writes the store through its own
Shopify install, and approving needs no publication scope because the
portal has already published the product to its channels.

## Known limits

- `portalUrl` must be an absolute URL. The portal leaves the key out when
  its `SHOPIFY_PORTAL_RETURN_URL` is unset or relative; this app's schema
  stays strict and rejects a relative value (`tests/unit/export-portal-contract.test.ts`).
  A run always names its source: the portal answers 404 for one that records
  none, never `sourceId: ""`.
- Harmless differences kept on purpose: the portal never sends the run
  statuses `queued` or `cancelled` (this app accepts them); this app maps a
  429 although the portal never sends one; `downloadUrl` and `createdAt` are
  always null (both optional here).
- Recorded replies of the real portal routes are in
  `tests/fixtures/export-portal/` (checksums in its README) and parsed by
  `tests/unit/export-portal-fixtures.test.ts`.
- Not yet run against the real Recharge store: the portal side is verified
  by its smoke tests with Shopify and the model stubbed
  (`docs/project-status.md` T-27). The AI calls have never answered from
  the real model.
- The portal must be installed on the store as well, so the store has two
  Shopify installs. Feeding the portal from this app instead (so only this
  app is installed) would need an ingestion mode in the portal that other
  partners do not use; deliberately not started.
- A source's schedule is the portal's catalogue refresh (for a catalogue
  export) or the feed's own import schedule (for a brand feed); it cannot be
  set per source from here. The source page states it and has no Edit for
  it.
- This app knows a field's type, never its meaning. The one dependency it
  reads is the shape of a group: a group that opens with a switch and goes
  on to inputs is a feature and its settings, and the settings fold away
  while the switch is off (`leadingSwitch`). Any other dependency — or a
  preview of what a price setting comes to — would have to be part of the
  contract first.
- The list has no row selection or bulk actions: the design system's table
  offers none, and a custom one is not worth it for the count of sources a
  store has.
- No cache of the source list: every page load is one call to the portal.
- Runs cannot be cancelled from here; the contract has no cancel yet.
- A secret cannot be cleared from here, only replaced.
- Review before publish is built on both sides (portal: the
  `reviewNewProducts` field under _Products the portal creates_, the tags,
  leaving `status` alone on updates, keeping the review tags when it
  maintains tags; its `sources-api.md` § Review before publish). Only
  products are held: a new variant on a product that is already live goes
  live with it.

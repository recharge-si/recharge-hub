# Product setup

The attribute schema: what information every product type needs, decided
once and inherited down a tree of types. It is the **Product setup** entry in
the primary navigation, named for the whole job — product types, their
attributes, reusable sets and the Shopify mappings — rather than for one of
its tables.

It is planning data. The product setup screens neither read nor write Shopify:
the Shopify field key on an attribute names where a metafield definition would
be created later, and the Shopify category on a type is a note. Turning the
plan into definitions is a later piece of work, not a setting here. The plan
meets Shopify in three places: the product page, where a person enters a
product's values by hand (*On the product page*); AI autofill, which
suggests them for a person to apply (*AI autofill*); and the store menu,
made from the type tree when a person asks (*Store menu*).

## Document

One document per shop, `domain/attributes/types.ts`:

| Collection             | One row is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `types`                | A node of the tree. `leaf` means products can use it; otherwise it only organises. `sortOrder` orders siblings. |
| `sets`                 | A named bundle of attributes, attached to a type as one.                |
| `attributes`           | One field: data type, unit, scope (product or variant), Shopify field `key`, default requirement, flags, and for a select type its `valueListId`. `setId` is optional. |
| `setAssignments`       | Set *S* is attached on type *T*.                                        |
| `attributeAssignments` | Attribute *A* is attached on type *T* directly.                         |
| `overrides`            | On exactly type *T*, attribute *A* is required or optional, with a reason. |
| `exclusions`           | On exactly type *T*, attribute *A* is hidden.                           |
| `valueLists`           | The options of a select attribute: code, English label, Slovenian label. |

Data types are codes (`text`, `integer`, `decimal`, `boolean`,
`single_select`, `multi_select`, `measurement`, `reference`, `date`); the
merchant-facing names live in `web/lib/attributes.ts`.

`domain/attributes/schema.ts` is the boundary. `parseAttributeSchema` accepts
this shape (`version: 1`) and also the standalone HTML builder's own files
(its versions 1–3, collections keyed by id, `groups`/`assignments`/
`directAssignments`/`valuelists`, data types as labels), translating them on
the way in, so a schema planned in the builder loads here unchanged.
`schemaProblems` then checks meaning: every reference resolves, no type is its
own ancestor, no rule is stated twice, every option has a unique code. A
document that fails either is never stored.

## Inheritance

`domain/attributes/resolve.ts`. For a type, walk from it to the root. The
first type on that walk with a set attached supplies the set's attributes; the
first with an attribute attached directly supplies that attribute; when both
supply one attribute, the nearer source wins. That is the type's *candidate*
attributes, each carrying the type it came from.

Two things are for the exact type and pass to nothing beneath it: an
*override* replaces the attribute's default requirement, and an *exclusion*
hides the attribute. Candidates minus exclusions are the *active* attributes,
required first, then by name.

`schemaHealth` reports what a person has to fix — assignable types with no
attributes, attributes no type uses, attributes with no Shopify field, select
attributes with no options, malformed or duplicate field keys, and any
integrity problem — with a count each. It describes the plan, not Shopify.

## Changes

Every change is a pure function in `domain/attributes/mutations.ts` from one
document to the next, refusing with a sentence when it cannot be made. Ids
come from an injected `IdSource`. The ones with rules worth knowing:

- **Delete a type**: children move up one level; every assignment and rule on
  the type goes, so descendants may lose fields.
- **Delete a set**: its attributes stay in the catalogue, and every type that
  had them through the set keeps them — each place the set was attached gets a
  direct assignment per attribute.
- **Attach a set** on a type lifts exclusions of its members on that type.
- **Attach an attribute** that is excluded on that type restores it instead;
  one already active is refused. **Attach several** (the picker) does the
  same per attribute and skips the ones already there.
- **Restore** an attribute whose source has since been detached attaches it
  directly, so restore always means "it is back".
- **Set a requirement** writes an override only when it differs from the
  attribute's default; `reset` removes it.
- **Save an attribute** of a select type replaces its option list; a list
  shared with another attribute (possible only through import) is forked so
  the other attribute keeps its options.
- **Delete an attribute** removes it everywhere with its rules, and its option
  list if nothing else uses it.
- **Add an attribute** of a choice format takes its options in the same step,
  so a dropdown never exists without them.

`domain/attributes/impact.ts` answers two questions before a structural
change is confirmed — what deleting a type takes from the types beneath it,
and what moving one gains and loses for it and its descendants — by running
the change on a copy and diffing every affected type's active attributes. It
also answers where the workspace stands: `empty` (nothing configured),
`partial` (only categories, or types without attributes), `issues` (checks
found something) or `ok`. Nothing configured is never reported as passing.

`web/lib/attributes.server.ts` is the one path every screen changes the
document through: read, check the revision the form was made against, apply
the change, check the result whole, write conditionally, log one event
(`attribute_schema.*` on `event_log`).

## Persistence

`attribute_schema`: one row per shop holding the whole document as JSON and an
integer `revision`. A read hands back the revision; every write says which
revision it was made against and is a conditional update (`updateMany ...
where revision = expected`), the first write creating the row under the unique
`shop_id`. The loser of a race is told to reload rather than quietly winning.
`tests/db/attribute-schema.test.ts` holds the row to that.

The document is held whole rather than in seven tables because it is edited by
one person in one sitting, exported as one file, and every change is a
function over all of it; a normalised form would make each of those harder for
no query that anything needs yet.

## Screens

Every hub page opens with the workspace's own navigation — Product types |
Attributes | Attribute sets | Store menu | Settings — as links, the current
one stated.
Product types goes to the bare tree; a type is a dialog over it, named in
the address while it is open.

| Route                                        | What it is                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `/app/product-setup`                         | Lands on product types.                                                    |
| `/app/product-setup/types/:typeId?`          | The tree, full width: search, expand and collapse, a drag handle per row (drop on a row's middle to nest beneath it, on its top or bottom quarter to place beside it; a change of parent is confirmed with what it changes, a reorder just happens; a dashed zone takes a nested type to the top level). Opening a row — or its edit button — puts the type in the address and opens **the type dialog**: name, parents, a summary, an actions menu (add child, move to, move up or down, delete) and three tabs, **Attributes** (the table with requirement per row and a row menu; *Add attributes* becomes a step with a multi-select of attributes and sets; *New attribute* and an attribute's name become steps too, so nothing opens a second dialog), **Details** (name, parent with the move's consequences stated live, kind, Shopify category) and **Preview**. Closing the dialog returns to the bare tree. A missing type id returns to the tree. |
| `/app/product-setup/attributes`              | The catalogue: name, format, where used, Shopify field. Search is kept in `?q=`. New attribute is one dialog, complete with options, unit and where to add it; a name opens the same form as a dialog to edit in place, with a two-step delete inside it. |
| `/app/product-setup/attributes/:attributeId` | The focused editor with a breadcrumb back, the same form as creation plus the flags, the types it is on, and the one delete that reaches everywhere. |
| `/app/product-setup/sets`                    | Sets with members and where each is attached; new and edit (name, description and which attributes belong, ticking one that is in another set moves it), delete, attach, detach. |
| `/app/product-setup/menu`                    | The store menu: a preview of the menu the tree makes, folded to its top level with a chevron per branch and *Expand all* / *Collapse all* (entries link their collections once made), **Make menu** / **Update menu**, the run's progress while it works (live), and the result with a link to the menu in Shopify. |
| `/app/product-setup/settings`                | The checks in their four states, export and import (CSV and JSON), planning with an AI assistant (the steps and the prompt to copy or download), exceptions single types have made, and starting again. |
| `/app/product-setup/schema.json`             | The JSON export, fetched by `DownloadButton` so the session token travels with it. |
| `/app/product-setup/schema.csv`              | The CSV export, fetched the same way; an empty plan is the header row, the template. |

Consequences are stated where the action is taken, in numbers from
`impact.ts`: a delete confirmation says how many children move up, what
attached here goes with it and how many fields the types beneath lose; a move
says what the type and its descendants gain and lose. Removing an attribute
from one type, detaching a source and deleting the definition are three
different actions in three different places.

The starter example (`domain/attributes/starter.ts`) is loaded only when a
person asks for it.

## Import and export

Two formats, one import button. JSON (`product-setup-YYYY-MM-DD.json`) is
the stored document exactly, the backup. CSV (`product-setup-YYYY-MM-DD.csv`,
`domain/attributes/csv.ts`) is the same plan as one table for a spreadsheet
or an AI assistant. Import reads a file chosen on the settings page (a `.csv`
name, or content that does not start like JSON, is CSV), checks it whole on
the server, and replaces the document after a confirmation that names what is
being replaced. A rejected file changes nothing and the reason is shown.
Files from the standalone builder import through the translation described
under *Document*.

The CSV has one header (`CSV_COLUMNS`) and one row per thing, the `record`
column saying which:

| record        | Names                                  | Carries                                                                 |
| ------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `type`        | `type`: the path, `A > B > C`          | `assignable` (empty: yes when it has no children), `shopify_category`   |
| `set`         | `set`                                  | `description`                                                           |
| `attribute`   | `attribute`, its `set`                 | `format` (code, or a merchant name such as *Single choice*), `unit`, `level`, `shopify_field`, `required`, `filterable`, `searchable`, `comparable`, `native`, `description` |
| `option`      | `attribute`                            | `code` (empty: slug of the label), `label_en`, `label_si`; in order      |
| `attach`      | `type`, and `set` or `attribute`       |                                                                         |
| `requirement` | `type`, `attribute`                    | `required` yes or no, `description` as the reason                       |
| `remove`      | `type`, `attribute`                    |                                                                         |

Everything is referenced by name, never by id; ids are made fresh on import.
A type path creates its ancestors; siblings keep the order of the file.
Attribute names must be unique in the file. A comma, semicolon or tab
delimiter and a byte order mark are all read. Every row is read before
anything is refused, so a rejected file lists each wrong row by number (the
first twenty), and the built plan is then held to `parseAttributeSchema` like
any other document. Export then import gives back the same plan.

### Planning with an AI assistant

The settings page explains the round trip — export CSV, paste the prompt
into Claude with the file and a description of the products, import what
comes back — and offers the prompt to copy or download
(`web/lib/attribute-ai-prompt.ts`). The prompt states the columns, record
kinds, formats and planning rules, and carries the starter plan run through
the real exporter as its example, so the example always imports. The app
calls no AI for this; the person carries the file both ways.

## On the product page

The product workspace (docs/architecture.md § Product workspace) reads the
plan for one product. Its type is, in order: the type a person chose for it
on the **Attributes** tab (`product_type_assignment`, one row per shop and
product, ignored once the type leaves the plan or stops being assignable);
the assignable type whose Shopify category is the product's category (name or
full path); the one whose name or path is the product's Shopify product type.
Two candidates are reported, not guessed between. Choosing a type saves at
once (`choose-type`), and *Match automatically* removes the choice.

The type's active attributes — inheritance, overrides and exclusions as
`activeAttributes` resolves them — are shown grouped by set against the
product's metafields under each attribute's Shopify field key, with the
required ones counted (`attributeCompleteness`, `domain/products/workspace.ts`).
A variant-level attribute is complete when every variant has it, and is
entered per variant.

Values are entered on the Attributes tab and saved with the page's save bar,
in the same `save` as the product's other fields
(`domain/products/attribute-values.ts`, `web/lib/product-attributes.server.ts`).
The Shopify type each value is written as is, in order: the shop's metafield
definition for that owner and key, the type of a value already stored, then
the attribute's format (text and single select → single line text, multi
select → list of single line text, integer, decimal, boolean, date; a
measurement whose unit is a length, weight or volume Shopify knows → that
measurement type, otherwise a decimal). A select stores option codes. A field
this page cannot write faithfully — a reference, rich text, JSON, a list with
no options, an unmapped or malformed key — shows what Shopify holds and why
it is changed elsewhere. An emptied field deletes the metafield. The save
re-reads the plan, the type and the live values, refuses when the type changed
or a value it changes was changed in Shopify since the page loaded, and logs
`product.details_edited` (and `product.type_chosen` for a choice).

## Store menu

The type tree as a Shopify navigation menu for the store's header, made on
request from the **Store menu** page. Nothing in it is AI; it is the tree.

- **The type field.** Each product carries its type and every type above
  it, top level first, in the product metafield `recharge.product_type_path`
  (list of single line text) — tags a shopper never sees. Its definition is
  created at runtime, because the capability that lets automated collections
  match on it (`smartCollectionCondition`) cannot be set in TOML. A
  product's type is the one the product page would show (`typeForProduct`:
  chosen, else category, else Shopify product type); a product two types
  claim keeps what it holds. Only changes are written (`typeFieldChanges`,
  against the catalogue's copy of the field), so a type moved in the tree
  rewrites the products beneath it, and a product that lost its type has the
  field deleted. Choosing a type on the product page writes the field at
  once when the menu exists; clearing a choice queues an update. Every
  write is copied into the catalogue's copy of the field, so the next run
  compares against what Shopify holds rather than rewriting every product
  until the next catalogue read.
- **Collections.** Every type gets an automated collection, titled as the
  type, whose one conditions source takes the products whose path includes
  the type (`metafieldStringList`, `INCLUDES`, one value). One value per
  collection keeps every branch, however large, inside Shopify's limit of 60
  condition values per source — the first version listed every type beneath
  a parent and broke on large branches. A collection made before and still
  titled as its type (on the same field definition) is left alone; one whose
  type was renamed is renamed and its source replaced; one a merchant deleted is made again; only new
  ones are published to the online store (the publication whose catalog
  title is *Online Store*). Description, image and handle are the
  merchant's.
- **The first version's field.** `recharge.product_type_id` (one type id
  per product) is deleted with its values at the end of a run, once no
  collection matches on it; a refusal is logged, not shown.
- **The menu.** `menuTree`: the tree in sibling order, starting below a
  single root, three levels deep (Shopify's limit); a deeper type is not an
  entry but its products are in its level-3 ancestor's collection. The menu
  is titled *Product types*, handle `product-types`; the one this app made is
  updated, else one with that handle is taken over, else one is created. Its
  items are replaced whole on every run.

**Automatic updates.** Once the menu has been made (the row has a menu id),
it follows changes without a press (`requestTypeMenuUpdate`,
`adapters/products/type-menu-updates.server.ts`): a save that changes the
type tree, a cleared product type, a `products/update` that changed the
catalogue, and every catalogue snapshot each queue an `automatic` run one
minute later, under its own singleton key (`typeMenuAutoKey`) so a burst of
changes is one run and a waiting update never swallows a press. An automatic
run claims the row as a press does; if a run is moving it queues itself
again behind it. With nothing changed a run is a handful of reads and one
menu write.

The run is the `type-menu-sync` job (`jobs/handlers/type-menu-sync.ts`,
Shopify calls in `adapters/shopify/type-menu.ts`): type field, then
collections, then menu, its phase and counts on the shop's
`product_type_menu` row, which also remembers the definition, the menu and
`{ typeId: { collectionId, sourceId } }`. A product the catalogue still holds
but Shopify has deleted is skipped and counted in the result, not a failure
(Shopify refuses a whole `metafieldsSet` call for one missing owner, so a
refused batch is retried product by product). A run that has written no progress for 15 minutes is closed as failed the
next time the page reads it (a live run writes every few seconds), and a run
whose job cannot be queued is failed at once, so *Making the menu* never
spins for ever. A press while a run is moving is
refused (a run silent for 30 minutes no longer blocks). Each collection is
recorded as soon as it exists, so a failure part way never duplicates one.
A refusal Shopify explains — a permission not yet approved, a rejected
input — is shown on the page and not retried; anything else is retried by
the queue. The finished run logs `attribute_schema.menu_made`.

## AI autofill

The export portal's AI suggests a product's type and the values of its
empty attributes; a person reviews the suggestion and applies what they
keep, or a source set to apply on its own applies a confident one (§
Applying on its own). Nothing the AI says reaches Shopify, or
`product_type_assignment`, until it is applied. The AI is the portal's (its categorizer, Claude
Haiku); this app only describes its own catalogue model to it and checks
what comes back (docs/sources.md § AI autofill).

**Asking.** *Autofill with AI* on a product's **Attributes** tab; *Autofill
with AI* on the products selected in **Products**, or *Autofill all with
AI* in its header for the whole catalogue (below); *Autofill* per row and
*Autofill selected* on **Sources › Review**; or, for a source switched on
under **Sources › AI categorization**, each new product as it arrives
(docs/sources.md § AI categorization per source). Each marks
the products `queued` on `product_autofill` and hands them to the
`product-autofill` job (`jobs/handlers/product-autofill.ts`), ten per pass,
the rest to a fresh job; at most 250 per request, and a product already
being worked on is not asked twice. Per product (`suggestAutofill`,
`adapters/products/autofill.server.ts`):

1. **Type.** A product that already has a type — chosen by a person, or
   matched by category or Shopify product type as the product page matches
   it — keeps it (`typeOrigin: kept`). The others are categorized in
   batches of ten against the plan's assignable types, each sent as its id
   and full path (`All products > Windsurf > Sails > Wave sails`); the
   answer is used only if it names one of them, with the portal's
   confidence (0–1) and one-sentence reason. "No type fits" is an answer,
   not a failure.
2. **Attributes.** For the type, the fields the product page would show
   (`readAttributeValues`), and of those only the writable ones that are
   empty — a variant attribute while any variant is empty
   (`attributesToFill`, `domain/products/autofill.ts`). Each is described by
   its format (text, integer, decimal, boolean, date, choice, choices,
   measurement), unit, options by code and label, and level. Nothing is
   asked when nothing is empty.
3. **Checking.** An answer becomes a suggestion only where a person's entry
   would be accepted in its place (`suggestedValues`): a choice is an option
   code, or a label mapped to its code; a number is read off the front of
   the text (`4,2 kg` → `4.2`), never a range; a variant value names a
   variant the product has; a field that has a value, a blocked field, an
   unknown attribute and a repeat are dropped. What is left is stored with
   its display text (labels, unit).

**Autofill all** (`requestAutofillAll`) asks about every catalogue product
the AI has not been asked about yet — no row, or a failed one; a suggestion
queued, running, waiting, applied or discarded is passed over, so a second
run resumes rather than asking again. It does not queue the catalogue at
once: one `product-autofill` job carrying `all: { after }` takes the next
ten (`nextUnaskedProducts`, in product id order), marks them queued, suggests
for them and hands over to a fresh job from the last product it looked at,
so no product waits long enough to be taken for lost. It stops at the end of
the catalogue, or as soon as the portal cannot be asked, rather than failing
every product left. Its dialog offers *Apply automatically when the AI is
confident* (on by default), which applies as a source does (§ Applying on
its own).

A product whose suggestion will never come — its job died with the worker
or never ran — is failed when it is next read (`failStaleAutofills`: running
for 30 minutes, or queued for four hours), so nothing shows *Autofilling…*
for ever; if the job cannot be queued at all, the products are failed at
once. A failure is recorded on the product it concerns (`failed`, with the
portal's words for an AI failure, this app's for anything else): the
portal not connected, a product deleted, a refused call. The pages watch
`queued` and `running` rows and update as each finishes.

**Reviewing.** The product's Attributes tab shows the suggestion above the
fields: the suggested type with its confidence and reason, and a table of
the suggested values (attribute, variant, value), every line ticked; a
person unticks what is wrong and presses *Apply selected*, or *Discard*.
Apply is disabled while the page has unsaved edits. On **Sources ›
Review**, the *Type and attributes* column says what is waiting
(`Suggested: Type and 4 values`, with the confidence), links to the
product to review it, and *Apply* / *Apply suggestions* applies everything
suggested for those products: up to 25 while the page waits, up to 250
in the background (`requestApplyAutofill`). **Products** shows
the same under each title (*AI suggestion · Type and 2 values*,
*Autofilling…*, *Autofill failed*), has an *AI review* view of the products
whose suggestions wait, and the same *Apply suggestions* / *Autofill with
AI* for the products selected. The AI review view also has *Apply all*,
which applies every suggestion waiting in the background: a
`product-autofill` job carrying `apply: { ids: null, after }` applies the
next ten (`nextReadyAutofills`, in product id order) and hands over from the
last, so a suggestion Shopify refuses stays waiting and is stepped over
rather than tried for ever. The page re-reads every few seconds while it
runs.

**Applying** (`applyAutofill`) goes through the paths a person's own edits
take: the kept type through `chooseProductType` (the assignment, recorded
as chosen by the person who applied it, and the store menu field), then the
kept values through `attributeChanges` and `metafieldsSet`, filling only
fields that are still empty — a value someone entered since wins. Values
are written only if the product's type is the one they were suggested for;
a person who rejected the type keeps their attributes untouched. The row
becomes `applied` (or `discarded`) once, so a second tab cannot apply what
the first discarded, and `product.autofill_applied` is logged.

**Applying on its own.** A source switched to *Apply when confident*
(`source_autofill.autoApply`, docs/sources.md § AI categorization per
source) has its suggestion applied the moment it is saved, through the same
`applyAutofill` with every value kept, when `confidentEnough` says so: a
type the categorizer chose with confidence of at least
`AUTO_APPLY_CONFIDENCE` (0.8), or a type the product already had with at
least one value to fill. "No type fits" and anything less sure wait on
Review as usual. The type is recorded as chosen by `source:<id>`, the event
carries `automatic: true`, and a refusal from Shopify leaves the suggestion
waiting rather than failed. The job carries the choice (`autoApply`,
`requestedBy`), so only a source's own requests and an *Autofill all*
with the box ticked apply on their own; *Autofill with AI* on chosen
products always waits for review.

## Known limits

- No undo. Every destructive change is behind a confirmation instead, and the
  export is the backup.
- Import replaces the whole plan; there is no merge. A CSV type name that
  contains `>` is read as a path, and two attributes with the same name
  export but do not import until one is renamed.
- No sharing of one option list between two attributes from the UI; each
  select attribute owns its list. Lists shared through import keep working and
  fork on first edit.
- Drag-and-drop in the tree rides on a plain wrapper element and a drag
  ghost drawn outside Polaris, because the web components own their rows'
  DOM. *Move to…* and *Move up* / *Move down* are the keyboard way.
- The requirement per row saves as soon as it is changed; the type dialog's
  details and the attribute forms save with their own button, and closing a
  dialog discards what was not saved.
- Nothing is created in Shopify from the plan yet: no metafield definitions,
  so values written without one are untyped metafields until a definition
  exists. Values are entered one product at a time; there is no bulk entry.
- A source's new products are autofilled as they arrive only when the
  source tags them (a source holding new products for review). Suggestions
  are not refreshed when the product or the plan changes afterwards; asking
  again replaces them. Variant
  values come from the variant's title and options, so a product with more
  than 100 variants is only partly filled.
- The store menu is made on request, not kept in step: after the tree or
  products' types change, *Update menu* brings it up to date. Edits made to
  the menu in Shopify are replaced by the next update. Collections of types
  deleted from the plan stay in Shopify for the merchant to remove. A
  product type matched only by a category's full path is not matched by the
  menu run, which knows only the category's name.
- A save of more than 25 values is several `metafieldsSet` calls; a refusal
  part way leaves the earlier batches written; a reload shows which.

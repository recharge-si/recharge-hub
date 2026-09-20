# Product setup

The attribute schema: what information every product type needs, decided
once and inherited down a tree of types. It is the **Product setup** entry in
the primary navigation, named for the whole job — product types, their
attributes, reusable sets and the Shopify mappings — rather than for one of
its tables.

It is planning data. Nothing in this module reads or writes Shopify: the
Shopify field key on an attribute names where a metafield definition would be
created later, and the Shopify category on a type is a note. Turning the plan
into definitions is a later piece of work, not a setting here.

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
Attributes | Attribute sets | Settings — as links, the current one stated.
Product types goes to the bare tree; a type is a dialog over it, named in
the address while it is open.

| Route                                        | What it is                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `/app/product-setup`                         | Lands on product types.                                                    |
| `/app/product-setup/types/:typeId?`          | The tree, full width: search, expand and collapse, a drag handle per row (drop on a row's middle to nest beneath it, on its top or bottom quarter to place beside it; a change of parent is confirmed with what it changes, a reorder just happens; a dashed zone takes a nested type to the top level). Opening a row — or its edit button — puts the type in the address and opens **the type dialog**: name, parents, a summary, an actions menu (add child, move to, move up or down, delete) and three tabs, **Attributes** (the table with requirement per row and a row menu; *Add attributes* becomes a step with a multi-select of attributes and sets; *New attribute* and an attribute's name become steps too, so nothing opens a second dialog), **Details** (name, parent with the move's consequences stated live, kind, Shopify category) and **Preview**. Closing the dialog returns to the bare tree. A missing type id returns to the tree. |
| `/app/product-setup/attributes`              | The catalogue: name, format, where used, Shopify field. Search is kept in `?q=`. New attribute is one dialog, complete with options, unit and where to add it; a name opens the same form as a dialog to edit in place, with a two-step delete inside it. |
| `/app/product-setup/attributes/:attributeId` | The focused editor with a breadcrumb back, the same form as creation plus the flags, the types it is on, and the one delete that reaches everywhere. |
| `/app/product-setup/sets`                    | Sets with members and where each is attached; new and edit (name, description and which attributes belong, ticking one that is in another set moves it), delete, attach, detach. |
| `/app/product-setup/settings`                | The checks in their four states, export and import, exceptions single types have made, and starting again. |
| `/app/product-setup/schema.json`             | The export, fetched by `DownloadButton` so the session token travels with it. |

Consequences are stated where the action is taken, in numbers from
`impact.ts`: a delete confirmation says how many children move up, what
attached here goes with it and how many fields the types beneath lose; a move
says what the type and its descendants gain and lose. Removing an attribute
from one type, detaching a source and deleting the definition are three
different actions in three different places.

The starter example (`domain/attributes/starter.ts`) is loaded only when a
person asks for it.

## Import and export

Export writes the stored document as `attributes-YYYY-MM-DD.json`. Import
reads a file chosen on the settings page, checks it whole on the server
(shape, then meaning), and replaces the document after a confirmation that
names what is being replaced. A rejected file changes nothing and the reason
is shown. Files from the standalone builder import through the translation
described under *Document*.

## Known limits

- No undo. Every destructive change is behind a confirmation instead, and the
  export is the backup.
- No sharing of one option list between two attributes from the UI; each
  select attribute owns its list. Lists shared through import keep working and
  fork on first edit.
- Drag-and-drop in the tree rides on a plain wrapper element and a drag
  ghost drawn outside Polaris, because the web components own their rows'
  DOM. *Move to…* and *Move up* / *Move down* are the keyboard way.
- The requirement per row saves as soon as it is changed; the type dialog's
  details and the attribute forms save with their own button, and closing a
  dialog discards what was not saved.
- Nothing is created in Shopify from the plan yet.

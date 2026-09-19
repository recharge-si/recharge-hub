# Attributes

The attribute schema: what information every product type needs, decided
once and inherited down a tree of types. It is the **Attributes** entry in the
primary navigation.

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
  one already active is refused.
- **Restore** an attribute whose source has since been detached attaches it
  directly, so restore always means "it is back".
- **Set a requirement** writes an override only when it differs from the
  attribute's default; `reset` removes it.
- **Save an attribute** of a select type replaces its option list; a list
  shared with another attribute (possible only through import) is forked so
  the other attribute keeps its options.
- **Delete an attribute** removes it everywhere with its rules, and its option
  list if nothing else uses it.

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

| Route                             | What it is                                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| `/app/attributes`                 | The catalogue: overview counts and what needs attention, every attribute with where it is used, new attribute, delete everywhere. An empty shop is offered the starter example or an import. |
| `/app/attributes/:attributeId`    | One attribute's shared definition, its options when it is a select, where it is used, and the advanced mapping (set, Shopify field, scope, implementation). Saved through the contextual save bar. |
| `/app/attributes/types/:typeId?`  | The tree beside the selected type: its active attributes grouped by where they come from, requirement per row (saved at once), remove and restore, its sources with detach, its details (save bar), and a preview of the fields a product would carry. |
| `/app/attributes/settings`        | Export and import of the whole document, the sets and where they are attached, the decisions single types have made, and starting again from the example or from nothing. |
| `/app/attributes/schema.json`     | The export, fetched by `DownloadButton` so the session token travels with it. |

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
- No drag-and-drop in the tree; a type is moved with *Under* in its details
  and ordered with *Move up* / *Move down*.
- Nothing is created in Shopify from the plan yet.

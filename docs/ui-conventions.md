# UI conventions — MetaKocka ⇄ Shopify app

## Element semantics
- **Badges are status, never configuration and never metadata.** If a merchant can change
  it, it is a control or a summary line with an edit action — not a pill.
- **Colour marks exceptions only.** No green for "normal". A zero-count problem indicator
  does not render at all. A non-zero one is the loudest element on its card and links
  through to the affected records.
- **Counts state a fact once.** Derived totals are not separate elements.
- **Raw syntax never reaches a merchant** outside the field they're editing it in. Anywhere
  else, show the resolved result for one of their own products.
- **A card whose only content is a pointer elsewhere becomes a line, not a card.**
- **Sample data is always the merchant's own.** Never fabricated examples, especially not
  next to a real preview.

## Destructive writes
- Anything that writes to the merchant's ERP — names, created articles, stock, orders —
  is preview-then-apply. The preview states counts by outcome (create / rename / unchanged
  / skipped) plus a sample, and applying is a second explicit action.
- Preview paths are strictly read-only. No writes on a render path, ever.

## Overwrite-risk pattern (one pattern, applied identically everywhere)
Any setting where turning it on means this app starts overwriting data the merchant may
maintain elsewhere gets exactly this, and nothing more:
1. One short subdued line under the control, present at all times, naming precisely what
   gets overwritten and on what cadence.
2. A warning banner that renders **only** in the unsaved-changes state, **only** when the
   merchant has just switched it from off to on, naming what will be overwritten on the
   next sync. It disappears on save and never renders for an already-on setting.
3. No third statement of the same fact anywhere on the page.
Applies to name overwrite and price overwrite identically. Neither is special.

## Setup state
- **One readiness model, one wording.** Whether a shop is configured is answered
  by `domain/readiness` and nowhere else. A page that needs it renders
  `ReadinessList` or reads a component from it; it never re-derives "configured"
  from a credential row and a count.
- **Healthy is calm.** No green banners and no green badges. A ready component
  is a neutral badge and a sentence; the one that needs a person is the loudest
  element on the screen and is the only one carrying a button.
- **Configured and started are different questions.** Readiness answers the
  first from the configuration; `shop.setup_completed_at` answers the second and
  answers nothing else. A screen that reports one must not imply the other.
- **State what another page owns; do not re-edit it.** A setting that belongs to
  another screen appears as a line saying what it currently is, plus a link. Two
  editable copies of one value is how two screens end up disagreeing.
- **Stated, not switched.** A status that follows from other settings is a line,
  never a control. A toggle that only ever reflects something else is a lie with
  a checkbox next to it.

## Page header
Every page that owns a background process opens with the same component:
healthy / needs attention · when it last ran and the outcome · automatic or manual ·
when it next runs. Same component on every such page. If two pages answer this
differently, that's a bug.

## Copy
- Sentence case, active voice, verb-first buttons. No exclamation marks, no "successfully".
- One term per concept. Fix the glossary in the doc when you write it, from what the code
  actually calls things, and use it everywhere. The current pages drift between variant,
  SKU, product and article inside a single card.
- Explanatory prose is a last resort. One short sentence per card plus an optional help
  link. If a card needs two paragraphs to be understood, the layout is wrong.

## Patterns
A merchant edits two patterns — the product name and the order reference — and they are
edited the same way: one syntax (`{field}`), one control (`PatternEditor`), fields as
chips offered while typing, and every field showing what it comes to for a real record of
theirs. The control knows the syntax and nothing about what the pattern is about; the page
tells it which fields exist and what they resolve to.

A preset is a selectable row showing what it produces for one of the merchant's real
records. Never a bare text link.

## Custom controls
Any control not built from the design system's primitives carries a real label, correct
roles, keyboard parity with the native equivalent, and announces state changes. It ships
with a documented reason why a primitive wouldn't do.

---

## Glossary

Everything above is transcribed as written. This section is not: the Copy rule asks for a
glossary built "from what the code actually calls things", so it is derived from the
schema, the adapters and the job names, and it is the part of this document most likely to
need correcting.

The rule is one term per concept **in merchant-facing copy**. Where the code's own name
differs it is given, because the code is not going to be renamed to match.

| Term | Means | Code calls it |
|---|---|---|
| **SKU** | The code that identifies one sellable item on both sides. Shopify's variant SKU and MetaKocka's product `code` are the same string; that is what a match is. | `Sku.sku`, MetaKocka `code` |
| **Variant** | The Shopify record. Used whenever the Shopify side of a match is meant, because "product" is taken. | `productVariants`, `VariantFacts` |
| **MetaKocka product** | The ERP catalogue record. Always qualified with "MetaKocka", never shortened to "product" on a page that also talks about Shopify. | `MetakockaProduct`, `product_add` |
| **Name** | The MetaKocka product's `name` — the thing this app writes. Never "title". | `name` |
| **Title** | Shopify's customer-facing product title. Only ever an input to a name, never the output. | `product.title`, `{title}` |
| **Name pattern** | What the merchant edits to decide how a name is built. Never "template" in copy. | `nameTemplate`, `TemplateNode[]` |
| **Reference pattern** | What the merchant edits to decide how the order reference is built. Same syntax and same editor as a name pattern. | `customerOrderTemplate` |
| **Field** | One piece of Shopify data a name pattern can insert. Never "token" in copy. | `FieldDef`, `kind: "token"` |
| **Matching** | Reading both catalogues and pairing them by SKU. Writes nothing to MetaKocka. | job `sync-catalogue` |
| **Name sync** | Writing names into MetaKocka, and creating products for unmatched SKUs when that is on. | job `sync-products` |
| **Needs attention** | A condition a person has to deal with, on the exceptions queue and in readiness. Never "exception" in copy. | `Exception`, `exception_kind` |
| **Setup** | The guided flow, and the state of being configured. Never "onboarding" in copy. | `/app/setup`, `setup_completed_at` |
| **Payment method** | The Shopify side of a payment mapping, as a merchant reads it. "Gateway" is the handle beneath it and stays where the handle is shown. | `Order.paymentGateway`, `PaymentTypeMap.shopifyGateway` |
| **Pricelist** | A MetaKocka pricelist, referenced by the `count_code` it already has there. Net or gross is a property of the pricelist, not of Shopify. | `pricelistCode` |

Words that must not appear in merchant-facing copy: **article** (the build
specification's word for a MetaKocka product), **token**, **template**, **code**
meaning a SKU.

/**
 * How a MetaKocka product name is built from a Shopify variant.
 *
 * The engine moved to `domain/products/template`, which added filters,
 * metafields, lint and rules. This file stays as the surface the sync job and
 * the settings screen already import, and as the home of the pieces that are
 * about *presenting* templates rather than evaluating them: the token list, the
 * presets, and the click-together builder.
 *
 * `[...]` groups still mean what they always meant — a group disappears when
 * every token inside it resolved empty — so every template already stored keeps
 * rendering exactly as before. That was checked against a generated corpus of
 * roughly nine thousand template-and-variant combinations before the switch,
 * not assumed.
 */
import {
  PRODUCT_FIELDS,
  VARIANT_FIELDS,
  parseTemplate as parseNodes,
  renderName as renderWithEngine,
  MAX_NAME_LENGTH,
  type VariantFacts,
} from "./template";

export type { VariantFacts };
export { MAX_NAME_LENGTH };

export interface NameToken {
  token: string;
  label: string;
  /** What it produces for the example on the settings screen. */
  example: string;
}

/**
 * The example values are a last resort only. The settings screen previews
 * against real variants from the shop and falls back to these solely when the
 * catalogue is empty, because a preview built from invented data is worse than
 * no preview.
 */
const EXAMPLES: Record<string, string> = {
  title: "T-Shirt",
  options: "L Blue",
  option1: "L",
  option2: "Blue",
  option3: "Cotton",
  option1name: "Size",
  option2name: "Colour",
  option3name: "Material",
  variant: "L / Blue",
  sku: "TS-001-L",
  barcode: "3830000000001",
  vendor: "Acme",
  type: "Shirts",
  handle: "t-shirt",
  price: "19.90",
};

/** Everything a template can reference, shown so nobody has to guess a name. */
export const NAME_TOKENS: NameToken[] = [...PRODUCT_FIELDS, ...VARIANT_FIELDS]
  .map((field) => ({
    token: `{${field.id}}`,
    label: field.label,
    example: EXAMPLES[field.id] ?? "",
  }))
  // Title first, then the variant-level fields, matching how a name reads.
  .sort((a, b) => (a.token === "{title}" ? -1 : b.token === "{title}" ? 1 : 0));

export const DEFAULT_NAME_TEMPLATE = "{title}[ {options}]";

/**
 * Renders one product name. Never throws: a template a merchant typed badly
 * produces a visible result in the preview rather than a failed sync.
 */
export function renderName(
  template: string,
  facts: VariantFacts,
  maxLength = MAX_NAME_LENGTH,
): string {
  return renderWithEngine(template, facts, { maxLength });
}

/** The example used for the live preview when the shop has no variants yet. */
export const EXAMPLE_VARIANT: VariantFacts = {
  productTitle: "T-Shirt",
  variantTitle: "L / Blue",
  optionValues: ["L", "Blue"],
  optionNames: ["Size", "Colour"],
  sku: "TS-001-L",
  barcode: "3830000000001",
  vendor: "Acme",
  productType: "Shirts",
  handle: "t-shirt",
  price: "19.90",
};

/* -------------------------------------------------------------------------- */
/* Building a template without typing one                                      */
/* -------------------------------------------------------------------------- */

/**
 * The settings screen builds the template from pieces the merchant clicks
 * together, so nobody has to learn the syntax. A piece is either a token
 * (`{title}`) or a bit of their own text, and the separator goes between them.
 *
 * Every piece after the first is wrapped in a `[...]` group with the separator
 * inside it, which is what makes "T-Shirt" come out clean when a product has no
 * options instead of "T-Shirt -".
 */
export interface TemplatePieces {
  pieces: string[];
  separator: string;
}

export interface SeparatorChoice {
  value: string;
  label: string;
}

export const SEPARATORS: SeparatorChoice[] = [
  { value: " ", label: "Space" },
  { value: " - ", label: "Dash" },
  { value: " / ", label: "Slash" },
  { value: ", ", label: "Comma" },
  { value: " | ", label: "Pipe" },
  { value: "", label: "Nothing" },
];

export function buildTemplate({ pieces, separator }: TemplatePieces): string {
  const kept = pieces.filter((piece) => piece.trim() !== "");
  if (kept.length === 0) return "";

  return kept
    .map((piece, index) => (index === 0 ? piece : `[${separator}${piece}]`))
    .join("");
}

const TOKEN_ONLY = /^\{[A-Za-z0-9_]+\}$/;

/**
 * Reads a template back into pieces so the builder can show what is stored.
 * Returns null when the template was hand-written into something the builder
 * cannot represent, and the screen then offers plain text editing instead of
 * silently rewriting what the merchant wrote.
 */
export function parseTemplate(template: string): TemplatePieces | null {
  const trimmed = template.trim();
  if (trimmed === "") return { pieces: [], separator: " " };

  const segments = trimmed.match(/\[[^[\]]*\]|[^[\]]+/g);
  if (!segments) return null;

  const pieces: string[] = [];
  const separators: string[] = [];

  for (const [index, segment] of segments.entries()) {
    if (!segment.startsWith("[")) {
      // Only the first segment may sit outside a group; anything else means a
      // shape this builder did not produce.
      if (index !== 0) return null;
      if (!TOKEN_ONLY.test(segment) && segment.includes("{")) return null;
      pieces.push(segment);
      continue;
    }

    const inner = segment.slice(1, -1);
    const match = inner.match(/^(.*?)(\{[A-Za-z0-9_]+\})$/);

    if (match) {
      separators.push(match[1] ?? "");
      pieces.push(match[2] ?? "");
      continue;
    }

    // A group of plain text: the separator cannot be told apart from the text.
    return null;
  }

  const distinct = [...new Set(separators)];
  if (distinct.length > 1) return null;

  return { pieces, separator: distinct[0] ?? " " };
}

/** True when the template has something the parser could not make sense of. */
export function templateErrors(template: string) {
  return parseNodes(template).errors;
}

/** Ready-made patterns, so the common cases are one click. */
export const TEMPLATE_PRESETS = [
  {
    id: "title-options",
    label: "Product title and options",
    template: "{title}[ {options}]",
  },
  {
    id: "title-dash-options",
    label: "Product title, dash, options",
    template: "{title}[ - {options}]",
  },
  {
    id: "title-options-sku",
    label: "Product title, options and SKU",
    template: "{title}[ {options}][ {sku}]",
  },
  {
    id: "vendor-title-options",
    label: "Vendor, product title and options",
    template: "{vendor}[ {title}][ {options}]",
  },
];

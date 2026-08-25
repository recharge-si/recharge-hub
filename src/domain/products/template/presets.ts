/**
 * Ready-made name patterns, and the one a new shop starts with.
 *
 * These are patterns, not examples: the settings screen renders each one
 * against a real product from the merchant's own catalogue and shows the name
 * it would produce, so choosing one is a decision about their data rather than
 * about syntax. Nothing here carries a sample value — that would be a
 * fabricated example sitting next to a real preview (`docs/ui-conventions.md`).
 *
 * Pure data (section 5): no I/O, no imports from adapters.
 */
export interface NamePattern {
  id: string;
  /** Short enough to read at a glance on a card. */
  label: string;
  pattern: string;
}

/**
 * What a shop gets before anyone opens the settings screen. The options group
 * collapses on a product that has none, so a single-variant product is called
 * by its title alone rather than "Gift card -".
 */
export const DEFAULT_NAME_PATTERN = "{title}[ {options}]";

export const NAME_PATTERNS: NamePattern[] = [
  {
    id: "title-options",
    label: "Title and options",
    pattern: "{title}[ {options}]",
  },
  {
    id: "title-dash-options",
    label: "Title, dash, options",
    pattern: "{title}[ - {options}]",
  },
  {
    id: "title-options-sku",
    label: "Title, options and SKU",
    pattern: "{title}[ {options}][ {sku}]",
  },
  {
    id: "vendor-title-options",
    label: "Vendor, title and options",
    pattern: "{vendor}[ {title}][ {options}]",
  },
];

/**
 * The shapes the name-template engine passes around.
 *
 * Pure (CLAUDE.md section 5): no I/O, no clock, no randomness. The template
 * itself stays a plain string in the database — diffable, greppable, easy to
 * send over an API. Everything here is derived from that string on demand and
 * never stored.
 */

/** One filter applied to a token, with its arguments already unquoted. */
export interface FilterCall {
  name: string;
  args: string[];
}

export interface NodeSpan {
  /** Index of the first character in the source template. */
  start: number;
  /** How many characters of the source this node covers. */
  length: number;
}

export type TemplateNode =
  | ({ kind: "literal"; text: string } & NodeSpan)
  | ({
      kind: "token";
      field: string;
      filters: FilterCall[];
    } & NodeSpan)
  /**
   * `[...]` — vanishes entirely when every token inside it resolved empty.
   *
   * This predates the filters and is kept because it says something they
   * cannot: `[ ({option1}/{option2})]` drops the brackets, the slash and the
   * space together when a product has no options, and no combination of
   * `prefix`/`suffix` on either token expresses that.
   */
  | ({ kind: "group"; children: TemplateNode[] } & NodeSpan);

export type ParseErrorCode =
  | "unclosed_token"
  | "unclosed_group"
  | "unexpected_group_close"
  | "empty_field"
  | "bad_field"
  | "nested_group"
  | "unknown_filter"
  | "bad_filter_args";

export interface ParseError extends NodeSpan {
  code: ParseErrorCode;
  /** Written for the merchant, not the log (section 2.8). */
  message: string;
}

export interface ParseResult {
  nodes: TemplateNode[];
  errors: ParseError[];
}

/**
 * Everything a template can read from one Shopify variant.
 *
 * `metafields` is keyed `namespace.key`. It is a plain map rather than a typed
 * shape because which metafields exist is the merchant's business, resolved
 * from the shop's definitions at the boundary and never hardcoded.
 */
export interface VariantFacts {
  productTitle: string;
  /** Shopify's variant title: "L / Blue", or "Default Title" when there is none. */
  variantTitle: string | null;
  /** Option values in order, already stripped of Shopify's placeholder. */
  optionValues: string[];
  /** Option names in order: "Size", "Colour". */
  optionNames: string[];
  sku: string;
  barcode: string | null;
  vendor: string | null;
  productType: string | null;
  handle: string | null;
  /** Shop-currency decimal string, as Shopify reports it. */
  price: string | null;
  metafields?: Record<string, string>;
  /** Present when the facts came from Shopify; used to report lint samples. */
  variantId?: string;
  productId?: string;
  /** How many variants the product has, for the "no variant field" warning. */
  variantCount?: number;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  /** Written for the merchant: what is wrong and what to do about it. */
  message: string;
  /** How many previewed variants this affects. */
  count: number;
  /** A few SKUs, so the merchant can go and look. */
  sampleIds: string[];
}

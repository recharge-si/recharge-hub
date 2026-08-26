/**
 * The reference a Shopify order carries into MetaKocka (CLAUDE.md §3, §8.4).
 *
 * MetaKocka shows this as *Customer's order* on the document. The verified
 * behaviour is awkward and shapes everything here: the field literally named
 * `customer_order` is **silently discarded**, while `buyer_order` persists and
 * is the only reference `get_document` can search by. So the merchant-visible
 * "Customer's order" value and the app's sibling-linking key are the same
 * string, sent as `buyer_order`.
 *
 * Two rules that are not negotiable:
 *
 *  - **This is a reference, never an identity.** Synchronisation identity is
 *    `shopify_order_id` and the `(shop_id, count_code)` claim. The template can
 *    be changed by the merchant at any time; nothing may look an order up by
 *    what it renders to.
 *  - **It is rendered once, at intake, and stored.** `order.customer_order_ref`
 *    is what every document of that order carries and what the ambiguous-write
 *    recovery searches for. Re-rendering it later — after a template change, or
 *    after the customer's email was redacted — would orphan documents MetaKocka
 *    already holds.
 *
 * Pure (§5): no clock, no database, no randomness.
 */

/** What a template may refer to. Deliberately small and all merchant-visible. */
export interface OrderReferenceContext {
  /** Shopify's display name, `#1050`. */
  name: string | null;
  /** Shopify's order number, `1050`. */
  number: string;
  /** The numeric Shopify order id. */
  id: string;
  customerEmail: string | null;
}

/**
 * The default, and the value every order written before this setting existed
 * already carries. Changing it must not change existing orders.
 */
export const DEFAULT_CUSTOMER_ORDER_TEMPLATE = "SH-{{order.number}}";

interface Placeholder {
  readonly token: string;
  readonly label: string;
  readonly of: (context: OrderReferenceContext) => string | null;
}

/**
 * Every placeholder there is. A token outside this list is left in the output
 * untouched rather than silently blanked, so a typo is visible on the settings
 * screen's preview instead of producing an unexplained reference in the ERP.
 */
export const ORDER_REFERENCE_PLACEHOLDERS: readonly Placeholder[] = [
  {
    token: "order.name",
    label: "Shopify order name, such as #1050",
    of: (context) => context.name,
  },
  {
    token: "order.number",
    label: "Shopify order number, such as 1050",
    of: (context) => context.number,
  },
  {
    token: "order.id",
    label: "Shopify order id",
    of: (context) => context.id,
  },
  {
    token: "customer.email",
    label: "Customer email address, when the order has one",
    of: (context) => context.customerEmail,
  },
];

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const BY_TOKEN = new Map(
  ORDER_REFERENCE_PLACEHOLDERS.map((placeholder) => [
    placeholder.token,
    placeholder,
  ]),
);

/** The tokens a template uses that no placeholder answers. */
export function unknownPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const token = match[1] ?? "";
    if (!BY_TOKEN.has(token)) found.add(token);
  }
  return [...found];
}

/**
 * MetaKocka has not documented a length limit for `buyer_order`, and a
 * reference long enough to be truncated somewhere unseen is a reference that
 * stops linking siblings. Bounded here rather than discovered in production.
 */
export const MAX_ORDER_REFERENCE_LENGTH = 60;

/**
 * Renders one order's reference.
 *
 * A placeholder with nothing behind it — an order with no customer email —
 * renders empty rather than as the literal token, because the token would go
 * to MetaKocka. The caller checks the result is usable; `isUsableReference`
 * below is that check, kept separate so the settings preview can show the same
 * verdict without writing anything.
 */
export function renderOrderReference(
  template: string,
  context: OrderReferenceContext,
): string {
  const rendered = template.replace(
    PLACEHOLDER_PATTERN,
    (whole, rawToken: string) => {
      const placeholder = BY_TOKEN.get(rawToken);
      if (!placeholder) return whole;
      return placeholder.of(context) ?? "";
    },
  );

  return rendered.trim().slice(0, MAX_ORDER_REFERENCE_LENGTH);
}

/**
 * Whether a rendered reference can be sent.
 *
 * An empty reference is not a cosmetic problem: `buyer_order` is what links the
 * sibling documents of a split order and the only thing the ambiguous-write
 * recovery can search by (§3), so an order carrying none loses both. The caller
 * falls back to the default template rather than writing one.
 */
export function isUsableReference(reference: string): boolean {
  return reference.trim().length > 0;
}

/**
 * The reference to store on an order, with the fallback applied.
 *
 * Returns the default-rendered reference when the merchant's template produces
 * nothing usable for this particular order — a template of `{{customer.email}}`
 * meets its first guest checkout eventually, and an order with no reference at
 * all is worse than one filed under a name the merchant did not choose.
 */
export function orderReferenceFor(
  template: string | null,
  context: OrderReferenceContext,
): { reference: string; usedFallback: boolean } {
  const chosen = (template ?? "").trim() || DEFAULT_CUSTOMER_ORDER_TEMPLATE;
  const rendered = renderOrderReference(chosen, context);

  if (isUsableReference(rendered)) {
    return { reference: rendered, usedFallback: false };
  }

  return {
    reference: renderOrderReference(DEFAULT_CUSTOMER_ORDER_TEMPLATE, context),
    usedFallback: true,
  };
}

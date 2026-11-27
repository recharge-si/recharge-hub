import { z } from "zod";

/**
 * A partner the merchant entered by hand, for an order Shopify has no address
 * on.
 *
 * MetaKocka refuses a sales order without a partner, and Shopify does not
 * always have one: point-of-sale orders, digital goods, some draft orders and
 * anything created through the API arrive with neither a billing nor a shipping
 * address. The only thing this app could say about those was "add the address
 * in Shopify and retry" — which is sometimes impossible, always slow, and left
 * the merchant with an order that could not move and a retry button that
 * changed nothing.
 *
 * Shaped to match `ParsedAddress` so the write path can take it without knowing
 * where it came from, and validated on the way in because it is the one piece
 * of partner data in the system that no boundary parser has already checked.
 *
 * §2.4 applies to it exactly as to the payload: this is protected customer
 * data, it is stored only because it is sent, and the retention job redacts it
 * with everything else.
 */
export const partnerOverrideSchema = z.object({
  /** Company or person name. The one field MetaKocka will not do without. */
  customer: z.string().trim().min(1),
  street: z.string().trim().nullable().default(null),
  postNumber: z.string().trim().nullable().default(null),
  place: z.string().trim().nullable().default(null),
  country: z.string().trim().nullable().default(null),
  /** Sets `business_entity` and `taxpayer` on the MetaKocka partner. */
  isBusiness: z.boolean().default(false),
  taxNumber: z.string().trim().nullable().default(null),
  email: z.string().trim().nullable().default(null),
  phone: z.string().trim().nullable().default(null),
});

export type PartnerOverride = z.infer<typeof partnerOverrideSchema>;

/**
 * Reads a stored override back, or null when there is none.
 *
 * Never throws. A column that fails to parse — written by an older shape, or
 * redacted by the retention job — must not take the order writer down with it;
 * falling back to the payload is the same behaviour as having no override at
 * all, which is where this started.
 */
export function parsePartnerOverride(value: unknown): PartnerOverride | null {
  if (!value) return null;
  const parsed = partnerOverrideSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether an override would actually let the order through.
 *
 * MetaKocka needs a name and, when the partner has to be created rather than
 * matched, an address to identify it by (§3: `mk_id` alone is refused with
 * "Partner must have mk_address_id or customer and street"). So a name with no
 * street is accepted here but is worth warning about, rather than silently
 * producing the same rejection a day later.
 */
export function overrideIsComplete(override: PartnerOverride): boolean {
  return override.customer.length > 0 && (override.street ?? "").length > 0;
}

/** Where the partner on a sales order came from, for the audit trail. */
export type PartnerSource = "order" | "fixed" | "shopify";

/** The partner `choosePartner` picked, typed by where it came from. */
export type ChosenPartner<A> =
  | { source: "order" | "fixed"; partner: PartnerOverride }
  | { source: "shopify"; partner: A };

/**
 * Who a sales order is filed against, in order of precedence.
 *
 * 1. A partner entered by hand on this order: the most specific statement.
 * 2. The shop's fixed partner, when the merchant files every order against
 *    one MetaKocka customer instead of the Shopify buyer.
 * 3. The Shopify billing address, then the shipping address.
 *
 * Generic over the Shopify address so this stays free of adapter types;
 * `PartnerOverride` is shaped to fit wherever a `ParsedAddress` is read.
 */
export function choosePartner<A>(input: {
  override: PartnerOverride | null;
  fixed: PartnerOverride | null;
  billing: A | null;
  shipping: A | null;
}): ChosenPartner<A> | null {
  if (input.override) return { partner: input.override, source: "order" };
  if (input.fixed) return { partner: input.fixed, source: "fixed" };
  const shopify = input.billing ?? input.shipping;
  return shopify ? { partner: shopify, source: "shopify" } : null;
}

/** The contact details `buyerNote` writes out: a `ParsedAddress` fits. */
export interface BuyerContact {
  customer: string;
  street: string | null;
  postNumber: string | null;
  place: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * The Shopify buyer, as text for the document's additional text, when the
 * order is filed against a fixed partner and the buyer would otherwise be
 * nowhere on it:
 *
 *   Tim Parey, 20 Chemin Du Roy D'Espagne, A1, 13009 Marseille, France, +33 6 16 99 17 16
 *   timparey@orange.fr
 */
export function buyerNote(contact: BuyerContact): string {
  const town = [contact.postNumber, contact.place]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  const line = [
    contact.customer,
    contact.street,
    town,
    contact.country,
    contact.phone,
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
  return [line, contact.email?.trim()].filter(Boolean).join("\n");
}

/**
 * Partner pricing: every order filed against the shop's fixed partner becomes
 * a wholesale sales order to that partner, priced from a MetaKocka sales
 * pricelist rather than mirroring what the Shopify buyer paid.
 *
 * The case it exists for is a reseller's own Shopify store: the buyer is the
 * reseller's customer, but the document this company files is its sale *to the
 * reseller*, at the reseller's net price less a fixed line discount and with no
 * VAT. Nothing on the Shopify order — its prices, its shipping, its payments,
 * its taxes — describes that sale, so none of it is sent.
 */
export interface PartnerPricing {
  /** The MetaKocka sales pricelist `count_code` whose net price is sent. */
  pricelistCode: string;
  /** Line discount percent, canonical decimal string, or null for none. */
  discountPercent: string | null;
}

/**
 * Whether partner pricing applies to one order.
 *
 * Only to an order actually filed against the fixed partner: a partner entered
 * by hand on the order wins over the fixed one (`choosePartner`), and pricing
 * someone else at the reseller's wholesale price with no VAT would be wrong in
 * both directions. Such an order goes through the ordinary path.
 */
export function partnerPricingForOrder(input: {
  /** The shop's partner pricing, already null unless a fixed partner is set. */
  pricing: PartnerPricing | null;
  hasOrderOverride: boolean;
}): PartnerPricing | null {
  return input.hasOrderOverride ? null : input.pricing;
}

/** Plain digits with at most two decimals: no "1e2", no sign. */
const PERCENT_PATTERN = /^\d{1,3}(?:[.,]\d{1,2})?$/;

/**
 * A discount percent as the merchant typed it, canonicalised: "20", "12.5".
 *
 * Returns null for an empty value and `"invalid"` for anything that is not a
 * percent from 0 up to (not including) 100 with at most two decimals. A
 * comma is accepted as
 * the decimal separator because MetaKocka's own screens use one.
 */
export function parseDiscountPercent(raw: string): string | null | "invalid" {
  const value = raw.trim().replace("%", "").trim();
  if (value === "") return null;
  if (!PERCENT_PATTERN.test(value)) return "invalid";
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 100) {
    return "invalid";
  }
  return String(parsed);
}

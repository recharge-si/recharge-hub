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

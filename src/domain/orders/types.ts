/**
 * The vocabulary of an order's *state*, as opposed to its allocation.
 *
 * These types live in `domain/` rather than beside the Shopify parser because
 * three tiers need to agree on them: the parser produces them, the jobs decide
 * from them, and the UI names them. Keeping them here also means the rules that
 * read them (`state.ts`) stay pure and testable in milliseconds, which matters
 * — deciding whether an order became paid is not something anyone should have
 * to spin up a database to check.
 */

/** Shopify's `financial_status`, narrowed to the values §8.7 has a rule for. */
export type FinancialStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "partially_paid"
  | "refunded"
  | "partially_refunded"
  | "voided"
  | "unknown";

export const FINANCIAL_STATUSES: readonly FinancialStatus[] = [
  "pending",
  "authorized",
  "paid",
  "partially_paid",
  "refunded",
  "partially_refunded",
  "voided",
  "unknown",
];

/**
 * How far Shopify has got with shipping the order.
 *
 * Normalised across the two shapes Shopify reports it in: the webhook's
 * `fulfillment_status` (null, "partial", "fulfilled", "restocked") and the
 * Admin API's `displayFulfillmentStatus` (an upper-case enum with several more
 * members). Nothing in v1 acts on it — tracking back to Shopify is M5 — but it
 * is read and stored so the order screen can stop claiming an order is waiting
 * when it left the building last week.
 */
export type FulfillmentState =
  | "unfulfilled"
  | "partial"
  | "fulfilled"
  | "restocked"
  | "other";

export interface OrderLineSnapshot {
  shopifyLineItemId: string;
  sku: string;
  title: string;
  quantity: number;
  /** Unit price as Shopify charged it, minor units. */
  unitPriceWithTaxMinor: number;
  discountMinor: number;
}

/**
 * Everything about an order that this app would send differently if it changed.
 *
 * Deliberately *not* everything Shopify holds. Tags, notes, the customer's
 * marketing consent and the shipping method all move without changing what
 * MetaKocka should be told, and treating them as changes would fill the
 * exceptions queue with noise until nobody read it.
 *
 * `taxFactor` is deliberately absent too, and for a subtler reason: it is a
 * derivation of ours, not a fact of the order. The write path re-derives it
 * from the stored payload on every attempt, so a fix to the parser would
 * otherwise show up here as "the merchant edited this order".
 */
export interface OrderSnapshot {
  financialStatus: FinancialStatus;
  fulfillmentState: FulfillmentState;
  currency: string;
  totalMinor: number;
  shippingMinor: number;
  discountMinor: number;
  cancelled: boolean;
  /**
   * The customer this order would be filed against, as a fingerprint.
   *
   * A fingerprint rather than the details themselves, because a snapshot is
   * compared and logged and §2.4 keeps personal data out of both. Null means
   * Shopify has nobody to file the order against, which MetaKocka refuses
   * outright — so "null became non-null" is the single most valuable change
   * this diff can report: it is an order that could not be sent becoming one
   * that can.
   */
  party: string | null;
  lines: OrderLineSnapshot[];
}

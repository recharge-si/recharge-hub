import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";

/**
 * The Shopify `orders/create` payload, narrowed to what this app actually uses.
 *
 * Two rules shape what is in here, and both are about restraint:
 *
 *  - **§2.4 data minimisation.** Order payloads carry Level 2 protected
 *    customer data, and this app transmits it to a third-party ERP. So the
 *    schema keeps only the fields needed to build a MetaKocka partner and
 *    receiver, and nothing is stored that is not sent. Everything else in the
 *    payload is dropped here, at the boundary, rather than stored and forgotten.
 *  - **§4 parse, never cast.** Shopify sends money as decimal strings and ids
 *    as numbers or strings depending on the field. Nothing raw reaches domain
 *    code; money becomes integer minor units the moment it arrives (§15).
 *
 * `.passthrough()` is deliberately absent. Anything not listed is discarded.
 */

const money = z.union([z.string(), z.number()]).transform(String);

const addressSchema = z
  .object({
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    name: z.string().nullish(),
    company: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    zip: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    country: z.string().nullish(),
    country_code: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

const taxLineSchema = z.object({
  rate: z.union([z.string(), z.number()]).nullish(),
  price: money.nullish(),
});

const lineItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  sku: z.string().nullish(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  quantity: z.number(),
  price: money,
  total_discount: money.nullish(),
  taxable: z.boolean().nullish(),
  tax_lines: z.array(taxLineSchema).default([]),
});

export const orderPayloadSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  order_number: z.union([z.string(), z.number()]).transform(String).nullish(),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  presentment_currency: z.string().nullish(),
  financial_status: z.string().nullish(),
  total_price: money.nullish(),
  current_total_price: money.nullish(),
  total_discounts: money.nullish(),
  taxes_included: z.boolean().nullish(),
  total_tax: money.nullish(),
  total_shipping_price_set: z
    .object({
      shop_money: z.object({ amount: money }).nullish(),
      presentment_money: z.object({ amount: money }).nullish(),
    })
    .nullish(),
  payment_gateway_names: z.array(z.string()).default([]),
  gateway: z.string().nullish(),
  note: z.string().nullish(),
  created_at: z.string().nullish(),
  line_items: z.array(lineItemSchema).default([]),
  customer: z
    .object({
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      email: z.string().nullish(),
      phone: z.string().nullish(),
    })
    .nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  billing_address: addressSchema,
  shipping_address: addressSchema,
});

export type OrderPayload = z.infer<typeof orderPayloadSchema>;

/** Shopify's financial_status, narrowed to the values §8.7 has a rule for. */
export type FinancialStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "partially_paid"
  | "refunded"
  | "partially_refunded"
  | "voided"
  | "unknown";

const FINANCIAL_STATUSES = new Set<FinancialStatus>([
  "pending",
  "authorized",
  "paid",
  "partially_paid",
  "refunded",
  "partially_refunded",
  "voided",
]);

export function toFinancialStatus(raw: string | null | undefined) {
  const value = (raw ?? "").toLowerCase();
  return FINANCIAL_STATUSES.has(value as FinancialStatus)
    ? (value as FinancialStatus)
    : ("unknown" as const);
}

export interface ParsedAddress {
  customer: string;
  street: string | null;
  postNumber: string | null;
  place: string | null;
  country: string | null;
  isBusiness: boolean;
  email: string | null;
  phone: string | null;
}

/**
 * Northern Ireland is its own country string in MetaKocka, not "UK" (§3).
 * Getting this wrong changes the VAT treatment of the document.
 */
function countryName(
  country: string | null | undefined,
  code: string | null | undefined,
  province: string | null | undefined,
): string | null {
  const isUk =
    (code ?? "").toUpperCase() === "GB" ||
    /united kingdom/i.test(country ?? "");
  const isNorthernIreland =
    (code ?? "").toUpperCase() === "XI" ||
    /northern ireland/i.test(province ?? "");

  if (isUk && isNorthernIreland) return "United Kingdom - Northern Ireland";
  return country ?? null;
}

function nameOf(
  address: NonNullable<OrderPayload["billing_address"]>,
  fallback: string,
): string {
  const joined = [address?.first_name, address?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return (
    address?.name?.trim() || joined || address?.company?.trim() || fallback
  );
}

export function toParty(
  address: OrderPayload["billing_address"],
  contact: { email?: string | null; phone?: string | null },
  fallbackName: string,
): ParsedAddress | null {
  if (!address) return null;

  return {
    customer: nameOf(address, fallbackName),
    // A company name present means a business buyer, which changes
    // `business_entity` and `taxpayer` on the MetaKocka partner.
    isBusiness: Boolean(address.company?.trim()),
    street:
      [address.address1, address.address2].filter(Boolean).join(", ") || null,
    postNumber: address.zip ?? null,
    place: address.city ?? null,
    country: countryName(
      address.country,
      address.country_code,
      address.province,
    ),
    email: contact.email ?? null,
    phone: address.phone ?? contact.phone ?? null,
  };
}

export interface ParsedOrderLine {
  shopifyLineItemId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPriceWithTaxMinor: number;
  discountMinor: number;
  /** Whether Shopify considers this line taxable at all. */
  taxable: boolean;
  /**
   * Decimal factor derived from this line's own tax lines, never a product
   * default. Null means Shopify did not say enough to know it (§11).
   */
  taxFactor: string | null;
}

/**
 * The tax factor for one line (§8.6), or null when Shopify has not said what it
 * is.
 *
 * Never a *product* default: the same SKU carries different rates across
 * markets, so reading a rate off the catalogue would file the wrong VAT on every
 * cross-border order. What null means here is "ask the shop's configured rate",
 * which the caller does — see `write-metakocka-order`.
 *
 * Two cases produce an answer and one deliberately does not:
 *
 *  - **The line has tax lines.** Sum their rates; that is what a compound rate
 *    means, and it is the only per-market-accurate source.
 *  - **`taxable: false`.** Genuinely exempt. Zero is a statement about the
 *    sale, not a gap.
 *  - **Taxable, but no tax lines.** Shopify charged nothing and said nothing
 *    about the rate — a shop with no tax registration for that market, which is
 *    every development store. This is *not* zero. Sending zero produces a
 *    MetaKocka line of 209.00 at 0% where the catalogue and pricelist say
 *    171.31 at 22%: the same gross, a net that matches nothing, and understated
 *    VAT. Null asks the caller for the shop's rate instead.
 */
function taxFactorOf(
  line: z.infer<typeof lineItemSchema>,
  orderTaxMinor: number,
): string | null {
  const rates = line.tax_lines
    .map((tax) =>
      tax.rate === null || tax.rate === undefined ? NaN : Number(tax.rate),
    )
    .filter((rate) => Number.isFinite(rate) && rate >= 0);

  if (rates.length > 0) {
    const total = rates.reduce((sum, rate) => sum + rate, 0);
    // Four decimal places covers every rate in use without inventing precision.
    return total.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") || "0";
  }

  // Genuinely exempt. Shopify saying "this line is not taxable" is a statement
  // about the sale, not a gap in the data, so zero is the right answer.
  if (line.taxable === false) return "0";

  // Taxable, but Shopify charged nothing and said nothing about the rate. That
  // is a gap, not a zero: see the note on ParsedOrderLine.taxFactor.
  void orderTaxMinor;
  return null;
}

export interface ParsedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  currency: string;
  financialStatus: FinancialStatus;
  totalMinor: number;
  shippingMinor: number;
  discountMinor: number;
  gateway: string | null;
  /**
   * Whether Shopify's line prices already include tax. §8.6 asks for both kinds
   * of store to be handled, and this is the flag that decides whether a price
   * goes to MetaKocka as `price_with_tax` or as `price`.
   */
  taxesIncluded: boolean;
  /** Tax charged on the whole order, minor units. */
  totalTaxMinor: number;
  note: string | null;
  createdAt: Date | null;
  /**
   * The timestamp exactly as Shopify sent it, offset included. Kept as a string
   * because parsing it to a Date throws the offset away, and MetaKocka needs it
   * (see `toDocumentDate`).
   */
  createdAtRaw: string | null;
  lines: ParsedOrderLine[];
  partner: ParsedAddress | null;
  receiver: ParsedAddress | null;
}

export function parseOrder(payload: unknown): ParsedOrder {
  const order = orderPayloadSchema.parse(payload);

  const currency = order.presentment_currency ?? order.currency ?? "EUR";
  const orderNumber =
    order.order_number ?? order.name?.replace(/^#/, "") ?? order.id;

  const contact = {
    email: order.customer?.email ?? order.email ?? null,
    phone: order.customer?.phone ?? order.phone ?? null,
  };
  const fallbackName =
    [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || `Shopify order ${orderNumber}`;

  const orderTaxMinor = toMinorUnits(order.total_tax ?? "0");

  const shipping =
    order.total_shipping_price_set?.presentment_money?.amount ??
    order.total_shipping_price_set?.shop_money?.amount ??
    "0";

  return {
    shopifyOrderId: order.id,
    orderNumber,
    currency,
    financialStatus: toFinancialStatus(order.financial_status),
    totalMinor: toMinorUnits(
      order.current_total_price ?? order.total_price ?? "0",
    ),
    shippingMinor: toMinorUnits(shipping),
    discountMinor: toMinorUnits(order.total_discounts ?? "0"),
    gateway: order.payment_gateway_names[0] ?? order.gateway ?? null,
    // Shopify defaults to tax-inclusive pricing, and treating an unstated flag
    // as exclusive would inflate every price by the VAT rate.
    taxesIncluded: order.taxes_included ?? true,
    totalTaxMinor: orderTaxMinor,
    note: order.note ?? null,
    createdAt: order.created_at ? new Date(order.created_at) : null,
    createdAtRaw: order.created_at ?? null,
    lines: order.line_items.map((line) => ({
      shopifyLineItemId: line.id,
      // A line with no SKU cannot be matched to a MetaKocka product. It is kept
      // rather than dropped so the order page shows the whole order and the
      // exception says which line is the problem.
      sku: line.sku?.trim() ?? "",
      title: line.title ?? line.name ?? "",
      quantity: line.quantity,
      unitPriceWithTaxMinor: toMinorUnits(line.price),
      discountMinor: toMinorUnits(line.total_discount ?? "0"),
      taxable: line.taxable ?? true,
      taxFactor: taxFactorOf(line, orderTaxMinor),
    })),
    partner: toParty(order.billing_address, contact, fallbackName),
    receiver: toParty(order.shipping_address, contact, fallbackName),
  };
}

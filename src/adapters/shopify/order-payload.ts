import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import { partyFingerprint } from "~/domain/orders/state";
import {
  FINANCIAL_STATUSES,
  type FinancialStatus,
  type FulfillmentState,
  type OrderSnapshot,
} from "~/domain/orders/types";
import { rateKeyFromFactor } from "~/domain/tax/rates";
import type { RefundInput } from "~/domain/tax/refunds";
import type {
  NormalizedOrderTax,
  ShippingTaxInput,
  TaxLineInput,
} from "~/domain/tax/types";

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

/**
 * A Shopify `*_set` money field.
 *
 * Every amount on an order exists twice: once in the shop's own currency and
 * once in the currency the customer was actually charged. The plain fields
 * (`total_price`, `line_items[].price`) are the **shop** amounts, while
 * `presentment_currency` is the customer's — so reading the flat field and
 * labelling it with the presentment code prices every MetaKocka document in a
 * currency it was never denominated in (§8.6: never silently convert).
 *
 * The set is preferred and the flat field is the fallback, because a
 * single-currency store reports the same number in both and older payloads
 * may not carry the set at all.
 */
const moneySet = z
  .object({
    shop_money: z.object({ amount: money }).nullish(),
    presentment_money: z.object({ amount: money }).nullish(),
  })
  .nullish();

type MoneySet = z.infer<typeof moneySet>;

/** Presentment first, then shop, then the flat field the set replaced. */
function presentmentAmount(
  set: MoneySet,
  flat: string | null | undefined,
): string {
  return (
    set?.presentment_money?.amount ??
    set?.shop_money?.amount ??
    flat ??
    "0"
  );
}

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
    province_code: z.string().nullish(),
    country: z.string().nullish(),
    country_code: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

/**
 * One tax line, on a line item, on shipping, or on the order.
 *
 * `rate` is a decimal (0.22); `price` is the tax charged at that rate, in the
 * shop currency as a flat field and in both currencies in the set. The set is
 * preferred for the same reason as every other amount (§8.6).
 */
const taxLineSchema = z.object({
  title: z.string().nullish(),
  rate: z.union([z.string(), z.number()]).nullish(),
  price: money.nullish(),
  price_set: moneySet,
});

/**
 * A shipping line. Shopify taxes shipping on its own terms — its own tax
 * lines, its own rate — and never as "whatever the goods were taxed at", so
 * they are read rather than borrowed (§27 of the brief).
 */
const shippingLineSchema = z.object({
  title: z.string().nullish(),
  price: money.nullish(),
  price_set: moneySet,
  discounted_price: money.nullish(),
  discounted_price_set: moneySet,
  tax_lines: z.array(taxLineSchema).default([]),
});

/**
 * A refund, narrowed to what a credit note needs: which lines, how many, and
 * what Shopify refunded in goods and in tax. `order_adjustments` is where a
 * refunded shipping charge lives, as negative amounts.
 */
const refundSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  created_at: z.string().nullish(),
  refund_line_items: z
    .array(
      z.object({
        line_item_id: z.union([z.string(), z.number()]).transform(String),
        quantity: z.number(),
        subtotal: money.nullish(),
        subtotal_set: moneySet,
        total_tax: money.nullish(),
        total_tax_set: moneySet,
      }),
    )
    .default([]),
  order_adjustments: z
    .array(
      z.object({
        kind: z.string().nullish(),
        amount: money.nullish(),
        amount_set: moneySet,
        tax_amount: money.nullish(),
        tax_amount_set: moneySet,
      }),
    )
    .default([]),
});

const lineItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  sku: z.string().nullish(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  quantity: z.number(),
  price: money,
  price_set: moneySet,
  total_discount: money.nullish(),
  total_discount_set: moneySet,
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
  total_price_set: moneySet,
  current_total_price: money.nullish(),
  current_total_price_set: moneySet,
  total_discounts: money.nullish(),
  total_discounts_set: moneySet,
  taxes_included: z.boolean().nullish(),
  tax_exempt: z.boolean().nullish(),
  total_tax: money.nullish(),
  total_tax_set: moneySet,
  current_total_tax: money.nullish(),
  current_total_tax_set: moneySet,
  tax_lines: z.array(taxLineSchema).default([]),
  total_shipping_price_set: moneySet,
  /// Absent on some older payloads; null then means "not described", which
  /// the tax engine treats differently from "described as untaxed".
  shipping_lines: z.array(shippingLineSchema).nullish(),
  note_attributes: z
    .array(
      z.object({
        name: z.string().nullish(),
        value: z.union([z.string(), z.number()]).transform(String).nullish(),
      }),
    )
    .default([]),
  refunds: z.array(refundSchema).default([]),
  payment_gateway_names: z.array(z.string()).default([]),
  gateway: z.string().nullish(),
  note: z.string().nullish(),
  created_at: z.string().nullish(),
  /// The ordering key for everything in `jobs/handlers/sync-order-state`.
  /// Shopify does not promise webhooks arrive in the order they happened, so an
  /// update older than the one already applied has to be recognisable.
  updated_at: z.string().nullish(),
  fulfillment_status: z.string().nullish(),
  cancelled_at: z.string().nullish(),
  line_items: z.array(lineItemSchema).default([]),
  customer: z
    .object({
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      email: z.string().nullish(),
      phone: z.string().nullish(),
      tax_exempt: z.boolean().nullish(),
    })
    .nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  billing_address: addressSchema,
  shipping_address: addressSchema,
});

export type OrderPayload = z.infer<typeof orderPayloadSchema>;

/**
 * `financial_status`, narrowed to the values §8.7 has a rule for.
 *
 * The type itself lives in `domain/orders/types` because the rules that read
 * it are pure and belong there; this is only the boundary that produces it.
 * Anything unrecognised — Shopify's `expired`, or a status added after this was
 * written — becomes `unknown`, which every rule treats as "not a payment this
 * app records" rather than as a reason to guess.
 */
export type { FinancialStatus, FulfillmentState } from "~/domain/orders/types";

const KNOWN_FINANCIAL_STATUSES = new Set<string>(
  FINANCIAL_STATUSES.filter((status) => status !== "unknown"),
);

export function toFinancialStatus(
  raw: string | null | undefined,
): FinancialStatus {
  const value = (raw ?? "").toLowerCase().trim();
  return KNOWN_FINANCIAL_STATUSES.has(value)
    ? (value as FinancialStatus)
    : "unknown";
}

/**
 * `fulfillment_status`, normalised across the two shapes Shopify reports it in.
 *
 * The webhook sends null for an unfulfilled order and "partial", "fulfilled" or
 * "restocked" otherwise. The Admin API sends `displayFulfillmentStatus`, an
 * upper-case enum with several more members (`IN_PROGRESS`, `ON_HOLD`,
 * `SCHEDULED`, `PENDING_FULFILLMENT`, `REQUEST_DECLINED`, `OPEN`). Both reach
 * this app — the second one through the reconciler — so both collapse into one
 * small set here rather than leaving every reader to know both vocabularies.
 *
 * Nothing in v1 acts on it (tracking back to Shopify is M5). It is read so the
 * order screen can stop implying an order is waiting when it shipped last week.
 */
export function toFulfillmentState(
  raw: string | null | undefined,
): FulfillmentState {
  const value = (raw ?? "").toLowerCase().trim();

  if (value === "" || value === "unfulfilled" || value === "null") {
    return "unfulfilled";
  }
  if (value === "fulfilled") return "fulfilled";
  if (value === "partial" || value === "partially_fulfilled") return "partial";
  if (value === "restocked") return "restocked";
  return "other";
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
   *
   * What Shopify said, and only that. What the line is *sent* with is the tax
   * engine's decision (`domain/tax`), which maps this through the merchant's
   * MetaKocka mappings or stands a configured rate in for a missing one.
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
  /**
   * Shopify's display name, `#1050`. Kept apart from `orderNumber` because the
   * merchant's *Customer's order* template can use either, and they are not the
   * same string (`domain/orders/reference`).
   */
  orderName: string | null;
  /** The address the order was placed with, for the same template. */
  customerEmail: string | null;
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
  fulfillmentState: FulfillmentState;
  note: string | null;
  createdAt: Date | null;
  /**
   * Shopify's `updated_at`. The high-water mark that keeps an out-of-order
   * webhook from undoing a newer one.
   */
  updatedAt: Date | null;
  /** Set when Shopify has cancelled the order. */
  cancelledAt: Date | null;
  /**
   * The timestamp exactly as Shopify sent it, offset included. Kept as a string
   * because parsing it to a Date throws the offset away, and MetaKocka needs it
   * (see `toDocumentDate`).
   */
  createdAtRaw: string | null;
  lines: ParsedOrderLine[];
  partner: ParsedAddress | null;
  receiver: ParsedAddress | null;
  /** Everything the tax engine reads, with no Shopify field names left in it. */
  tax: NormalizedOrderTax;
  /** Refunds Shopify has processed, for reversing the order's tax decision. */
  refunds: RefundInput[];
}

/**
 * The ISO code of an address, with Northern Ireland as `XI`.
 *
 * Shopify reports Northern Ireland as country `GB` with the province set, and
 * for VAT on goods it is inside the EU VAT area — the one place where the
 * country code alone gives the wrong jurisdiction.
 */
function countryCodeOf(
  address: OrderPayload["billing_address"],
): string | null {
  if (!address) return null;
  const code = (address.country_code ?? "").trim().toUpperCase();
  if (code === "") return null;
  const province = `${address.province ?? ""} ${address.province_code ?? ""}`;
  if (code === "GB" && /northern ireland|\bNIR\b/i.test(province)) return "XI";
  return code;
}

/**
 * Shopify's tax lines, normalised. A tax line whose rate cannot be read is
 * dropped rather than guessed at; the engine's reconciliation then sees the
 * order tax it does not account for and holds the order.
 */
function toTaxLines(lines: z.infer<typeof taxLineSchema>[]): TaxLineInput[] {
  const out: TaxLineInput[] = [];
  for (const line of lines) {
    if (line.rate === null || line.rate === undefined) continue;
    const rateKey = rateKeyFromFactor(line.rate);
    if (rateKey === null) continue;
    out.push({
      rateKey,
      amountMinor: toMinorUnits(presentmentAmount(line.price_set, line.price)),
      title: line.title?.trim() || null,
    });
  }
  return out;
}

/**
 * The names a VAT identifier travels under when a storefront collects one.
 *
 * Shopify has no first-class VAT number on an order outside B2B company
 * accounts, so apps and themes put it in a note attribute. Matching the usual
 * names finds it; nothing about tax treatment follows from its presence alone.
 */
const VAT_ATTRIBUTE = /^(vat[\s_-]*(id|number|no|nr)?|tax[\s_-]*(id|number)|davcna|davčna|ddv|id[\s_-]*za[\s_-]*ddv)$/i;

function vatNumberOf(order: OrderPayload): string | null {
  for (const attribute of order.note_attributes) {
    const name = (attribute.name ?? "").trim();
    const value = (attribute.value ?? "").trim();
    if (name && value && VAT_ATTRIBUTE.test(name)) return value;
  }
  return null;
}

function toShipping(order: OrderPayload): ShippingTaxInput | null {
  const shippingMinor = toMinorUnits(
    presentmentAmount(order.total_shipping_price_set, "0"),
  );
  if (shippingMinor <= 0 && !order.shipping_lines?.length) return null;

  // The lines were not described at all: the amount is known, the tax is not.
  if (!order.shipping_lines) {
    return { amountMinor: shippingMinor, taxLines: null };
  }

  const amountMinor = order.shipping_lines.reduce(
    (sum, line) =>
      sum +
      toMinorUnits(
        presentmentAmount(
          line.discounted_price_set ?? line.price_set,
          line.discounted_price ?? line.price ?? "0",
        ),
      ),
    0,
  );

  return {
    amountMinor: amountMinor > 0 ? amountMinor : shippingMinor,
    taxLines: toTaxLines(order.shipping_lines.flatMap((line) => line.tax_lines)),
  };
}

function toNormalizedTax(
  order: OrderPayload,
  currency: string,
  taxesIncluded: boolean,
  totalTaxMinor: number,
): NormalizedOrderTax {
  const company =
    Boolean(order.billing_address?.company?.trim()) ||
    Boolean(order.shipping_address?.company?.trim());
  const vatNumber = vatNumberOf(order);

  return {
    currency,
    taxesIncluded,
    totalTaxMinor,
    orderTaxLines: toTaxLines(order.tax_lines),
    destinationCountry: countryCodeOf(order.shipping_address),
    billingCountry: countryCodeOf(order.billing_address),
    customer: {
      isBusiness: company || vatNumber !== null,
      vatNumber,
      taxExempt: order.tax_exempt === true || order.customer?.tax_exempt === true,
    },
    lines: order.line_items.map((line) => ({
      lineId: line.id,
      sku: line.sku?.trim() ?? "",
      quantity: line.quantity,
      unitPriceMinor: toMinorUnits(presentmentAmount(line.price_set, line.price)),
      discountMinor: toMinorUnits(
        presentmentAmount(line.total_discount_set, line.total_discount),
      ),
      taxable: line.taxable ?? true,
      taxLines: toTaxLines(line.tax_lines),
    })),
    shipping: toShipping(order),
  };
}

function toRefunds(order: OrderPayload): RefundInput[] {
  return order.refunds.map((refund) => {
    const lines = refund.refund_line_items.map((line) => ({
      lineId: line.line_item_id,
      quantity: line.quantity,
      subtotalMinor:
        line.subtotal_set || line.subtotal
          ? toMinorUnits(presentmentAmount(line.subtotal_set, line.subtotal))
          : null,
      taxMinor:
        line.total_tax_set || line.total_tax
          ? toMinorUnits(presentmentAmount(line.total_tax_set, line.total_tax))
          : null,
    }));

    // Shipping refunds arrive as negative adjustments; the breakdown wants
    // the positive amount refunded.
    let shippingMinor = 0;
    let shippingTaxMinor: number | null = null;
    for (const adjustment of refund.order_adjustments) {
      if ((adjustment.kind ?? "") !== "shipping_refund") continue;
      shippingMinor += Math.abs(
        toMinorUnits(presentmentAmount(adjustment.amount_set, adjustment.amount)),
      );
      if (adjustment.tax_amount_set || adjustment.tax_amount) {
        shippingTaxMinor =
          (shippingTaxMinor ?? 0) +
          Math.abs(
            toMinorUnits(
              presentmentAmount(adjustment.tax_amount_set, adjustment.tax_amount),
            ),
          );
      }
    }

    return {
      refundId: refund.id,
      createdAt: refund.created_at ?? null,
      totalRefundedMinor:
        lines.reduce((sum, line) => sum + (line.subtotalMinor ?? 0), 0) + shippingMinor,
      lines,
      shipping: shippingMinor > 0 ? { amountMinor: shippingMinor, taxMinor: shippingTaxMinor } : null,
    };
  });
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

  // Every amount below is the presentment one, to match `currency` above.
  // Mixing the two — a shop-currency total under a presentment code — is the
  // failure this reads around: it prices the whole MetaKocka document wrongly
  // and nothing downstream can tell, because the number is perfectly valid.
  // `current_total_tax` follows edits and refunds the way `current_total_price`
  // does, so it is what the lines as they stand now must add up to.
  const orderTaxMinor = toMinorUnits(
    order.current_total_tax_set || order.current_total_tax
      ? presentmentAmount(order.current_total_tax_set, order.current_total_tax)
      : presentmentAmount(order.total_tax_set, order.total_tax),
  );
  const taxesIncluded = order.taxes_included ?? true;

  const shipping = presentmentAmount(order.total_shipping_price_set, "0");

  // `current_*` reflects edits and refunds, so it wins over the original
  // whenever Shopify sends it in either shape.
  const total =
    order.current_total_price_set || order.current_total_price
      ? presentmentAmount(
          order.current_total_price_set,
          order.current_total_price,
        )
      : presentmentAmount(order.total_price_set, order.total_price);

  return {
    shopifyOrderId: order.id,
    orderNumber,
    orderName: order.name ?? null,
    customerEmail: contact.email,
    currency,
    financialStatus: toFinancialStatus(order.financial_status),
    totalMinor: toMinorUnits(total),
    shippingMinor: toMinorUnits(shipping),
    discountMinor: toMinorUnits(
      presentmentAmount(order.total_discounts_set, order.total_discounts),
    ),
    gateway: order.payment_gateway_names[0] ?? order.gateway ?? null,
    // Shopify defaults to tax-inclusive pricing, and treating an unstated flag
    // as exclusive would inflate every price by the VAT rate.
    taxesIncluded,
    totalTaxMinor: orderTaxMinor,
    fulfillmentState: toFulfillmentState(order.fulfillment_status),
    note: order.note ?? null,
    createdAt: order.created_at ? new Date(order.created_at) : null,
    updatedAt: order.updated_at ? new Date(order.updated_at) : null,
    cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : null,
    createdAtRaw: order.created_at ?? null,
    lines: order.line_items.map((line) => ({
      shopifyLineItemId: line.id,
      // A line with no SKU cannot be matched to a MetaKocka product. It is kept
      // rather than dropped so the order page shows the whole order and the
      // exception says which line is the problem.
      sku: line.sku?.trim() ?? "",
      title: line.title ?? line.name ?? "",
      quantity: line.quantity,
      unitPriceWithTaxMinor: toMinorUnits(
        presentmentAmount(line.price_set, line.price),
      ),
      discountMinor: toMinorUnits(
        presentmentAmount(line.total_discount_set, line.total_discount),
      ),
      taxable: line.taxable ?? true,
      taxFactor: taxFactorOf(line, orderTaxMinor),
    })),
    partner: toParty(order.billing_address, contact, fallbackName),
    receiver: toParty(order.shipping_address, contact, fallbackName),
    tax: toNormalizedTax(order, currency, taxesIncluded, orderTaxMinor),
    refunds: toRefunds(order),
  };
}

/**
 * The part of a parsed order that this app would send differently if it moved
 * (`domain/orders/state`).
 *
 * Kept beside the parser rather than in the domain so there is exactly one
 * place that knows how a Shopify payload becomes a snapshot, and one place —
 * the pure `diffOrder` — that knows what a difference between two of them
 * means.
 */
export function toSnapshot(parsed: ParsedOrder): OrderSnapshot {
  return {
    financialStatus: parsed.financialStatus,
    fulfillmentState: parsed.fulfillmentState,
    currency: parsed.currency,
    totalMinor: parsed.totalMinor,
    shippingMinor: parsed.shippingMinor,
    discountMinor: parsed.discountMinor,
    cancelled: parsed.cancelledAt !== null,
    // Billing first, then shipping — the same order the document writer uses,
    // so the diff watches whichever party the order would actually be filed
    // against rather than a field that may never be sent.
    party: partyFingerprint(parsed.partner ?? parsed.receiver),
    lines: parsed.lines.map((line) => ({
      shopifyLineItemId: line.shopifyLineItemId,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
      discountMinor: line.discountMinor,
    })),
  };
}

/**
 * `parseOrder`, but a payload it cannot read is null rather than a throw.
 *
 * For every caller that re-parses a *stored* payload rather than an incoming
 * one, because a stored payload is not guaranteed to still be an order. The
 * §2.4 retention job overwrites personal data in place after ninety days, and
 * it replaces whole objects with the string "[redacted]" — `customer`,
 * `billing_address` and `shipping_address` among them. Handing that to a schema
 * expecting an object throws.
 *
 * That failure would land in the worst possible places: the document writer,
 * the order sync and the exception re-check all re-read the stored payload, and
 * all three would have gone from "this order is too old to send" to "this job
 * crashes, retries, and crashes again". Null says the same thing without
 * taking anything down, and every caller already has a path for a payload that
 * is not there.
 */
export function parseOrderSafe(payload: unknown): ParsedOrder | null {
  if (!payload) return null;
  const parsed = orderPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  return parseOrder(payload);
}

/**
 * Fields dropped from an order payload before it is stored.
 *
 * §2.4 is data minimisation: only what is needed to build a MetaKocka partner
 * and receiver, and nothing stored that is not sent. `order.raw_payload` is
 * deliberately Shopify's whole record — the document writer, the partner
 * resolver and the tax re-derivation all read it, and a payload trimmed to
 * today's diff goes stale permanently — but these are not part of that record.
 *
 * `client_details` is the shopper's browser: user agent, accept-language,
 * session hash and their IP address again. `browser_ip` is the IP on its own.
 * Nothing in this app has ever read either, none of it reaches MetaKocka, and
 * both are personal data in their own right under the Level 2 approval. So
 * they are dropped at the boundary rather than kept for ninety days and then
 * redacted.
 */
const NOT_STORED = ["client_details", "browser_ip"] as const;

/**
 * An order payload with the fields this app has no business keeping removed.
 *
 * Applied where the payload is written, not where it is read, so an order
 * stored before this existed is left exactly as it was — the retention job
 * already covers those two keys, and rewriting history to look tidier would
 * lose the record of what was actually received.
 */
export function minimiseOrderPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload;

  const record = payload as Record<string, unknown>;
  if (!NOT_STORED.some((key) => key in record)) return payload;

  const out: Record<string, unknown> = { ...record };
  for (const key of NOT_STORED) delete out[key];
  return out;
}

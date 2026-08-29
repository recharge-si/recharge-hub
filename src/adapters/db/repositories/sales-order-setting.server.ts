import { prisma } from "~/adapters/db/client.server";
import { DEFAULT_CUSTOMER_ORDER_TEMPLATE } from "~/domain/orders/reference";
import type { ObsoleteDocumentPolicy } from "~/domain/orders/reconcile";
import type { PaymentAllocationStrategy } from "~/domain/payments/allocation";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * How this app synchronises an order into MetaKocka and what it does when the
 * order changes afterwards (CLAUDE.md §8.8, and the order-reconciliation brief
 * §10, §19, §20).
 *
 * There is no row until the merchant saves one, and the defaults *are* the
 * behaviour: a shop that never opens the settings screen gets the behaviour
 * described here.
 */

export type AllocationMode = "shopify_locations" | "stock_rules";
/**
 * Whether one Shopify order becomes one MetaKocka sales order or several.
 *
 * `per_warehouse` is what this connector has always done: MetaKocka's
 * `warehouse` is a document-level attribute (§3), so an order shipping from two
 * warehouses can only be described as two sales orders linked by their
 * `buyer_order`.
 *
 * `single` is the other honest answer. One document carries every line of the
 * Shopify order and **no warehouse mark at all**, so MetaKocka files it against
 * the company default. Nothing is allocated, nothing is split, and the ERP no
 * longer says which warehouse the goods left from — which is precisely the
 * trade a merchant who does not run their warehouses in MetaKocka wants to
 * make.
 */
export type SalesOrderSplit = "per_warehouse" | "single";
export type PaymentEntryMode = "per_transaction" | "aggregate";
export type DiscountRepresentation = "none" | "document_discount_value";

export interface SalesOrderSettings {
  /** Rewrite the MetaKocka document when the Shopify order changes. */
  updateOnChange: boolean;
  /** Keep rewriting even after a payment has been recorded against it. */
  updateAfterPaid: boolean;
  /**
   * What MetaKocka shows as *Customer's order*, as a template. Null is the
   * default template; see `domain/orders/reference`.
   */
  customerOrderTemplate: string | null;
  /**
   * Whether the order is split across its warehouses at all.
   *
   * `allocationMode` above answers "which system decides the warehouse", and
   * under `single` there is no warehouse to decide: the question does not
   * arise, so the setting is kept but has no effect.
   */
  salesOrderSplit: SalesOrderSplit;
  allocationMode: AllocationMode;
  obsoleteDocumentPolicy: ObsoleteDocumentPolicy;
  syncPayments: boolean;
  paymentAllocation: PaymentAllocationStrategy;
  paymentEntryMode: PaymentEntryMode;
  /**
   * The MetaKocka product code a shipping charge is written against, or null
   * when the merchant has not chosen one. Never derived: it is an article in
   * their catalogue and only they know which.
   */
  shippingProductCode: string | null;
  discountRepresentation: DiscountRepresentation;
}

/**
 * The defaults, each chosen for a stated reason.
 *
 *  - `updateOnChange` on, because the alternative is an ERP holding quantities
 *    nobody agreed to, with an exception the merchant can read but not act on.
 *  - `updateAfterPaid` off, because a paid document is the one most likely to
 *    have been invoiced in MetaKocka, and replacing an invoiced document
 *    changes an accounting record. The highest-stakes case keeps the cautious
 *    behaviour until the merchant says otherwise. Note this gates *content*
 *    changes only: a payment arriving against a paid document is the payment
 *    path doing its job, not a rewrite of the order.
 *  - `salesOrderSplit` splits per warehouse, because MetaKocka's `warehouse`
 *    is document-level and a single document for a two-warehouse order can
 *    only name one of them — which leaves the ERP's stock wrong about goods it
 *    actually shipped. A shop that does not want the split says so.
 *  - `allocationMode` follows Shopify, because a merchant moving a line to
 *    another location in the Shopify admin is stating where it ships from, and
 *    an ERP that ignores that describes the wrong warehouse. Stock rules still
 *    fill in whatever Shopify has not assigned.
 *  - `obsoleteDocumentPolicy` empties, because leaving a document that the
 *    order no longer takes anything from leaves *quantities* in the ERP, which
 *    breaks the one invariant this connector exists to hold. Emptying keeps
 *    the document, its number and its history; nothing is deleted.
 *  - `syncPayments` on, and per transaction, because the array shape of
 *    `mark_paid` is what lets two captures stay visible as two receipts.
 *  - `paymentAllocation` proportional, so each document's payment matches its
 *    own value — what an accountant reading one document expects.
 */
export const SALES_ORDER_DEFAULTS: SalesOrderSettings = {
  updateOnChange: true,
  updateAfterPaid: false,
  customerOrderTemplate: null,
  salesOrderSplit: "per_warehouse",
  allocationMode: "shopify_locations",
  obsoleteDocumentPolicy: "empty",
  syncPayments: true,
  paymentAllocation: "proportional",
  paymentEntryMode: "per_transaction",
  /*
   * Both unset on purpose. Until a merchant chooses, an order carrying shipping
   * or a discount raises `commercial_representation_missing` and is not
   * reported as commercially reconciled — which is better than quietly sending
   * a sales order short of the postage the customer paid. There is no safe
   * default: the product is one only they can name, and guessing which article
   * their accountant expects postage on is not this app's decision.
   */
  shippingProductCode: null,
  discountRepresentation: "none",
};

/** The template actually used, with the default applied. */
export function effectiveCustomerOrderTemplate(
  settings: Pick<SalesOrderSettings, "customerOrderTemplate">,
): string {
  const template = (settings.customerOrderTemplate ?? "").trim();
  return template || DEFAULT_CUSTOMER_ORDER_TEMPLATE;
}

export async function getSalesOrderSettings(
  principal: Principal,
): Promise<SalesOrderSettings> {
  const row = await prisma.salesOrderSetting.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: {
      updateOnChange: true,
      updateAfterPaid: true,
      customerOrderTemplate: true,
      salesOrderSplit: true,
      allocationMode: true,
      obsoleteDocumentPolicy: true,
      syncPayments: true,
      paymentAllocation: true,
      paymentEntryMode: true,
      shippingProductCode: true,
      discountRepresentation: true,
    },
  });

  return row ?? { ...SALES_ORDER_DEFAULTS };
}

export async function saveSalesOrderSettings(
  principal: Principal,
  input: SalesOrderSettings,
): Promise<void> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  await prisma.salesOrderSetting.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, ...input },
    update: input,
  });
}

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
export type PaymentEntryMode = "per_transaction" | "aggregate";

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
  allocationMode: AllocationMode;
  obsoleteDocumentPolicy: ObsoleteDocumentPolicy;
  syncPayments: boolean;
  paymentAllocation: PaymentAllocationStrategy;
  paymentEntryMode: PaymentEntryMode;
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
  allocationMode: "shopify_locations",
  obsoleteDocumentPolicy: "empty",
  syncPayments: true,
  paymentAllocation: "proportional",
  paymentEntryMode: "per_transaction",
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
      allocationMode: true,
      obsoleteDocumentPolicy: true,
      syncPayments: true,
      paymentAllocation: true,
      paymentEntryMode: true,
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

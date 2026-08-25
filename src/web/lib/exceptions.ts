/**
 * What each exception kind means, in the merchant's words.
 *
 * §2.8 asks that an error say what is wrong *and* how to fix it. The per-row
 * message does that with the specifics; this is the label and the one-line
 * summary that go with the kind itself, so a count on the home page reads as
 * "3 SKUs missing from MetaKocka" rather than "3 sku_not_in_metakocka".
 */
export interface ExceptionCopy {
  label: string;
  /** Fits after a number: "3 SKUs missing from MetaKocka". */
  short: string;
  /** What a merchant should do about it. */
  guidance: string;
}

const COPY: Record<string, ExceptionCopy> = {
  sku_not_in_metakocka: {
    label: "SKU missing from MetaKocka",
    short: "with a SKU MetaKocka does not have",
    guidance:
      "Add the product in MetaKocka with the SKU as its code, or turn on creating missing products on the product sync page, then retry.",
  },
  insufficient_stock: {
    label: "Not enough stock",
    short: "with not enough stock",
    guidance:
      "Restock, or choose a supply source by hand. Nothing is sent to the ERP for the unfilled part until you decide.",
  },
  profit_center_rejected: {
    label: "Profit centre rejected",
    short: "rejected for the profit centre",
    guidance:
      "MetaKocka only accepts a profit centre that already exists there. Correct it on the warehouse, then retry.",
  },
  warehouse_invalid: {
    label: "Warehouse mark not in MetaKocka",
    short: "with an unknown warehouse",
    guidance:
      "MetaKocka accepts an unknown warehouse silently and files the order against the company default, so this is stopped before sending. Reload the warehouse list and check the mapping.",
  },
  unmapped_payment_gateway: {
    label: "Payment gateway not mapped",
    short: "with an unmapped payment gateway",
    guidance:
      "Map the gateway to a MetaKocka payment type on the Payment types page, then retry.",
  },
  partially_paid: {
    label: "Partially paid",
    short: "partially paid",
    guidance:
      "The order was created but not marked paid, because a part payment cannot be guessed. Record the payment in MetaKocka.",
  },
  voided_payment: {
    label: "Payment voided",
    short: "with a voided payment",
    guidance:
      "The MetaKocka document is never deleted automatically — it may already be invoiced. Decide what to do in the ERP.",
  },
  refund_received: {
    label: "Refunded in Shopify",
    short: "refunded",
    guidance:
      "Refunds are not sent to MetaKocka in this version. Issue the credit note there, then resolve this.",
  },
  order_cancelled: {
    label: "Cancelled in Shopify",
    short: "cancelled",
    guidance:
      "Cancel or credit the document in MetaKocka by hand. Nothing is deleted automatically, because it may already be invoiced.",
  },
  order_edited: {
    label: "Edited after allocation",
    short: "edited after allocation",
    guidance:
      "The allocation and any document still describe the order as it was. Check both sides and update MetaKocka.",
  },
  order_diverged: {
    label: "Changed after it was sent",
    short: "changed after being sent to MetaKocka",
    guidance:
      "Shopify's version of the order no longer matches the document in MetaKocka. Correct it there, then use \"Mark as sorted in MetaKocka\" on the order so it stops being reported.",
  },
  stock_sync_failed: {
    label: "Stock not syncing",
    short: "whose stock is not syncing",
    guidance:
      "Quantities are not moving between Shopify and MetaKocka for that location, so what the store is selling may be out of date. The message says what MetaKocka answered.",
  },
  metakocka_document_missing: {
    label: "Document deleted in MetaKocka",
    short: "whose MetaKocka document has been deleted",
    guidance:
      "The order is no longer in the ERP. Send it again if that was not deliberate, or resolve this if it was.",
  },
  metakocka_document_changed: {
    label: "Document edited in MetaKocka",
    short: "whose MetaKocka document has been edited",
    guidance:
      "The document no longer says what this app sent. Nothing is changed automatically — it may already be invoiced. Check it in MetaKocka.",
  },
  payment_write_failed: {
    label: "Payment not recorded",
    short: "whose payment could not be recorded",
    guidance:
      "The sales order itself is unchanged. Record the payment in MetaKocka by hand, or fix what the message names and retry.",
  },
  metakocka_write_failed: {
    label: "MetaKocka rejected the order",
    short: "MetaKocka would not accept",
    guidance:
      "The exact reason is on the exception. Fix what it names, then retry — nothing was written.",
  },
  fulfillment_split_failed: {
    label: "Could not split the fulfilment order",
    short: "whose fulfilment order could not be split",
    guidance:
      "Shopify would not move or split the fulfilment order. Check the location is still active, then retry.",
  },
  tax_undeterminable: {
    label: "Tax rate could not be determined",
    short: "with no usable tax rate",
    guidance:
      "The order has no tax lines to derive a rate from. Set the rate in MetaKocka, or check the tax settings for that market.",
  },
  job_failed: {
    label: "Background work stopped",
    short: "whose background work stopped",
    guidance:
      "A job ran out of retries and will not run again on its own. The recorded failure is on the exception. Fix what it names, then retry.",
  },
};

const FALLBACK: ExceptionCopy = {
  label: "Needs attention",
  short: "needing attention",
  guidance: "Open the order to see what happened.",
};

export function describeExceptionKind(kind: string): ExceptionCopy {
  return COPY[kind] ?? FALLBACK;
}

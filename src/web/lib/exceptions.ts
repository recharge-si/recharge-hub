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
      "Each payment Shopify has recorded is sent to MetaKocka as it arrives. This is here so you can see the order is not settled yet.",
  },
  sync_inconsistent: {
    label: "MetaKocka does not add up",
    short: "where MetaKocka does not add up",
    guidance:
      "What the sales orders hold is not what Shopify says the order contains. Nothing extra was created — another document would make the difference bigger. The order page states the difference for each SKU.",
  },
  payment_unallocated: {
    label: "Payment could not be recorded",
    short: "with a payment that could not be recorded",
    guidance:
      "Money arrived that has no MetaKocka document to go on. Nothing was written anywhere else. Check the order, then reconcile it again.",
  },
  unmapped_location: {
    label: "Location not mapped",
    short: "fulfilled from an unmapped location",
    guidance:
      "Shopify is fulfilling part of the order from a location with no MetaKocka warehouse, so those lines were not sent. Map it on the Locations page, then reconcile the order again.",
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
      'Shopify\'s version of the order no longer matches the document in MetaKocka. Correct it there, then use "Mark as sorted in MetaKocka" on the order so it stops being reported.',
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
    label: "VAT not decided",
    short: "whose VAT has not been decided",
    guidance:
      "The order has no usable VAT decision on record, so no document was written. Reconcile the order to decide it under the current Taxes & VAT settings.",
  },
  tax_mapping_missing: {
    label: "VAT rate not mapped",
    short: "using a VAT rate with no MetaKocka mapping",
    guidance:
      "The order uses a VAT rate that has no MetaKocka mapping, so it was not sent. Map the rate on the Taxes & VAT page, then reconcile the order again.",
  },
  tax_treatment_unknown: {
    label: "VAT treatment unclear",
    short: "whose VAT treatment could not be told",
    guidance:
      "This app could not say what kind of VAT event the order is — an unexplained 0%, a destination it is not allowed to stand the home rate in for, or no destination at all. The message names the choice to make on the Taxes & VAT page, or the address to add in Shopify. Nothing is guessed.",
  },
  tax_data_insufficient: {
    label: "Shopify tax breakdown missing",
    short: "taxed by Shopify without a per-line rate",
    guidance:
      "Shopify charged tax on the order but did not say at what rate for every line, so the document cannot state the VAT. Check the order's taxes in Shopify, then reconcile it again.",
  },
  tax_reconciliation_failed: {
    label: "Tax does not add up",
    short: "whose line taxes do not add up to the order tax",
    guidance:
      "What Shopify reports per line does not add up to what it reports for the order, beyond a cent of rounding. Check the order's taxes in Shopify, then reconcile it again.",
  },
  vat_registration_configuration_error: {
    label: "VAT registration not configured",
    short: "charged destination VAT with no registration to file it under",
    guidance:
      "Shopify charged a destination country's VAT, but neither EU OSS nor a registration in that country is configured here, so this app cannot say how that VAT is reported. Enable OSS or add the registration on the Taxes & VAT page, then reconcile the order again.",
  },
  commercial_representation_missing: {
    label: "Shipping or discount has nowhere to go",
    short: "carrying shipping or a discount MetaKocka cannot show",
    guidance:
      "The goods were sent, but MetaKocka has no article for the postage or no way to show the discount, so the sales order is short by that amount. Choose a shipping product and a discount representation in the order settings, then reconcile the order again. Nothing is guessed.",
  },
  job_failed: {
    label: "Background work stopped",
    short: "whose background work stopped",
    guidance:
      "A job ran out of retries and will not run again on its own. The recorded failure is on the exception. Fix what it names, then retry.",
  },
  sale_price_conflict: {
    label: "Price changed outside the sale",
    short: "whose price was changed outside its sale campaign",
    guidance:
      "Something other than this app — a price sync, a person in the admin — changed a variant that a sale campaign is holding. Nothing was overwritten. Open the campaign's variants and choose: keep the campaign price, recalculate it from the new price, or leave the new price and release the variant.",
  },
  sale_apply_failed: {
    label: "Sale not fully applied",
    short: "whose sale could not be applied to every variant",
    guidance:
      "Some variants were not put on sale. The campaign page lists each one with Shopify's reason; fix what it names, then retry the failed variants. The rest of the campaign is live.",
  },
  sale_restore_failed: {
    label: "Original prices not fully restored",
    short: "whose original prices could not all be put back",
    guidance:
      "Some variants still show the sale price after the campaign ended. The campaign page lists each one with Shopify's reason; retry the failed variants. Their original prices are kept until they are back.",
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

/**
 * Where a merchant goes to make this stop being true.
 *
 * docs/BUILD_SPEC.md section 2.7 is explicit that a feature which can only be
 * completed on an external site is not done, and section 11 asks every
 * exception to be solvable from inside the app. Guidance that names a page and
 * does not link to it is halfway there: the home page shows a handful of these
 * with no room for a paragraph, so each kind carries the one place that fixes
 * it.
 *
 * Null means the fix is on the order itself, which is where the caller falls
 * back to. Nothing here links outside the app.
 */
export interface ExceptionAction {
  label: string;
  href: string;
}

const ACTIONS: Record<string, ExceptionAction> = {
  unmapped_payment_gateway: {
    label: "Configure payments",
    href: "/app/orders/settings/payments",
  },
  unmapped_location: { label: "Configure location", href: "/app/locations" },
  warehouse_invalid: { label: "Configure location", href: "/app/locations" },
  profit_center_rejected: {
    label: "Configure location",
    href: "/app/locations",
  },
  stock_sync_failed: { label: "Open locations", href: "/app/locations" },
  sku_not_in_metakocka: { label: "Open products", href: "/app/products" },
  commercial_representation_missing: {
    label: "Open order settings",
    href: "/app/orders/settings",
  },
  tax_undeterminable: {
    label: "Open Taxes & VAT",
    href: "/app/settings/taxes",
  },
  tax_mapping_missing: {
    label: "Configure mapping",
    href: "/app/settings/taxes/mappings",
  },
  tax_treatment_unknown: {
    label: "Open Taxes & VAT",
    href: "/app/settings/taxes/registrations",
  },
  vat_registration_configuration_error: {
    label: "Open registrations",
    href: "/app/settings/taxes/registrations",
  },
  sale_price_conflict: { label: "Open sales", href: "/app/sales" },
  sale_apply_failed: { label: "Open sales", href: "/app/sales" },
  sale_restore_failed: { label: "Open sales", href: "/app/sales" },
};

export function exceptionAction(kind: string): ExceptionAction | null {
  return ACTIONS[kind] ?? null;
}

/** How many open exceptions one category loads at once, and grows by on "Load more". */
export const EXCEPTIONS_PAGE_SIZE = 5;

/**
 * The `limit` query parameter for one category's own page, e.g.
 * `limit_stock_sync_failed`.
 *
 * Paging is per category, not global: an early implementation loaded a single
 * page across every kind ordered by recency, which meant a category with no
 * exceptions in the last few minutes simply never appeared — its "Load more"
 * was a button for a category the merchant could not see existed. Each
 * category needs its own limit, carried in its own query parameter, so
 * loading more of one never resets or hides another.
 */
export function limitParamFor(kind: string): string {
  return `limit_${kind}`;
}

const MAX_EXCEPTIONS_LIMIT = 500;

/**
 * The `limit` query parameter, bounded.
 *
 * Anything absent, non-numeric, non-positive, or absurd (someone hand-editing
 * the URL) falls back to the first page rather than either erroring or, worse,
 * loading every open exception at once — which is the load this pagination
 * exists to avoid putting on the page and the database both.
 */
export function parseExceptionsLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return EXCEPTIONS_PAGE_SIZE;
  }
  return Math.min(n, MAX_EXCEPTIONS_LIMIT);
}

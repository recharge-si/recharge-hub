import type {
  FinancialStatus,
  OrderLineSnapshot,
  OrderSnapshot,
} from "~/domain/orders/types";

/**
 * What changed about an order since this app last looked, and what that means.
 *
 * An order is not a fact that arrives once. It is paid an hour later, edited
 * the next morning, refunded on Friday — and before this module the app heard
 * only the first of those. `orders/create` wrote the order and everything after
 * it was invisible, so an order that arrived unpaid stayed unpaid in MetaKocka
 * for good, whatever the merchant saw in Shopify.
 *
 * Two decisions are made here and nowhere else:
 *
 *  - **`diffOrder`** — what actually changed, at the level of things this app
 *    would have sent differently.
 *  - **`paymentActionFor`** — what the payment state Shopify now reports means
 *    we must do.
 *
 * Both are pure (§5). They take snapshots and return decisions; the caller
 * writes rows, calls MetaKocka and raises exceptions. Payment is the highest
 * consequence logic in this app after allocation — getting it wrong misstates a
 * merchant's books — so it is exhaustively testable without a database.
 */

/* -------------------------------------------------------------------------- */
/* Money, for the descriptions only                                           */
/* -------------------------------------------------------------------------- */

/**
 * Minor units as a plain decimal string.
 *
 * Not currency formatting — the UI does that with the shop's locale. This is
 * only so a change description reads "12.00 to 15.00" rather than "1200 to
 * 1500", and it is integer arithmetic throughout because §15 keeps floats away
 * from money even when the result is going into a sentence.
 */
function decimal(minor: number, decimals = 2): string {
  const negative = minor < 0;
  const digits = Math.abs(Math.trunc(minor))
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction =
    decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** "Carbon mast (MAST-490)", or just the title when there is no SKU. */
function name(line: Pick<OrderLineSnapshot, "sku" | "title">): string {
  return `${line.title}${line.sku ? ` (${line.sku})` : ""}`;
}

/**
 * The customer, reduced to something comparable that is not the customer.
 *
 * Only the fields that end up on the MetaKocka document as the partner's
 * identity. Email and phone are deliberately left out: they move for reasons
 * that do not change who the document is for — a formatting change, a
 * marketing address swapped in — and a divergence exception raised over one of
 * those on an order already in the ERP is noise the merchant learns to ignore.
 *
 * The result never reaches a log or a message. It exists to be compared with
 * another one, and `diffOrder` reports the fact of a change without repeating
 * its contents (§2.4).
 */
export function partyFingerprint(
  party: {
    customer?: string | null;
    street?: string | null;
    postNumber?: string | null;
    place?: string | null;
    country?: string | null;
  } | null,
): string | null {
  if (!party) return null;

  const parts = [
    party.customer,
    party.street,
    party.postNumber,
    party.place,
    party.country,
  ]
    .map((value) => (value ?? "").trim().toLowerCase())
    .join("|");

  // All blank is the same as having nobody: MetaKocka needs a name at minimum.
  return parts.replaceAll("|", "").length > 0 ? parts : null;
}

/* -------------------------------------------------------------------------- */
/* The diff                                                                   */
/* -------------------------------------------------------------------------- */

export type LineChangeKind =
  | "added"
  | "removed"
  | "quantity"
  | "price"
  | "discount"
  | "sku";

export interface LineChange {
  shopifyLineItemId: string;
  sku: string;
  title: string;
  kind: LineChangeKind;
  /** Merchant-readable, and the only thing an exception message needs. */
  description: string;
}

export type MoneyField = "total" | "shipping" | "discount" | "currency";

export interface MoneyChange {
  field: MoneyField;
  description: string;
}

export interface OrderDiff {
  /** Anything at all moved. */
  changed: boolean;

  paymentChanged: boolean;
  financialStatusFrom: FinancialStatus;
  financialStatusTo: FinancialStatus;

  fulfillmentChanged: boolean;

  /** Shopify has cancelled the order and had not before. */
  cancelledNow: boolean;

  /** The customer or their address moved. */
  partyChanged: boolean;
  /** Shopify had nobody to file the order against, and now does. */
  partyArrived: boolean;

  moneyChanges: MoneyChange[];
  lineChanges: LineChange[];

  /**
   * The order is no longer the order a MetaKocka document describes.
   *
   * Lines or money, never payment or fulfilment: those two move on their own
   * without making the document wrong. This is the flag that decides whether a
   * human has to look.
   */
  contentChanged: boolean;

  /** Every change, one sentence each, in the merchant's words. */
  summary: string[];
}

function byLineId(lines: OrderLineSnapshot[]): Map<string, OrderLineSnapshot> {
  return new Map(lines.map((line) => [line.shopifyLineItemId, line]));
}

/**
 * Compares two snapshots of the same order.
 *
 * `before` is what this app has stored and, for anything already written, what
 * MetaKocka holds. `after` is what Shopify says now.
 */
export function diffOrder(
  before: OrderSnapshot,
  after: OrderSnapshot,
): OrderDiff {
  const moneyChanges: MoneyChange[] = [];
  const lineChanges: LineChange[] = [];

  if (before.currency !== after.currency) {
    moneyChanges.push({
      field: "currency",
      description: `Currency changed from ${before.currency} to ${after.currency}.`,
    });
  }
  if (before.totalMinor !== after.totalMinor) {
    moneyChanges.push({
      field: "total",
      description: `Order total changed from ${decimal(before.totalMinor)} to ${decimal(after.totalMinor)} ${after.currency}.`,
    });
  }
  if (before.shippingMinor !== after.shippingMinor) {
    moneyChanges.push({
      field: "shipping",
      description: `Shipping changed from ${decimal(before.shippingMinor)} to ${decimal(after.shippingMinor)} ${after.currency}.`,
    });
  }
  if (before.discountMinor !== after.discountMinor) {
    moneyChanges.push({
      field: "discount",
      description: `Order discount changed from ${decimal(before.discountMinor)} to ${decimal(after.discountMinor)} ${after.currency}.`,
    });
  }

  const previous = byLineId(before.lines);
  const current = byLineId(after.lines);

  for (const line of after.lines) {
    const was = previous.get(line.shopifyLineItemId);

    if (!was) {
      lineChanges.push({
        shopifyLineItemId: line.shopifyLineItemId,
        sku: line.sku,
        title: line.title,
        kind: "added",
        description: `Line added: ${line.quantity} x ${name(line)}.`,
      });
      continue;
    }

    if (was.quantity !== line.quantity) {
      lineChanges.push({
        shopifyLineItemId: line.shopifyLineItemId,
        sku: line.sku,
        title: line.title,
        kind: "quantity",
        description: `${name(line)}: quantity changed from ${was.quantity} to ${line.quantity}.`,
      });
    }

    if (was.unitPriceWithTaxMinor !== line.unitPriceWithTaxMinor) {
      lineChanges.push({
        shopifyLineItemId: line.shopifyLineItemId,
        sku: line.sku,
        title: line.title,
        kind: "price",
        description: `${name(line)}: unit price changed from ${decimal(was.unitPriceWithTaxMinor)} to ${decimal(line.unitPriceWithTaxMinor)} ${after.currency}.`,
      });
    }

    if (was.discountMinor !== line.discountMinor) {
      lineChanges.push({
        shopifyLineItemId: line.shopifyLineItemId,
        sku: line.sku,
        title: line.title,
        kind: "discount",
        description: `${name(line)}: line discount changed from ${decimal(was.discountMinor)} to ${decimal(line.discountMinor)} ${after.currency}.`,
      });
    }

    /*
     * A SKU that changes under an unchanged line id is rare and serious. The
     * MetaKocka document references a catalogue product by code, so this means
     * the ERP is holding a document for the wrong article — which no amount of
     * quantity arithmetic would reveal.
     */
    if (was.sku !== line.sku) {
      lineChanges.push({
        shopifyLineItemId: line.shopifyLineItemId,
        sku: line.sku,
        title: line.title,
        kind: "sku",
        description: `${line.title}: SKU changed from ${was.sku || "none"} to ${line.sku || "none"}.`,
      });
    }
  }

  for (const line of before.lines) {
    if (current.has(line.shopifyLineItemId)) continue;
    lineChanges.push({
      shopifyLineItemId: line.shopifyLineItemId,
      sku: line.sku,
      title: line.title,
      kind: "removed",
      description: `Line removed: ${line.quantity} x ${name(line)}.`,
    });
  }

  const paymentChanged = before.financialStatus !== after.financialStatus;
  const fulfillmentChanged = before.fulfillmentState !== after.fulfillmentState;
  const cancelledNow = !before.cancelled && after.cancelled;
  const partyChanged = before.party !== after.party;
  const partyArrived = before.party === null && after.party !== null;

  /*
   * A customer who changed counts as content, and one who arrived does not.
   *
   * The distinction is what MetaKocka already holds. A document filed against
   * the wrong customer is wrong in the way §8.8 cares about, so a *changed*
   * party is a divergence like a changed quantity. But a party *arriving* is
   * the order becoming sendable for the first time — there is no document to
   * be wrong, and treating it as a divergence would put an exception in front
   * of the merchant at the exact moment they had just fixed one.
   */
  const contentChanged =
    moneyChanges.length > 0 ||
    lineChanges.length > 0 ||
    (partyChanged && !partyArrived);

  const summary: string[] = [];
  if (paymentChanged) {
    summary.push(
      `Payment status changed from ${before.financialStatus} to ${after.financialStatus}.`,
    );
  }
  if (cancelledNow) summary.push("The order was cancelled in Shopify.");
  /*
   * Said, never quoted. The summary goes into the event log and into exception
   * messages, and neither is covered by the §2.4 retention job — so it reports
   * that the customer details moved without repeating them.
   */
  if (partyArrived) {
    summary.push("Shopify now has a customer and address for this order.");
  } else if (partyChanged) {
    summary.push("The customer details on the order changed in Shopify.");
  }
  for (const change of moneyChanges) summary.push(change.description);
  for (const change of lineChanges) summary.push(change.description);

  return {
    changed:
      paymentChanged ||
      fulfillmentChanged ||
      cancelledNow ||
      partyChanged ||
      contentChanged,
    paymentChanged,
    financialStatusFrom: before.financialStatus,
    financialStatusTo: after.financialStatus,
    fulfillmentChanged,
    cancelledNow,
    partyChanged,
    partyArrived,
    moneyChanges,
    lineChanges,
    contentChanged,
    summary,
  };
}

/* -------------------------------------------------------------------------- */
/* What the payment state means                                               */
/* -------------------------------------------------------------------------- */

export type PaymentExceptionKind =
  | "partially_paid"
  | "voided_payment"
  | "refund_received";

export type PaymentAction =
  /** Nothing to do. Not every movement is an event. */
  | { kind: "none"; reason: string }
  /** Record the payment against the MetaKocka documents. */
  | { kind: "mark_paid" }
  /** A human decides. §8.7 is explicit that none of these are guessed at. */
  | { kind: "exception"; exception: PaymentExceptionKind; message: string };

export interface PaymentContext {
  /**
   * Whether every written document for this order already carries a payment.
   *
   * `mark_paid` on an update **deletes the previous payment and replaces it**
   * (§8.7), so it is sent exactly once per document. This flag is what makes a
   * redelivered `orders/paid` webhook, or a reconciliation pass over an order
   * that was settled last week, cost nothing.
   */
  alreadyMarkedPaid: boolean;
}

/**
 * What to do about the payment state Shopify now reports (§8.7).
 *
 * Written as a function of the *destination* state rather than of the
 * transition, deliberately. Shopify does not promise to deliver every
 * intermediate state, and the reconciler — which exists precisely because
 * webhooks get lost — routinely sees pending jump straight to refunded. A rule
 * matching on "authorized to paid" would then quietly do nothing for the very
 * order it was written to catch.
 *
 * The transition is used for one thing only: direction of travel. A status
 * moving *back* to pending or authorized is not a payment being undone —
 * Shopify says that with `voided` or `refunded` — so nothing is sent for it.
 */
export function paymentActionFor(
  from: FinancialStatus,
  to: FinancialStatus,
  context: PaymentContext,
): PaymentAction {
  if (to === "paid") {
    if (context.alreadyMarkedPaid) {
      return {
        kind: "none",
        reason: "Every MetaKocka document for this order is already paid.",
      };
    }
    return { kind: "mark_paid" };
  }

  if (to === "partially_paid") {
    return {
      kind: "exception",
      exception: "partially_paid",
      message:
        "Shopify now reports this order as partly paid. A part payment cannot be divided across the MetaKocka documents by guesswork, so nothing was sent. Record the payment in MetaKocka, then resolve this.",
    };
  }

  if (to === "voided") {
    return {
      kind: "exception",
      exception: "voided_payment",
      message:
        "The payment for this order was voided in Shopify. Nothing has been deleted in MetaKocka, because the document may already be invoiced. Cancel or credit it there by hand, then resolve this.",
    };
  }

  if (to === "refunded" || to === "partially_refunded") {
    return {
      kind: "exception",
      exception: "refund_received",
      message:
        to === "refunded"
          ? "This order was refunded in Shopify. Refunds are not sent to MetaKocka automatically. Issue the credit note there, then resolve this."
          : "This order was partly refunded in Shopify. Refunds are not sent to MetaKocka automatically. Issue the credit note there, then resolve this.",
    };
  }

  // pending, authorized, unknown.
  return {
    kind: "none",
    reason: `Shopify reports ${to}, which is not a payment this app records (it was ${from}).`,
  };
}

/**
 * What to do about an order whose content has changed.
 *
 * The whole question used to be whether MetaKocka had been told. Before that,
 * an edit is simply what the order is: rewrite the lines and allocate again,
 * and nobody needs to hear about it. Afterwards, §8.8 said the ERP held a
 * document describing an order that no longer existed and only a person could
 * decide what to do — which in practice meant the ERP stayed wrong and the
 * merchant got an exception they could read but not act on.
 *
 * So there is now a third answer, and it is the merchant's to choose
 * (`sales_order_setting.update_on_change`): **resend**, which rewrites the
 * lines and re-drives the write, and the write updates the document in place
 * rather than creating a second one. `updatesAllowed` is that setting, and when
 * it is off the old behaviour is exactly what happens.
 *
 * Note this only decides the shape of the response. Whether a *particular*
 * document may be rewritten — a paid one, for instance — is decided at the
 * point of writing, where the state of that document is known.
 */
export function contentChangePolicy(input: {
  contentChanged: boolean;
  writtenDocuments: number;
  /** From the shop's sales order settings. Defaults on. */
  updatesAllowed?: boolean;
}): { kind: "ignore" } | { kind: "reallocate" } | { kind: "resend" } | {
  kind: "diverged";
} {
  if (!input.contentChanged) return { kind: "ignore" };
  if (input.writtenDocuments === 0) return { kind: "reallocate" };
  return (input.updatesAllowed ?? true)
    ? { kind: "resend" }
    : { kind: "diverged" };
}

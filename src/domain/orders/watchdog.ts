/**
 * Whether an order has gone quiet on its way to MetaKocka (the order watchdog,
 * docs/project-status.md T-11).
 *
 * Every other "not sent" reason in this app announces itself: an exception, a
 * banner, a blocked verdict. This is for the case that does not — an order
 * that should be in the ERP by now, is not, and has nothing open that says
 * why. A worker that died between retries, a write that returned without
 * writing, a reconciliation that was never queued: all of them look exactly
 * like an order that is fine, for as long as nobody opens it.
 *
 * Pure, so the rule can be read and tested in one place. The clock is passed
 * in, as everywhere in `domain/`.
 */

import {
  decideOrderTransfer,
  type OrderTransferHold,
  type OrderTransferSettings,
} from "~/domain/orders/transfer";

export type WatchedDocumentStatus = "pending" | "written" | "failed";
export type WatchedSyncState =
  "pending" | "in_sync" | "inconsistent" | "blocked";

export interface WatchedOrder {
  readonly receivedAt: Date;
  readonly cancelled: boolean;
  /** Deleted in Shopify. */
  readonly deleted: boolean;
  /** Past retention (§2.4): there is no payload left to send. */
  readonly redacted: boolean;
  readonly documents: readonly { readonly status: WatchedDocumentStatus }[];
  readonly syncState: WatchedSyncState;
  /** Open exceptions on the order of any kind other than the watchdog's own. */
  readonly otherOpenExceptions: number;
}

export interface WatchContext {
  /** When setup was finished. Null means nothing is written yet, on purpose. */
  readonly activatedAt: Date | null;
  readonly transfer: OrderTransferSettings;
  /**
   * When order settings last changed. Turning transfer back on with its
   * backlog makes old orders eligible all at once, and they deserve the same
   * grace a new order gets.
   */
  readonly settingsChangedAt: Date | null;
  readonly thresholdMs: number;
  readonly now: Date;
}

export type WatchProblem =
  /** No document has been written for it at all. */
  | "not_sent"
  /** Written, and the pass that checks MetaKocka against Shopify never ran. */
  | "not_verified";

export type WatchVerdict =
  | {
      readonly kind: "overdue";
      readonly problem: WatchProblem;
      /** How long it has been waiting, from the latest of the clock starts. */
      readonly waitingMs: number;
    }
  | { readonly kind: "fine"; readonly why: WatchFine };

export type WatchFine =
  /** In MetaKocka and verified, or settled by a pass that recorded why not. */
  | "transferred"
  /** Cancelled, deleted or redacted: nothing more is owed to the ERP. */
  | "over"
  /** Setup has not been finished. */
  | "not_activated"
  /** The transfer switch is holding it, which is a decision, not a fault. */
  | `held_${OrderTransferHold}`
  /** Another open exception already tells a person about it. */
  | "owned"
  /** Not old enough to worry about. */
  | "recent";

/**
 * The rule:
 *
 *  - An order that is over, or that the merchant has decided should not be
 *    sent (setup unfinished, transfer off, received while off), is never
 *    overdue. Raising those would be the noise that teaches people to ignore
 *    the queue.
 *  - An order is in MetaKocka when every document it has is written and the
 *    reconciliation has given a verdict. `blocked` and `inconsistent` are
 *    verdicts: the pass ran and said what is wrong, and `inconsistent` has
 *    its own exception. Only `pending` means nobody has looked.
 *  - An order that already has an open exception is a person's already.
 *  - Otherwise it is overdue once it has waited longer than the threshold,
 *    counted from the latest of: when it arrived, when setup was finished,
 *    when order settings last changed.
 */
export function watchOrder(
  order: WatchedOrder,
  context: WatchContext,
): WatchVerdict {
  if (order.cancelled || order.deleted || order.redacted) {
    return { kind: "fine", why: "over" };
  }
  if (context.activatedAt === null)
    return { kind: "fine", why: "not_activated" };

  const transfer = decideOrderTransfer(context.transfer, {
    receivedAt: order.receivedAt,
    hasDocuments: order.documents.length > 0,
  });
  if (!transfer.allowed)
    return { kind: "fine", why: `held_${transfer.reason}` };

  const allWritten =
    order.documents.length > 0 &&
    order.documents.every((document) => document.status === "written");
  if (allWritten && order.syncState !== "pending") {
    return { kind: "fine", why: "transferred" };
  }

  if (order.otherOpenExceptions > 0) return { kind: "fine", why: "owned" };

  const startedAt = Math.max(
    order.receivedAt.getTime(),
    context.activatedAt.getTime(),
    context.settingsChangedAt?.getTime() ?? 0,
  );
  const waitingMs = context.now.getTime() - startedAt;
  if (waitingMs < context.thresholdMs) return { kind: "fine", why: "recent" };

  return {
    kind: "overdue",
    problem: allWritten ? "not_verified" : "not_sent",
    waitingMs,
  };
}

/** "3 hours", "2 days": how long, in the words an exception message uses. */
export function describeWaiting(waitingMs: number): string {
  const hours = Math.floor(waitingMs / 3_600_000);
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(waitingMs / 60_000));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/** The exception's message for an overdue order (§2.8: what is wrong, and what to do). */
export function describeOverdue(
  orderNumber: string,
  verdict: Extract<WatchVerdict, { kind: "overdue" }>,
): string {
  const waited = describeWaiting(verdict.waitingMs);
  return verdict.problem === "not_sent"
    ? `Order ${orderNumber} has waited ${waited} and is not in MetaKocka, and nothing else on it says why. Order transfer is on, so it should have been sent. Use Retry to reconcile it again; if it is still not sent, the order page and the background-work exceptions say what stopped it.`
    : `Order ${orderNumber} was written to MetaKocka, but in the ${waited} it has waited the check that MetaKocka holds what Shopify says never ran. Use Retry to reconcile it again so it is verified.`;
}

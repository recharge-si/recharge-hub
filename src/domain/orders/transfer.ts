/**
 * Whether an order may be transferred to MetaKocka at all (CLAUDE.md §8.8, the
 * order-transfer switch).
 *
 * Pure, so the reconciler, the write queue and the settings screen all answer
 * the question the same way.
 */

export interface OrderTransferSettings {
  /** The switch. Off means nothing about any order reaches the ERP. */
  readonly transferOrders: boolean;
  /**
   * Orders received before this moment that have no document yet are left
   * alone. Set when transfer is turned back on without its backlog. Null means
   * no cut-off.
   */
  readonly transferOrdersSince: Date | null;
}

export interface OrderTransferSubject {
  readonly receivedAt: Date;
  /** Whether MetaKocka already holds (or was asked for) a document for it. */
  readonly hasDocuments: boolean;
}

export type OrderTransferDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: OrderTransferHold };

export type OrderTransferHold = "transfer_off" | "received_while_off";

export function describeTransferHold(reason: OrderTransferHold): string {
  switch (reason) {
    case "transfer_off":
      return "order transfer to MetaKocka is turned off";
    case "received_while_off":
      return "the order was received while order transfer was off";
  }
}

/**
 * The rule, in three lines:
 *
 *  - Off is off. No document is written, updated or paid while the switch is
 *    off, including for orders MetaKocka already holds: a merchant who turned
 *    it off did so to stop the ERP changing.
 *  - An order MetaKocka already holds keeps converging once the switch is back
 *    on, whenever it was received. Leaving a written document behind the cut-off
 *    would leave the ERP wrong about goods it has a record of.
 *  - An order received before the cut-off with nothing written is left alone.
 *    It was handled some other way while transfer was off, and sending it now
 *    would duplicate it.
 */
export function decideOrderTransfer(
  settings: OrderTransferSettings,
  order: OrderTransferSubject,
): OrderTransferDecision {
  if (!settings.transferOrders) {
    return { allowed: false, reason: "transfer_off" };
  }
  if (order.hasDocuments) return { allowed: true };
  if (
    settings.transferOrdersSince !== null &&
    order.receivedAt < settings.transferOrdersSince
  ) {
    return { allowed: false, reason: "received_while_off" };
  }
  return { allowed: true };
}

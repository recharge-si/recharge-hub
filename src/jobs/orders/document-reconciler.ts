import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import {
  recordDocumentPayments,
  recordDocumentResult,
  retireDocument,
  touchDocumentReconciled,
} from "~/adapters/db/repositories/order.server";
import { replaceApplicationsForDocument } from "~/adapters/db/repositories/order-payment.server";
import type { MetakockaClient } from "~/adapters/metakocka/client";
import {
  clearedPayments,
  deleteSalesOrder,
  updateSalesOrder,
} from "~/adapters/metakocka/documents";
import { MetakockaError, describeForMerchant } from "~/adapters/metakocka/errors";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  retirementPlanFor,
  type DocumentAction,
  type ObsoleteDocumentPolicy,
} from "~/domain/orders/reconcile";
import type { Principal } from "~/domain/types";

/**
 * What happens to a MetaKocka document this order has stopped taking anything
 * from (CLAUDE.md §8.8; order-reconciliation brief §6, §9).
 *
 * This is the part of reconciliation that used to be missing, and its absence
 * was the most expensive failure the connector had. A line moving from
 * warehouse A to warehouse B produced a correct new document for B and left the
 * old one for A holding the same goods — so the order existed twice in the ERP,
 * summing to twice what the customer bought, and every scheduled cross-check
 * looked at each document individually and found nothing wrong.
 *
 * The constraint that makes this delicate is §8.8's absolute rule: **a MetaKocka
 * document is never deleted because this app decided to.** It may already be
 * invoiced, and deleting it removes an accounting entry to tidy up a screen.
 * So the default is the middle answer — reconcile the document down to holding
 * nothing, keep it, its number and its history, and tell the merchant it is
 * there. Deleting is available and is strictly opt-in, unpaid documents only.
 *
 * Whatever the policy, three things always happen: the row is marked retired so
 * it stops being paid and stops counting as primary, its payment applications
 * are cleared so the order's money is not counted twice, and the merchant is
 * told (§11).
 */

export interface RetirementOutcome {
  countCode: string;
  /** What was actually done, for the audit trail. */
  action: "emptied" | "deleted" | "reported" | "discarded" | "refused";
  reason: string;
  /** True while MetaKocka may still hold quantity for this order. */
  stillHoldsQuantity: boolean;
  /**
   * What MetaKocka still reports as paid on the document, in minor units.
   *
   * Read back from `sum_paid` rather than assumed, because the money is the
   * part that cannot be allowed to stay: the receipts have been reallocated to
   * whichever document now describes the goods, so anything left here is the
   * order paid twice.
   */
  stillHoldsPaymentMinor: number;
  /** Whether the payment was actually removed. */
  paymentCleared: boolean;
}

export interface EmptiedBody {
  body: Record<string, unknown>;
  /**
   * Whether the payment could actually be cleared.
   *
   * False when the recorded body names no payment type to hang a zero on. The
   * lines still go, so the document stops holding goods; the money stays, and
   * the caller has to say so rather than reporting a clean retirement.
   */
  paymentCleared: boolean;
}

/**
 * A document body with every product line removed, and its payment cleared.
 *
 * The whole body is replayed because MetaKocka treats an update as a
 * replacement (§3) — a patch would delete the partner, the dates and the
 * totals along with the lines. Two things change.
 *
 * `product_list` becomes empty. **[verified 2026-08-26]** MetaKocka accepts
 * that: the document came back with no `sum_all` and no readable lines.
 *
 * `mark_paid` becomes a zero entry, **not** an empty array. An empty array is
 * verified to change nothing at all — see `clearedPayments` — and a document
 * that keeps its payment after its goods moved to another warehouse is the
 * order counted twice in the merchant's books, which is the single failure this
 * whole path exists to prevent.
 */
export function emptiedBody(body: Record<string, unknown>): EmptiedBody {
  const cleared = clearedPayments(body);

  return {
    body: {
      ...body,
      product_list: [],
      ...(cleared ? { mark_paid: cleared } : {}),
    },
    paymentCleared: cleared !== null || body.mark_paid === undefined,
  };
}

export async function retireObsoleteDocument(
  principal: Principal,
  input: {
    client: MetakockaClient;
    orderId: string;
    orderNumber: string;
    action: Extract<DocumentAction, { kind: "retire" }>;
    policy: ObsoleteDocumentPolicy;
    sourceName: string | null;
    mkId: string | null;
    requestBody: unknown;
    now: Date;
  },
): Promise<RetirementOutcome> {
  const log = getLogger();
  const plan = retirementPlanFor(input.action, input.policy);
  const { countCode } = input.action;

  /*
   * The row is retired first, whatever happens to MetaKocka afterwards.
   *
   * Ordering matters: retiring is what stops this document being allocated a
   * share of the order's payments, and a MetaKocka call that fails must not
   * leave it eligible. Being retired is a statement about this app's intent,
   * and that intent is already settled by the time we get here.
   */
  await retireDocument(input.action.documentId, {
    at: input.now,
    reason: plan.reason,
    mkStatus: "no longer allocated",
  });
  await replaceApplicationsForDocument(input.action.documentId, []);
  await recordDocumentPayments(input.action.documentId, {
    at: null,
    paymentType: null,
    amountMinor: 0,
  });

  if (plan.kind === "discard") {
    // Nothing ever reached MetaKocka under this code, so there is nothing
    // there to be wrong and nobody to tell.
    await touchDocumentReconciled(input.action.documentId, input.now);
    return {
      countCode,
      action: "discarded",
      reason: plan.reason,
      stillHoldsQuantity: false,
      stillHoldsPaymentMinor: 0,
      paymentCleared: true,
    };
  }

  if (!input.mkId) {
    return {
      countCode,
      action: "reported",
      reason:
        "this app does not hold a MetaKocka id for that document, so it cannot be changed automatically",
      stillHoldsQuantity: true,
      stillHoldsPaymentMinor: 0,
      paymentCleared: false,
    };
  }

  let outcome: RetirementOutcome = {
    countCode,
    action: "reported",
    reason: plan.reason,
    stillHoldsQuantity: true,
    stillHoldsPaymentMinor: 0,
    paymentCleared: false,
  };

  try {
    if (plan.kind === "delete") {
      const { deleted } = await deleteSalesOrder(input.client, input.mkId);
      await recordDocumentResult(input.action.documentId, {
        status: "failed",
        responseBody: { deleted, retired: true },
      });
      await prisma.metakockaDocument.update({
        where: { id: input.action.documentId },
        data: { mkStatus: deleted ? "deleted in MetaKocka" : "already gone" },
      });
      outcome = {
        countCode,
        action: "deleted",
        reason: plan.reason,
        stillHoldsQuantity: false,
        stillHoldsPaymentMinor: 0,
        paymentCleared: true,
      };
    } else if (plan.kind === "empty") {
      /*
       * No recorded body means no safe replacement.
       *
       * Rebuilding one from the order would be a guess at what MetaKocka
       * currently holds, and an update *is* a replacement — so a wrong guess
       * overwrites a real document with an invention. Reporting is the honest
       * answer.
       */
      if (!input.requestBody || typeof input.requestBody !== "object") {
        outcome = {
          countCode,
          action: "reported",
          reason:
            "this app no longer holds the document exactly as MetaKocka accepted it, and an update replaces rather than patches, so it was left alone",
          stillHoldsQuantity: true,
          stillHoldsPaymentMinor: 0,
          paymentCleared: false,
        };
      } else {
        const emptied = emptiedBody(
          input.requestBody as Record<string, unknown>,
        );

        const { verified } = await updateSalesOrder(input.client, {
          mkId: input.mkId,
          body: emptied.body,
        });

        await prisma.metakockaDocument.update({
          where: { id: input.action.documentId },
          data: {
            mkStatus: "emptied, no longer allocated",
            mkCheckedAt: input.now,
            responseBody: { emptied: true, lines: verified.lineCount },
          },
        });

        outcome = {
          countCode,
          action: "emptied",
          reason: plan.reason,
          // Verified by the read-back `updateSalesOrder` already does.
          stillHoldsQuantity: (verified.lineCount ?? 0) > 0,
          // What MetaKocka itself says is still on it, not what we intended.
          stillHoldsPaymentMinor: verified.paidMinor ?? 0,
          paymentCleared: emptied.paymentCleared && (verified.paidMinor ?? 0) === 0,
        };
      }
    }
  } catch (error) {
    /*
     * The document is still MetaKocka's and still says what it said.
     *
     * Not marked failed — that would invite the write path to claim the
     * `count_code` again and create a second document (§8.4). The row stays
     * retired, the failure is recorded, and the exception below tells a person.
     */
    await prisma.metakockaDocument.update({
      where: { id: input.action.documentId },
      data: {
        mkStatus: "could not be retired",
        responseBody:
          error instanceof MetakockaError
            ? { oprCode: error.oprCode, oprDesc: error.oprDesc }
            : { error: String(error) },
      },
    });

    if (!(error instanceof MetakockaError) || error.kind !== "exception") throw error;

    outcome = {
      countCode,
      action: "refused",
      reason: describeForMerchant(error),
      stillHoldsQuantity: true,
      stillHoldsPaymentMinor: 0,
      paymentCleared: false,
    };
  }

  await touchDocumentReconciled(input.action.documentId, input.now);

  await appendEvent(principal, {
    entityType: "order",
    entityId: input.orderId,
    event: "order.document_retired",
    detail: {
      countCode,
      source: input.sourceName,
      action: outcome.action,
      reason: outcome.reason,
      paid: input.action.paid,
    },
  });

  /*
   * Always reported, even when the document was emptied successfully.
   *
   * Emptying removes the quantity; it does not remove the fact that a sales
   * order exists in the ERP for a warehouse this order no longer uses, and if
   * it was ever invoiced the merchant has a credit note to issue. §11 is about
   * conditions a person has to decide on, and this is one.
   */
  await raiseException(principal, {
    orderId: input.orderId,
    kind: "order_diverged",
    message: retirementMessage({
      orderNumber: input.orderNumber,
      sourceName: input.sourceName,
      countCode,
      outcome,
      paid: input.action.paid,
    }),
    detail: {
      countCode,
      action: outcome.action,
      reason: outcome.reason,
      paidBefore: input.action.paid,
      paymentCleared: outcome.paymentCleared,
      stillHoldsPaymentMinor: outcome.stillHoldsPaymentMinor,
    },
  });

  log.info(
    {
      shop: principal.shopDomain,
      orderId: input.orderId,
      countCode,
      action: outcome.action,
    },
    "Obsolete MetaKocka document retired",
  );

  return outcome;
}

function retirementMessage(input: {
  orderNumber: string;
  sourceName: string | null;
  countCode: string;
  outcome: RetirementOutcome;
  paid: boolean;
}): string {
  const where = input.sourceName ?? "a supply source";
  const opening = `Order ${input.orderNumber} no longer takes anything from ${where}, and MetaKocka holds ${input.countCode} for it.`;
  const paidNote = input.paid
    ? " A payment had been recorded against it, and it is no longer counted towards this order."
    : "";

  switch (input.outcome.action) {
    case "emptied":
      return (
        `${opening} Its lines have been removed so it no longer holds any of this order's goods, and the document itself was kept — it may already be invoiced.${paidNote}` +
        (input.outcome.paymentCleared
          ? ""
          : ` **MetaKocka still records ${(input.outcome.stillHoldsPaymentMinor / 100).toFixed(2)} as paid on it**, which this app could not remove, so the money for this order is currently recorded twice there.`) +
        " Cancel or credit it in MetaKocka, then resolve this."
      );
    case "deleted":
      return `${opening} It carried no payment, and your obsolete-document setting is to delete those, so it has been removed from MetaKocka.${paidNote} Resolve this once you have checked.`;
    case "refused":
      return `${opening} MetaKocka refused the change: ${input.outcome.reason} The document is exactly as it was and still holds this order's goods.${paidNote} Correct it in MetaKocka by hand, then resolve this.`;
    default:
      return `${opening} Nothing was changed — ${input.outcome.reason}.${paidNote} Cancel or credit it in MetaKocka, then resolve this.`;
  }
}

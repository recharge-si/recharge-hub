import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  closeExceptionsFor,
  raiseException,
} from "~/adapters/db/repositories/exception.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  claimPaymentMark,
  listDocumentsForPayment,
  recordPaymentMark,
  releasePaymentClaim,
} from "~/adapters/db/repositories/order.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { markDocumentPaid } from "~/adapters/metakocka/documents";
import { MetakockaError, describeForMerchant } from "~/adapters/metakocka/errors";
import { getLogger } from "~/adapters/observability/logger.server";
import { computeDocumentShares } from "~/jobs/order-shares";
import { resolvePaymentType } from "~/jobs/payment";
import { serviceToken } from "~/domain/types";

/**
 * Records a payment against sales orders MetaKocka already holds (§8.7).
 *
 * This is the second half of the answer to "an order arrives unpaid and is paid
 * an hour later". The first half is `sync-order-state`, which hears about it;
 * this is what tells the ERP.
 *
 * It is the most dangerous write in the application, for a verified reason.
 * **MetaKocka treats an update as a replacement.** Sending `put_document` with
 * `mk_id` and a payment and nothing else does not add a payment to the
 * document — it replaces the document with what was sent, and a five-line order
 * came back with no `product_list` and no totals, reported as success. §8.7
 * adds that `mark_paid` on an update deletes the previous payment too.
 *
 * So four things hold, and each one is load-bearing:
 *
 *  1. **The whole document is re-sent**, not a patch — and specifically the
 *     exact body MetaKocka accepted when the document was created, replayed
 *     from `metakocka_document.request_body`. Rebuilding it from the order
 *     would risk replacing the document with a *differently* derived version of
 *     itself, which is the one outcome worse than not recording the payment.
 *  2. **The result is read back** (`markDocumentPaid`), because the failure
 *     mode above reported success.
 *  3. **Each document is claimed first**, so the several ways this job can be
 *     triggered at once cannot each send a payment.
 *  4. **Each document is paid its own share** (§8.6, §8.7). Not the order total
 *     on the primary: the shares are computed by the same function the document
 *     writer uses, and they sum to the Shopify total exactly.
 */

export const markMetakockaPaidJobSchema = z.object({
  shopDomain: z.string().min(1),
  orderId: z.string().min(1),
});

/** The kinds this job owns, closed when a payment finally goes through. */
const PAYMENT_FAILURE_KINDS = [
  "payment_write_failed",
  "unmapped_payment_gateway",
] as const;

/**
 * Whether a stored request body is still a document MetaKocka would accept.
 *
 * The §2.4 retention job overwrites personal data in these bodies in place
 * after ninety days, so replaying one from an old order would file the
 * customer's name as "[redacted]" on a live accounting document. The order's
 * own `redacted_at` is the authoritative signal; this is the second check, for
 * the case where a body was redacted through some path the flag missed.
 */
function looksReplayable(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;

  const document = body as Record<string, unknown>;
  const lines = document.product_list;
  if (!Array.isArray(lines) || lines.length === 0) return false;

  return !JSON.stringify(document).includes("[redacted]");
}

export async function handleMarkMetakockaPaid(job: Job<unknown>): Promise<void> {
  const { shopDomain, orderId } = markMetakockaPaidJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "mark-metakocka-paid");
  const log = getLogger();

  const order = await prisma.order.findFirst({
    where: { id: orderId, shop: { domain: shopDomain } },
    select: {
      id: true,
      shopifyOrderNumber: true,
      financialStatus: true,
      paymentGateway: true,
      totalMinor: true,
      receivedAt: true,
      redactedAt: true,
      shopifyDeletedAt: true,
    },
  });
  if (!order) return;

  /*
   * Shopify has moved on since this job was queued.
   *
   * Worth re-reading rather than trusting the enqueue: an order can be paid and
   * refunded inside the few minutes a busy queue takes to reach this, and
   * recording a payment for money that has already gone back is worse than
   * recording nothing.
   */
  if (order.financialStatus !== "paid") {
    log.info(
      { shop: shopDomain, orderId, financialStatus: order.financialStatus },
      "Payment not recorded: Shopify no longer reports this order as paid",
    );
    return;
  }

  const documents = await listDocumentsForPayment(principal, orderId);
  const outstanding = documents.flatMap((document) =>
    document.status === "written" &&
    document.mkId !== null &&
    document.paymentMarkedAt === null
      ? [{ ...document, mkId: document.mkId }]
      : [],
  );

  if (outstanding.length === 0) return;

  const decision = await resolvePaymentType(principal, {
    gateway: order.paymentGateway,
    phase: "settle",
  });

  if (decision.kind === "exception") {
    await raiseException(principal, {
      orderId,
      kind: decision.exception,
      message: decision.message,
      detail: decision.detail,
    });
    return;
  }

  if (decision.kind === "none") {
    log.info({ shop: shopDomain, orderId }, decision.reason);
    return;
  }

  if (order.redactedAt) {
    /*
     * Ninety days have passed and the document body no longer holds the
     * customer. Re-sending it would replace a live accounting document with a
     * redacted copy of itself, so this stops and says so plainly. An order paid
     * three months after it was placed is rare enough to be worth a person.
     */
    await raiseException(principal, {
      orderId,
      kind: "payment_write_failed",
      message: `Order ${order.shopifyOrderNumber} has been paid in Shopify, but its details were removed under the 90-day retention policy, so the payment cannot be sent to MetaKocka automatically. Record it against ${outstanding.map((document) => document.countCode).join(", ")} in MetaKocka by hand, then resolve this.`,
      detail: { countCodes: outstanding.map((document) => document.countCode) },
    });
    return;
  }

  const credential = await getCredential(principal);
  if (!credential) {
    await raiseException(principal, {
      orderId,
      kind: "payment_write_failed",
      message:
        "MetaKocka is not connected, so the payment for this order could not be recorded. Add the credentials on the Connection page and retry.",
    });
    return;
  }

  const shares = await computeDocumentShares(orderId);
  const shareBySource = new Map(
    shares.map((share) => [share.sourceId, share.totalMinor]),
  );

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });

  let recorded = 0;

  for (const document of outstanding) {
    if (!looksReplayable(document.requestBody)) {
      await raiseException(principal, {
        orderId,
        kind: "payment_write_failed",
        message: `The payment for order ${order.shopifyOrderNumber} could not be recorded against ${document.countCode}, because this app no longer holds the document exactly as MetaKocka accepted it. Recording the payment means re-sending the whole document — MetaKocka replaces rather than patches — and sending a rebuilt one could overwrite it. Record the payment in MetaKocka by hand, then resolve this.`,
        detail: { countCode: document.countCode },
      });
      continue;
    }

    /*
     * §8.6: each document is paid its own share, and the shares sum to the
     * Shopify total.
     *
     * A document whose source is not in the current allocation has no share,
     * and must not be paid at all. It used to fall back to the order total,
     * which paid the *whole order* against a document that no longer described
     * any of it — a one-line order of 209.00 recorded as 418.00 across two
     * documents after its line moved warehouse. The order total is only ever
     * right when it is the only share there is.
     */
    const amountMinor = document.supplySourceId
      ? shareBySource.get(document.supplySourceId)
      : shares.length === 0
        ? order.totalMinor
        : undefined;

    if (amountMinor === undefined) {
      await raiseException(principal, {
        orderId,
        kind: "order_diverged",
        message: `MetaKocka holds ${document.countCode} for order ${order.shopifyOrderNumber}, but this order no longer takes anything from that supply source, so there is no payment to record against it. Nothing was deleted — it may already be invoiced. Cancel or credit it in MetaKocka, then resolve this.`,
        detail: { countCode: document.countCode },
      });

      await prisma.metakockaDocument.update({
        where: { id: document.id },
        data: { mkStatus: "no longer allocated" },
      });
      continue;
    }

    const now = new Date();
    if (!(await claimPaymentMark(document.id, now))) {
      log.info(
        { shop: shopDomain, orderId, countCode: document.countCode },
        "Payment already claimed by another job, skipping",
      );
      continue;
    }

    try {
      const { body } = await markDocumentPaid(client, {
        mkId: document.mkId,
        body: document.requestBody as Record<string, unknown>,
        payment: {
          paymentType: decision.paymentType,
          // The order's own timestamp, not the clock: a payment belongs to the
          // day the money moved, and the ERP timezone decides which day that is
          // (`toPaymentDate`).
          paidAt: order.receivedAt,
          amountMinor,
        },
      });

      await recordPaymentMark(document.id, {
        at: new Date(),
        paymentType: decision.paymentType,
        amountMinor,
        requestBody: body,
      });

      recorded += 1;

      await appendEvent(principal, {
        entityType: "order",
        entityId: orderId,
        event: "order.payment_marked",
        detail: {
          countCode: document.countCode,
          paymentType: decision.paymentType,
          amountMinor,
          gateway: order.paymentGateway,
          // A payment recorded against a type the merchant never chose for this
          // gateway reads differently in a reconciliation than a mapped one.
          viaFallback: decision.viaFallback,
          when: "after the order was written",
        },
      });

      log.info(
        {
          shop: shopDomain,
          orderId,
          countCode: document.countCode,
          amountMinor,
        },
        "Payment recorded in MetaKocka",
      );
    } catch (error) {
      // The claim goes back, so a retry — pg-boss's own or the merchant's — can
      // pick this document up instead of finding it locked out by a write that
      // never happened.
      await releasePaymentClaim(document.id);

      if (error instanceof MetakockaError && error.kind === "exception") {
        await raiseException(principal, {
          orderId,
          kind: "payment_write_failed",
          message: `The payment for order ${order.shopifyOrderNumber} was refused for ${document.countCode}. ${describeForMerchant(error)} The sales order itself is unchanged. Record the payment in MetaKocka by hand or fix the cause and retry.`,
          detail: {
            countCode: document.countCode,
            oprCode: error.oprCode,
            oprDesc: error.oprDesc,
          },
        });
        continue;
      }

      throw error;
    }
  }

  if (recorded > 0) {
    await closeExceptionsFor(principal, orderId, [...PAYMENT_FAILURE_KINDS]);
  }
}

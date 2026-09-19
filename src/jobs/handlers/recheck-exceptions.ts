import type { ExceptionKind } from "@prisma/client";
import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getTaxConfig } from "~/adapters/db/repositories/tax.server";
import {
  findPaymentType,
  getFallbackPaymentType,
} from "~/adapters/db/repositories/payment-type-map.server";
import { listCachedWarehouses } from "~/adapters/db/repositories/supply-source.server";
import { parseOrderSafe } from "~/adapters/shopify/order-payload";
import { sameLocation } from "~/adapters/shopify/locations";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  redriveOrder,
  type RedriveTarget,
} from "~/adapters/queue/redrive.server";
import { decideOrderTax } from "~/domain/tax/decide";
import { serviceToken, type Principal } from "~/domain/types";

/**
 * Closes the exceptions that have fixed themselves, and re-drives the ones that
 * can now succeed (CLAUDE.md §11).
 *
 * **An exception is a condition, not an event.** "No supply source has enough
 * stock for P04200014440" stops being true the moment the stock arrives, and
 * nothing in Shopify or MetaKocka announces that. Neither does "the profit
 * centre does not exist" once the merchant creates it, or "this gateway is not
 * mapped" once they map it. Without this job every one of them sits in the
 * queue forever, long after the thing it describes was dealt with — and a queue
 * full of problems that are not problems is a queue nobody reads, which is the
 * same as having no queue at all.
 *
 * Two outcomes, and the difference matters:
 *
 *  - **Fixed.** The work actually got done — the order is allocated, the
 *    document is written, the payment is recorded. The exception is closed,
 *    attributed to the app so the trail says it was not a person.
 *  - **Unblocked.** What the exception complained about has been put right, but
 *    the work has not been redone. The job is re-queued and the exception is
 *    left open on purpose: it closes when the retry succeeds, and if the retry
 *    fails again the merchant is still looking at a true statement.
 *
 * Nothing here writes to MetaKocka or Shopify itself. It reads state, decides,
 * and queues — so a re-check that runs every quarter of an hour costs a handful
 * of database queries.
 */

export const recheckExceptionsJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Bounded so one shop with a bad afternoon cannot monopolise the worker. */
  limit: z.number().int().positive().max(1000).default(200),
});

/** The verdict for one exception. */
type Verdict =
  | { kind: "fixed"; note: string }
  | { kind: "unblocked"; note: string; retry: Retry }
  | { kind: "open" };

/**
 * What to re-drive when the blocker is gone.
 *
 * The same vocabulary the exceptions page uses, and the same module does the
 * queuing (`redrive.server`), so a retry the app decides on and a retry a
 * person asks for are the identical operation.
 */
type Retry = RedriveTarget;

const FIXED: (note: string) => Verdict = (note) => ({ kind: "fixed", note });
const OPEN: Verdict = { kind: "open" };

/**
 * Everything about one order that any of the checks below might need.
 *
 * Gathered once per order rather than per exception, because an order that has
 * gone wrong has usually gone wrong in more than one way at a time.
 */
async function factsFor(principal: Principal, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, shop: { domain: principal.shopDomain } },
    select: {
      id: true,
      shopifyOrderId: true,
      status: true,
      financialStatus: true,
      paymentGateway: true,
      cancelledAt: true,
      divergedAt: true,
      syncState: true,
      grossReceivedMinor: true,
      refundedMinor: true,
      partnerOverride: true,
      rawPayload: true,
      lines: {
        select: {
          id: true,
          sku: true,
          quantity: true,
          taxFactor: true,
          allocations: {
            select: {
              supplySourceId: true,
              quantity: true,
              status: true,
              shopifyLocationId: true,
            },
          },
        },
      },
      documents: {
        select: {
          id: true,
          status: true,
          mkStatus: true,
          supplySourceId: true,
          paymentMarkedAt: true,
        },
      },
    },
  });
  if (!order) return null;

  const sourceIds = [
    ...new Set(
      order.lines.flatMap((line) =>
        line.allocations
          .map((allocation) => allocation.supplySourceId)
          .filter((id): id is string => id !== null),
      ),
    ),
  ];

  const sources = sourceIds.length
    ? await prisma.supplySource.findMany({
        where: { id: { in: sourceIds } },
        select: {
          id: true,
          name: true,
          code: true,
          metakockaWarehouse: true,
          metakockaProfitCenter: true,
        },
      })
    : [];

  return { order, sources };
}

type Facts = NonNullable<Awaited<ReturnType<typeof factsFor>>>;

/** Every line fully covered by a source that was actually chosen. */
function fullyAllocated(facts: Facts): boolean {
  if (facts.order.lines.length === 0) return false;

  return facts.order.lines.every((line) => {
    const covered = line.allocations
      .filter((allocation) => allocation.supplySourceId !== null)
      .reduce((sum, allocation) => sum + allocation.quantity, 0);
    return covered >= line.quantity;
  });
}

/** A document written for every source the allocation names. */
function fullyWritten(facts: Facts): boolean {
  const needed = new Set(
    facts.order.lines.flatMap((line) =>
      line.allocations
        .map((allocation) => allocation.supplySourceId)
        .filter((id): id is string => id !== null),
    ),
  );
  if (needed.size === 0) return false;

  const written = new Set(
    facts.order.documents
      .filter((document) => document.status === "written")
      .map((document) => document.supplySourceId),
  );

  return [...needed].every((id) => written.has(id));
}

async function verdictFor(
  principal: Principal,
  kind: ExceptionKind,
  facts: Facts,
): Promise<Verdict> {
  const { order } = facts;

  switch (kind) {
    /*
     * Stock. The commonest stale exception by far, because stock is the thing
     * in this system that changes most often and never announces that it did.
     */
    case "insufficient_stock": {
      if (fullyAllocated(facts)) {
        return FIXED("Every line is allocated to a supply source.");
      }

      // Is there stock now for what could not be filled? Compared against what
      // is free to sell, the same figure the allocator uses.
      const short = order.lines.filter((line) => {
        const covered = line.allocations
          .filter((allocation) => allocation.supplySourceId !== null)
          .reduce((sum, allocation) => sum + allocation.quantity, 0);
        return covered < line.quantity;
      });

      const levels = await prisma.supplyLevel.findMany({
        where: {
          sku: {
            sku: { in: short.map((line) => line.sku).filter(Boolean) },
            shop: { domain: principal.shopDomain },
          },
          supplySource: { enabled: true },
        },
        select: { quantity: true, reserved: true, sku: { select: { sku: true } } },
      });

      const free = new Map<string, number>();
      for (const level of levels) {
        free.set(
          level.sku.sku,
          (free.get(level.sku.sku) ?? 0) +
            Math.max(0, level.quantity - level.reserved),
        );
      }

      const nowAvailable = short.every((line) => {
        const covered = line.allocations
          .filter((allocation) => allocation.supplySourceId !== null)
          .reduce((sum, allocation) => sum + allocation.quantity, 0);
        return (free.get(line.sku) ?? 0) >= line.quantity - covered;
      });

      return nowAvailable
        ? {
            kind: "unblocked",
            note: "Stock is available again.",
            retry: "allocate",
          }
        : OPEN;
    }

    /*
     * A SKU MetaKocka did not have. Fixed either by creating the product there
     * or by correcting the SKU in Shopify, and the registry is what knows.
     */
    case "sku_not_in_metakocka": {
      if (fullyWritten(facts)) return FIXED("Every document is written.");

      const skus = order.lines.map((line) => line.sku).filter(Boolean);
      if (skus.length !== order.lines.length) return OPEN; // a line with no SKU

      const matched = await prisma.sku.count({
        where: {
          shop: { domain: principal.shopDomain },
          sku: { in: skus },
          status: "matched",
        },
      });

      return matched >= new Set(skus).size
        ? {
            kind: "unblocked",
            note: "Every SKU on this order now has a MetaKocka product.",
            retry: "write",
          }
        : OPEN;
    }

    /*
     * A warehouse mark MetaKocka does not have. §3: it accepts an unknown mark
     * silently, so this app checks against the cached list, and the reload job
     * is what makes the check true again.
     */
    case "warehouse_invalid": {
      if (fullyWritten(facts)) return FIXED("Every document is written.");

      const warehouses = await listCachedWarehouses(principal);
      const marks = new Set(warehouses.map((warehouse) => warehouse.mark));

      const stillWrong = facts.sources.some(
        (source) =>
          source.metakockaWarehouse !== null &&
          !marks.has(source.metakockaWarehouse),
      );

      return stillWrong
        ? OPEN
        : {
            kind: "unblocked",
            note: "Every warehouse mark on this order now exists in MetaKocka.",
            retry: "write",
          };
    }

    /*
     * A profit centre MetaKocka rejected. The nightly probe re-checks the
     * register (§7), so this only has to read the verdict it recorded.
     */
    case "profit_center_rejected": {
      if (fullyWritten(facts)) return FIXED("Every document is written.");

      const centres = facts.sources
        .map((source) => source.metakockaProfitCenter)
        .filter((value): value is string => value !== null);
      if (centres.length === 0) return OPEN;

      const rejected = await prisma.metakockaProfitCenter.count({
        where: {
          shop: { domain: principal.shopDomain },
          value: { in: centres },
          isValid: false,
        },
      });

      return rejected === 0
        ? {
            kind: "unblocked",
            note: "The profit centres on this order are no longer rejected.",
            retry: "write",
          }
        : OPEN;
    }

    /*
     * A gateway with no MetaKocka payment type. Fixed on the Payment types
     * page, either by mapping the gateway or by naming a fallback.
     */
    case "unmapped_payment_gateway": {
      const paid = facts.order.documents.filter(
        (document) => document.status === "written",
      );
      if (paid.length > 0 && paid.every((doc) => doc.paymentMarkedAt !== null)) {
        return FIXED("The payment is recorded in MetaKocka.");
      }
      if (order.financialStatus !== "paid") {
        return FIXED("Shopify no longer reports this order as paid.");
      }
      if (!order.paymentGateway) return OPEN;

      const mapped = await findPaymentType(principal, order.paymentGateway);
      const fallback = mapped ? null : await getFallbackPaymentType(principal);

      return mapped ?? fallback
        ? {
            kind: "unblocked",
            note: `"${order.paymentGateway}" now has a MetaKocka payment type.`,
            retry: paid.length > 0 ? "payment" : "write",
          }
        : OPEN;
    }

    /*
     * Tax. Every one of these was raised because the order's VAT decision had
     * a blocking issue under the configuration of the day — a rate with no
     * mapping, a zero nobody could explain, a registration missing. The
     * merchant fixes that on the Taxes & VAT page, and nothing announces it.
     *
     * The check is the decision itself, re-run under the current configuration
     * against the stored payload. It is pure and costs no call to anything;
     * if it comes out clean, reconciling is what writes the document.
     */
    case "tax_undeterminable":
    case "tax_mapping_missing":
    case "tax_treatment_unknown":
    case "tax_data_insufficient":
    case "tax_reconciliation_failed":
    case "vat_registration_configuration_error": {
      if (fullyWritten(facts)) return FIXED("Every document is written.");

      const parsed = parseOrderSafe(order.rawPayload);
      if (!parsed) return OPEN;

      const config = await getTaxConfig(principal);
      const decision = decideOrderTax(parsed.tax, config);
      return decision.ok
        ? {
            kind: "unblocked",
            note: "The order's VAT can be decided under the current tax configuration.",
            retry: "reconcile",
          }
        : OPEN;
    }

    /*
     * A rejection from MetaKocka, cause unknown to us. The honest check is
     * whether the document exists now — plus the one cause this app can see
     * being fixed: an order with no address that has since been given one.
     */
    case "metakocka_write_failed": {
      if (fullyWritten(facts)) return FIXED("Every document is written.");

      const failed = order.documents.some(
        (document) => document.status === "failed",
      );
      if (!failed) return OPEN;

      if (order.partnerOverride) {
        return {
          kind: "unblocked",
          note: "Partner details have been entered for this order.",
          retry: "write",
        };
      }

      /*
       * Shopify has a customer now where it had none.
       *
       * The commonest way this exception gets fixed, and the app could not see
       * it: the merchant adds the address in Shopify — exactly what the message
       * told them to do — and nothing in the pipeline was watching for it. The
       * order sync now stores the payload whether or not anything actionable
       * moved, so by the time this runs the address is here to be found.
       */
      if (order.rawPayload) {
        const parsed = parseOrderSafe(order.rawPayload);
        if (parsed?.partner ?? parsed?.receiver) {
          return {
            kind: "unblocked",
            note: "Shopify now has a customer and address for this order.",
            retry: "write",
          };
        }
      }

      return OPEN;
    }

    case "payment_write_failed": {
      const written = order.documents.filter(
        (document) => document.status === "written",
      );
      if (written.length > 0 && written.every((d) => d.paymentMarkedAt !== null)) {
        return FIXED("The payment is recorded in MetaKocka.");
      }
      if (order.financialStatus !== "paid") {
        return FIXED("Shopify no longer reports this order as paid.");
      }
      return OPEN;
    }

    /*
     * Payment states. Each of these describes what Shopify said at a moment,
     * and Shopify is free to say something else later.
     */
    case "partially_paid":
      return order.financialStatus === "partially_paid"
        ? OPEN
        : FIXED(`Shopify now reports this order as ${order.financialStatus}.`);

    case "voided_payment":
      return order.financialStatus === "voided"
        ? OPEN
        : FIXED(`Shopify now reports this order as ${order.financialStatus}.`);

    case "refund_received":
      /*
       * Deliberately only closed when the refund itself is gone.
       *
       * Issuing the credit note in MetaKocka is the merchant's work and this
       * app cannot see it happen, so closing on anything else would be closing
       * a job nobody did. An order that came back out of a refunded state is
       * different: there is no longer a refund to credit.
       */
      /*
       * Keyed on the ledger, not on `financial_status`.
       *
       * The display status moves for reasons that have nothing to do with the
       * refund — an edit, a further capture — and closing on it would tell the
       * merchant a credit note was no longer needed while the money was still
       * out. `refunded_minor` is the connector's own arithmetic over the
       * transactions, so it only reaches zero if the refund itself was reversed.
       */
      return order.refundedMinor > 0
        ? OPEN
        : FIXED("Shopify no longer reports a refund against this order.");

    case "order_cancelled":
      return order.cancelledAt
        ? OPEN
        : FIXED("The order is no longer cancelled in Shopify.");

    case "order_diverged":
    case "order_edited": {
      /*
       * Divergence has more than one shape, and `divergedAt` records only the
       * diff-visible one (Shopify moved and the document was not updated).
       * The others are marked on the documents themselves: a document for a
       * source the order no longer takes anything from, or an update
       * MetaKocka refused. Those are repaired by a person in the ERP, which
       * this app cannot see — so while any such marker stands, the exception
       * stands. Closing on `divergedAt` alone declared a stale, possibly paid
       * document "in step" fifteen minutes after a person was told to fix it.
       */
      const marked = order.documents.some(
        (document) =>
          document.mkStatus === "no longer allocated" ||
          document.mkStatus === "behind Shopify" ||
          document.mkStatus === "update refused",
      );
      return order.divergedAt || marked
        ? OPEN
        : FIXED("The order matches what MetaKocka holds again.");
    }

    /*
     * Deleted in MetaKocka. Closed only by the document existing again, which
     * means somebody sent it — this app never does so on its own.
     */
    case "metakocka_document_missing":
      return fullyWritten(facts)
        ? FIXED("The document has been written to MetaKocka again.")
        : OPEN;

    /*
     * Edited in MetaKocka. There is no state here that can disprove it: the
     * next poll compares the totals again and updates this exception in place
     * if they have moved further. Only a person can say it is dealt with.
     */
    case "metakocka_document_changed":
      return OPEN;

    /*
     * Nothing in this app can tell whether a fulfilment order became splittable
     * again, so it stays until a person says otherwise. Guessing would close a
     * real problem.
     */
    case "fulfillment_split_failed":
      return OPEN;

    /*
     * The quantities in MetaKocka do not add up to the order.
     *
     * Closed only by a reconciliation pass that verified them — `sync_state`
     * is written by that pass and by nothing else, so it cannot be closed by
     * inference. While it is still broken, the useful move is another
     * reconciliation: the repair is updating the documents that exist, never
     * adding one, and the loop is the only thing that does that.
     */
    case "sync_inconsistent":
      return order.syncState === "in_sync"
        ? FIXED("MetaKocka now holds exactly what Shopify says this order is.")
        : {
            kind: "unblocked",
            note: "Reconciling the order again to see whether the difference can be repaired.",
            retry: "reconcile",
          };

    /*
     * Money that could not be placed on any document.
     *
     * Two things fix it and both are somebody else's work: a gateway getting a
     * payment type, or the order getting a document that still describes it.
     * So this re-drives rather than closing — the reconciliation closes it when
     * the payment actually lands.
     */
    case "payment_unallocated":
      return order.grossReceivedMinor === 0
        ? FIXED("Shopify no longer reports any money received for this order.")
        : {
            kind: "unblocked",
            note: "Reconciling the order again to place the payment.",
            retry: "reconcile",
          };

    /*
     * Shopify is fulfilling from a location no supply source maps.
     *
     * The merchant maps it on the supply sources page, which this can see: the
     * allocation rows record the location even when nothing mapped it, so a
     * mapping that now exists is a real change of state.
     */
    case "unmapped_location": {
      const unmapped = [
        ...new Set(
          order.lines.flatMap((line) =>
            line.allocations
              .filter(
                (allocation) =>
                  allocation.supplySourceId === null &&
                  allocation.shopifyLocationId !== null,
              )
              .map((allocation) => allocation.shopifyLocationId!),
          ),
        ),
      ];

      if (unmapped.length === 0) {
        return FIXED("Every location on this order maps to a warehouse.");
      }

      /*
       * Compared in memory, on normalised ids.
       *
       * The stored supply-source value is a full GID and the allocation records
       * the numeric tail, so an `in` over raw strings never matched — the same
       * mismatch that stopped Shopify-driven allocation resolving at all, which
       * here would have meant this exception could never close.
       */
      const enabled = await prisma.supplySource.findMany({
        where: { shop: { domain: principal.shopDomain }, enabled: true },
        select: { shopifyLocationId: true },
      });

      const mapped = enabled.filter((source) =>
        unmapped.some((location) => sameLocation(source.shopifyLocationId, location)),
      ).length;

      return mapped > 0
        ? {
            kind: "unblocked",
            note: "The location is mapped to a MetaKocka warehouse now.",
            retry: "reconcile",
          }
        : OPEN;
    }

    default:
      return OPEN;
  }
}

export async function handleRecheckExceptions(job: Job<unknown>): Promise<void> {
  const { shopDomain, limit } = recheckExceptionsJobSchema.parse(job.data ?? {});
  const principal = serviceToken(shopDomain, "recheck-exceptions");
  const log = getLogger();

  const open = await prisma.exception.findMany({
    where: {
      shop: { domain: shopDomain },
      status: "open",
      orderId: { not: null },
    },
    select: { id: true, kind: true, orderId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  if (open.length === 0) return;

  // One order, one read, however many ways it has gone wrong.
  const cache = new Map<string, Facts | null>();
  const now = new Date();

  let closed = 0;
  let redriven = 0;

  for (const exception of open) {
    const orderId = exception.orderId;
    if (!orderId) continue;

    if (!cache.has(orderId)) {
      cache.set(orderId, await factsFor(principal, orderId));
    }
    const facts = cache.get(orderId);
    if (!facts) continue;

    let verdict: Verdict = OPEN;
    try {
      verdict = await verdictFor(principal, exception.kind, facts);
    } catch (error) {
      // One kind of check failing must not stop the sweep. The exception stays
      // open, which is the safe direction to be wrong in.
      log.error(
        { err: error, shop: shopDomain, kind: exception.kind, orderId },
        "Could not re-check one exception",
      );
      continue;
    }

    if (verdict.kind === "fixed") {
      await prisma.exception.updateMany({
        where: { id: exception.id, status: "open" },
        data: {
          status: "resolved",
          resolvedBy: "app",
          resolvedAt: now,
          lastCheckedAt: now,
        },
      });

      await appendEvent(principal, {
        entityType: "exception",
        entityId: exception.id,
        event: "exception.resolved_automatically",
        detail: { kind: exception.kind, orderId, why: verdict.note },
      });

      closed += 1;
      continue;
    }

    if (verdict.kind === "unblocked") {
      await redriveOrder(principal, facts.order.id, verdict.retry, {
        actor: "background",
      });

      await prisma.exception.update({
        where: { id: exception.id },
        data: {
          lastCheckedAt: now,
          lastAttemptAt: now,
          attempts: { increment: 1 },
        },
      });

      await appendEvent(principal, {
        entityType: "exception",
        entityId: exception.id,
        event: "exception.retried_automatically",
        detail: { kind: exception.kind, orderId, why: verdict.note },
      });

      redriven += 1;
      continue;
    }

    await prisma.exception.update({
      where: { id: exception.id },
      data: { lastCheckedAt: now },
    });
  }

  log.info(
    { shop: shopDomain, checked: open.length, closed, redriven },
    "Open exceptions re-checked",
  );
}

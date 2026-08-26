import { Prisma, type ExceptionKind } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The exceptions queue (CLAUDE.md §11).
 *
 * An exception is one of three distinct things and never the other two. It is
 * not a retryable failure — the queue handles those with backoff and no human
 * ever sees them — and it is not a form validation error. It is a business
 * condition that needs a person: a SKU MetaKocka does not have, a profit centre
 * it rejected, stock that ran out across every source, a gateway nobody mapped.
 *
 * Raising one is deliberately idempotent per (shop, kind, condition). A job
 * that retries three times must leave one row in the merchant's queue, not
 * three copies of the same problem.
 */

const UNIQUE_VIOLATION = "P2002";

export interface RaiseExceptionInput {
  orderId?: string | null;
  kind: ExceptionKind;
  /** Says what is wrong *and* how to fix it (§2.8). */
  message: string;
  detail?: unknown;
  /**
   * Identity of the condition, for a condition that is not about an order.
   * An order-scoped exception derives its own key from `orderId` and does not
   * need to pass this — a location's stock sync failing does, so twelve
   * consecutive failures update one row instead of inserting a new one every
   * five minutes.
   */
  dedupeKey?: string | null;
}

/**
 * The identity a row's uniqueness is checked against, or null when this
 * exception has none beyond (shop, kind) — in which case every raise inserts
 * a fresh row, same as before dedupe keys existed.
 *
 * Pulled out as a pure function because getting this convention right (and
 * kept consistent with what the migration backfilled onto existing rows,
 * `20260826030000_exception_dedupe`) matters more than raiseException's own
 * plumbing does.
 */
export function deriveDedupeKey(
  input: Pick<RaiseExceptionInput, "orderId" | "dedupeKey">,
): string | null {
  if (input.dedupeKey) return input.dedupeKey;
  if (input.orderId) return `order:${input.orderId}`;
  return null;
}

export async function raiseException(
  principal: Principal,
  input: RaiseExceptionInput,
): Promise<void> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) return;

  const dedupeKey = deriveDedupeKey(input);
  const data = {
    message: input.message,
    detail: (input.detail ?? null) as Prisma.InputJsonValue,
  };

  if (!dedupeKey) {
    // No identity to dedupe against — the pre-dedupe-key behaviour: raising
    // always creates a row.
    await prisma.exception.create({
      data: {
        shopId: shop.id,
        orderId: input.orderId ?? null,
        kind: input.kind,
        dedupeKey: null,
        ...data,
      },
    });
    return;
  }

  const open = await prisma.exception.findFirst({
    where: { shopId: shop.id, kind: input.kind, dedupeKey, status: "open" },
    select: { id: true },
  });

  if (open) {
    // Same condition, newer information. Update rather than pile up
    // duplicates.
    await prisma.exception.update({ where: { id: open.id }, data });
    return;
  }

  try {
    await prisma.exception.create({
      data: {
        shopId: shop.id,
        orderId: input.orderId ?? null,
        kind: input.kind,
        dedupeKey,
        ...data,
      },
    });
  } catch (error) {
    // Another caller raised the same condition between the findFirst above
    // and this create — the partial unique index caught it. Whichever row
    // won, it already says the same thing this call would have said, so
    // updating it with our newer detail is correct either way.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    ) {
      await prisma.exception.updateMany({
        where: { shopId: shop.id, kind: input.kind, dedupeKey, status: "open" },
        data,
      });
      return;
    }
    throw error;
  }
}

export async function listExceptions(
  principal: Principal,
  options: { status?: "open" | "resolved" | "ignored"; limit?: number } = {},
) {
  return prisma.exception.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      status: options.status ?? "open",
    },
    include: {
      order: {
        select: {
          id: true,
          shopifyOrderNumber: true,
          shopifyOrderId: true,
          receivedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 100,
  });
}

/**
 * True open-exception counts per kind, independent of how many rows the page
 * has actually loaded (§11: the screen pages in five at a time, but a group
 * heading that says "3" while eight are open is a lie the merchant has no way
 * to catch).
 */
export async function countOpenExceptionsByKind(
  principal: Principal,
): Promise<Map<ExceptionKind, number>> {
  const rows = await prisma.exception.groupBy({
    by: ["kind"],
    where: { shop: { domain: shopDomainOf(principal) }, status: "open" },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.kind, row._count._all]));
}

/**
 * Every open exception of one kind, most recent first.
 *
 * With no `limit`, this is deliberately unbounded — the bulk "retry all"/
 * "resolve all" actions call it this way, because "all" has to mean all
 * regardless of how many of that kind the display page has loaded. The
 * display page itself passes its own per-category `limit` so each category
 * pages independently of every other.
 */
export async function listOpenExceptionsByKind(
  principal: Principal,
  kind: ExceptionKind,
  options: { limit?: number } = {},
) {
  return prisma.exception.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      status: "open",
      kind,
    },
    include: {
      order: {
        select: {
          id: true,
          shopifyOrderNumber: true,
          shopifyOrderId: true,
          receivedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    ...(options.limit !== undefined ? { take: options.limit } : {}),
  });
}

export async function resolveException(
  principal: Principal,
  id: string,
  input: { status: "resolved" | "ignored"; by: string },
): Promise<void> {
  await prisma.exception.updateMany({
    where: { id, shop: { domain: shopDomainOf(principal) } },
    data: {
      status: input.status,
      resolvedBy: input.by,
      resolvedAt: new Date(),
    },
  });
}

/** Closes an exception the app itself has just fixed, e.g. a successful retry. */
/**
 * Whether an order still has an open exception of any of these kinds.
 *
 * The reconciliation verdict needs this for one specific question: a refund
 * that Shopify has processed and MetaKocka has not been credited for. This app
 * cannot see a credit note being issued in the ERP — there is no endpoint that
 * would tell it — so the open exception *is* the outstanding-action flag, and
 * the merchant resolving it is the signal that the books have been squared.
 */
export async function hasOpenException(
  principal: Principal,
  orderId: string,
  kinds: readonly ExceptionKind[],
): Promise<boolean> {
  if (kinds.length === 0) return false;

  const found = await prisma.exception.findFirst({
    where: {
      orderId,
      status: "open",
      kind: { in: [...kinds] },
      shop: { domain: shopDomainOf(principal) },
    },
    select: { id: true },
  });

  return found !== null;
}

export async function closeExceptionsFor(
  principal: Principal,
  orderId: string,
  kinds: ExceptionKind[],
): Promise<void> {
  await prisma.exception.updateMany({
    where: {
      orderId,
      kind: { in: kinds },
      status: "open",
      shop: { domain: shopDomainOf(principal) },
    },
    data: { status: "resolved", resolvedBy: "app", resolvedAt: new Date() },
  });
}

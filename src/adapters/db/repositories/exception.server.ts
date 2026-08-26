import type { ExceptionKind, Prisma } from "@prisma/client";

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
 * Raising one is deliberately idempotent per (order, kind). A job that retries
 * three times must leave one row in the merchant's queue, not three copies of
 * the same problem.
 */

export interface RaiseExceptionInput {
  orderId?: string | null;
  kind: ExceptionKind;
  /** Says what is wrong *and* how to fix it (§2.8). */
  message: string;
  detail?: unknown;
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

  const open = input.orderId
    ? await prisma.exception.findFirst({
        where: {
          shopId: shop.id,
          orderId: input.orderId,
          kind: input.kind,
          status: "open",
        },
        select: { id: true },
      })
    : null;

  if (open) {
    // Same problem, newer information. Update rather than pile up duplicates.
    await prisma.exception.update({
      where: { id: open.id },
      data: {
        message: input.message,
        detail: (input.detail ?? null) as Prisma.InputJsonValue,
      },
    });
    return;
  }

  await prisma.exception.create({
    data: {
      shopId: shop.id,
      orderId: input.orderId ?? null,
      kind: input.kind,
      message: input.message,
      detail: (input.detail ?? null) as Prisma.InputJsonValue,
    },
  });
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

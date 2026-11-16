import { Prisma, type ExceptionKind } from "@prisma/client";

import { getEnv } from "~/adapters/config/env.server";
import { prisma } from "~/adapters/db/client.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { isAlertKind } from "~/domain/alerts";
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

/**
 * Asks for the operator alert of a row that has just opened, when alerting is
 * configured and the kind is one worth it (`domain/alerts`).
 *
 * Only ever a queued job: the Slack call happens in `notify-exception`, never
 * in whatever raised the exception, which may be a request. A failure to queue
 * is logged and swallowed — the exception row is the thing that matters, and
 * it is already written.
 */
async function requestAlert(
  domain: string,
  exception: { id: string; kind: ExceptionKind },
): Promise<void> {
  if (!isAlertKind(exception.kind)) return;
  if (!getEnv().ALERT_SLACK_WEBHOOK_URL) return;
  try {
    await enqueue(QUEUES.notifyException, {
      shopDomain: domain,
      exceptionId: exception.id,
    });
  } catch (error) {
    getLogger().warn(
      { err: error, shop: domain, kind: exception.kind },
      "Could not queue the alert for a new exception",
    );
  }
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
    const created = await prisma.exception.create({
      data: {
        shopId: shop.id,
        orderId: input.orderId ?? null,
        kind: input.kind,
        dedupeKey: null,
        ...data,
      },
      select: { id: true, kind: true },
    });
    await requestAlert(domain, created);
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

  let created: { id: string; kind: ExceptionKind };
  try {
    created = await prisma.exception.create({
      data: {
        shopId: shop.id,
        orderId: input.orderId ?? null,
        kind: input.kind,
        dedupeKey,
        ...data,
      },
      select: { id: true, kind: true },
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
  // Only a row that has just opened: an update of an open one is the same
  // condition, and its alert (if any) has already been asked for.
  await requestAlert(domain, created);
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

/**
 * Closes the open exception for one condition by its dedupe key — what a
 * sale campaign does when a person has decided a price conflict.
 */
export async function resolveExceptionByKey(
  principal: Principal,
  kind: ExceptionKind,
  dedupeKey: string,
  by: string,
  now: Date,
): Promise<void> {
  await prisma.exception.updateMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      kind,
      dedupeKey,
      status: "open",
    },
    data: { status: "resolved", resolvedBy: by, resolvedAt: now },
  });
}

/* -------------------------------------------------------------------------- */
/* Operator alerts                                                            */
/* -------------------------------------------------------------------------- */

/** What an alert may say about an exception: never its message or detail. */
export interface AlertClaim {
  kind: ExceptionKind;
  orderId: string | null;
  orderNumber: string | null;
  /** The dead job's queue, for `job_failed`. */
  queue: string | null;
}

export type AlertClaimResult =
  | { claimed: true; alert: AlertClaim }
  | {
      claimed: false;
      why: "gone" | "closed" | "already_alerted" | "repeat" | "shop_limit";
    };

/**
 * Takes the right to announce one exception, at most once.
 *
 * The claim is `alerted_at` going from null to now in one conditional update,
 * so two deliveries of the same job send one message. Before claiming:
 *
 *  - a row that is no longer open is not announced — it fixed itself first;
 *  - a condition (same shop, kind and dedupe key) announced within
 *    `repeatWindowMs` is not announced again, so one that flaps open and
 *    closed is one message, not one per quarter-hour;
 *  - a shop that has had `perShopHourly` announcements in the last hour gets
 *    no more until it drops, so a first sweep that finds forty stale orders
 *    is not forty messages. The rest are on the Needs attention page.
 *
 * A skipped row is marked too, so it is never reconsidered.
 */
export async function claimExceptionAlert(
  principal: Principal,
  exceptionId: string,
  options: { now: Date; repeatWindowMs: number; perShopHourly: number },
): Promise<AlertClaimResult> {
  const domain = shopDomainOf(principal);
  const row = await prisma.exception.findFirst({
    where: { id: exceptionId, shop: { domain } },
    select: {
      id: true,
      shopId: true,
      kind: true,
      dedupeKey: true,
      status: true,
      alertedAt: true,
      detail: true,
      orderId: true,
      order: { select: { shopifyOrderNumber: true } },
    },
  });
  if (!row) return { claimed: false, why: "gone" };
  if (row.alertedAt) return { claimed: false, why: "already_alerted" };
  if (row.status !== "open") return { claimed: false, why: "closed" };

  const { now } = options;
  const markSkipped = () =>
    prisma.exception.updateMany({
      where: { id: row.id, alertedAt: null },
      data: { alertedAt: now },
    });

  if (row.dedupeKey) {
    const recent = await prisma.exception.findFirst({
      where: {
        shopId: row.shopId,
        kind: row.kind,
        dedupeKey: row.dedupeKey,
        id: { not: row.id },
        alertedAt: { gte: new Date(now.getTime() - options.repeatWindowMs) },
      },
      select: { id: true },
    });
    if (recent) {
      await markSkipped();
      return { claimed: false, why: "repeat" };
    }
  }

  const lastHour = await prisma.exception.count({
    where: {
      shopId: row.shopId,
      id: { not: row.id },
      alertedAt: { gte: new Date(now.getTime() - 60 * 60_000) },
    },
  });
  if (lastHour >= options.perShopHourly) {
    await markSkipped();
    return { claimed: false, why: "shop_limit" };
  }

  const { count } = await prisma.exception.updateMany({
    where: { id: row.id, alertedAt: null },
    data: { alertedAt: now },
  });
  if (count === 0) return { claimed: false, why: "already_alerted" };

  const detail = row.detail;
  const queue =
    detail !== null &&
    typeof detail === "object" &&
    !Array.isArray(detail) &&
    typeof detail.queue === "string"
      ? detail.queue
      : null;

  return {
    claimed: true,
    alert: {
      kind: row.kind,
      orderId: row.orderId,
      orderNumber: row.order?.shopifyOrderNumber ?? null,
      queue,
    },
  };
}

/** Gives a claim back after the message could not be sent, so a retry can. */
export async function releaseExceptionAlert(
  principal: Principal,
  exceptionId: string,
): Promise<void> {
  await prisma.exception.updateMany({
    where: { id: exceptionId, shop: { domain: shopDomainOf(principal) } },
    data: { alertedAt: null },
  });
}

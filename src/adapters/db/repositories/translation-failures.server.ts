import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Remembered translation failures (docs/translations.md § Failures).
 *
 * One row per resource and language: the source it failed on, how many
 * times in a row, and when automatic work may try again. Without it every
 * automatic pass — the nightly sync, and every products/update webhook,
 * which a stock change sends — paid the provider again for the same
 * failure.
 */

export interface StoredFailure {
  locale: string;
  sourceKey: string;
  attempts: number;
  lastError: string;
  failedAt: Date;
  retryAfter: Date | null;
}

/** Automatic retries after the 1st, 2nd and 3rd failure; after that, none. */
const BACKOFF_DAYS = [1, 3, 7] as const;

export function nextRetry(attempts: number, now: Date): Date | null {
  const days = BACKOFF_DAYS[attempts - 1];
  return days === undefined
    ? null
    : new Date(now.getTime() + days * 86_400_000);
}

/** Whether automatic work should leave this source alone for now. */
export function isBackingOff(
  failure: StoredFailure | undefined,
  sourceKey: string,
  now: Date,
): boolean {
  if (!failure || failure.sourceKey !== sourceKey) return false;
  return failure.retryAfter === null || failure.retryAfter > now;
}

export async function listFailures(
  principal: Principal,
  resourceId: string,
): Promise<Map<string, StoredFailure>> {
  const rows = await prisma.translationFailure.findMany({
    where: { shop: { domain: shopDomainOf(principal) }, resourceId },
  });
  return new Map(
    rows.map((row) => [
      row.locale,
      {
        locale: row.locale,
        sourceKey: row.sourceKey,
        attempts: row.attempts,
        lastError: row.lastError,
        failedAt: row.failedAt,
        retryAfter: row.retryAfter,
      },
    ]),
  );
}

/**
 * Records a failure. Another failure on the same source counts up and backs
 * off further; a failure on a changed source starts again at one.
 */
export async function recordFailure(
  principal: Principal,
  input: {
    resourceId: string;
    locale: string;
    sourceKey: string;
    error: string;
    previous: StoredFailure | undefined;
  },
  now: Date,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) return;
  const attempts =
    input.previous && input.previous.sourceKey === input.sourceKey
      ? input.previous.attempts + 1
      : 1;
  const data = {
    sourceKey: input.sourceKey,
    attempts,
    lastError: input.error.slice(0, 2000),
    failedAt: now,
    retryAfter: nextRetry(attempts, now),
  };
  await prisma.translationFailure.upsert({
    where: {
      shopId_resourceId_locale: {
        shopId: shop.id,
        resourceId: input.resourceId,
        locale: input.locale,
      },
    },
    create: {
      shopId: shop.id,
      resourceId: input.resourceId,
      locale: input.locale,
      ...data,
    },
    update: data,
  });
}

export async function clearFailure(
  principal: Principal,
  resourceId: string,
  locale: string,
): Promise<void> {
  await prisma.translationFailure.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) }, resourceId, locale },
  });
}

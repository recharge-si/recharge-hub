import { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";

/**
 * Exactly-once execution on top of an at-least-once delivery source.
 *
 * Shopify redelivers webhooks, pg-boss retries jobs, and MetaKocka has no
 * idempotency keys at all (CLAUDE.md section 3), so the guard is ours to build.
 * pg-boss `singletonKey` only collapses jobs that are still queued; once the
 * first one has run, a redelivery an hour later is a brand new job. This table is
 * what makes the second delivery a no-op.
 */
const UNIQUE_VIOLATION = "P2002";

/**
 * Records the key and returns true if this caller is the one that should do the
 * work. A second caller with the same key gets false.
 */
export async function claimKey(
  shopDomain: string,
  scope: string,
  key: string,
): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: { shopDomain, scope, key },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    ) {
      return false;
    }
    throw error;
  }
}

/** Stores the outcome next to the key, so a duplicate can be answered from it. */
export async function recordKeyResult(
  shopDomain: string,
  scope: string,
  key: string,
  result: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.idempotencyKey.updateMany({
    where: { shopDomain, scope, key },
    data: { result },
  });
}

/**
 * Gives the key back after a failure so the retry is allowed to run. Without
 * this, one transient error would permanently suppress the work.
 */
export async function releaseKey(
  shopDomain: string,
  scope: string,
  key: string,
): Promise<void> {
  await prisma.idempotencyKey.deleteMany({ where: { shopDomain, scope, key } });
}

export async function findKeyResult(
  shopDomain: string,
  scope: string,
  key: string,
) {
  return prisma.idempotencyKey.findUnique({
    where: { shopDomain_scope_key: { shopDomain, scope, key } },
  });
}

import type { Prisma, Shop } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { shopDomainOf, type Principal } from "~/domain/types";

type Tx = Prisma.TransactionClient;

/**
 * CLAUDE.md section 9: every query filters by shop, and the filter lives here so
 * route and job code cannot forget it. Nothing outside this directory touches
 * `prisma.shop` directly.
 */

export async function findShop(principal: Principal): Promise<Shop | null> {
  return prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
  });
}

/** Called on every authenticated request; the install is the first one to win. */
export async function ensureShop(
  principal: Principal,
  tx: Tx | typeof prisma = prisma,
): Promise<Shop> {
  const domain = shopDomainOf(principal);

  return tx.shop.upsert({
    where: { domain },
    create: { domain },
    update: {},
  });
}

/** Re-install after an uninstall reuses the row so the audit trail survives. */
export async function markInstalled(principal: Principal): Promise<Shop> {
  const domain = shopDomainOf(principal);

  return prisma.shop.upsert({
    where: { domain },
    create: { domain },
    update: { installState: "installed", uninstalledAt: null },
  });
}

export async function markUninstalled(principal: Principal): Promise<void> {
  const domain = shopDomainOf(principal);

  await prisma.shop.updateMany({
    where: { domain },
    data: { installState: "uninstalled", uninstalledAt: new Date() },
  });
}

/* -------------------------------------------------------------------------- */
/* Guided setup                                                               */
/* -------------------------------------------------------------------------- */

export interface SetupState {
  /** When the merchant pressed Finish setup. Null means they have not. */
  completedAt: Date | null;
  /** The step guided setup last reached. Pure UI state. */
  step: string | null;
}

export async function getSetupState(principal: Principal): Promise<SetupState> {
  const row = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { setupCompletedAt: true, setupStep: true },
  });

  return {
    completedAt: row?.setupCompletedAt ?? null,
    step: row?.setupStep ?? null,
  };
}

/** Remembers where the merchant got to, so closing the tab costs nothing. */
export async function saveSetupStep(
  principal: Principal,
  step: string,
): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shopDomainOf(principal) },
    data: { setupStep: step },
  });
}

/**
 * The activation boundary (the product UX brief, section 11).
 *
 * Idempotent by construction: the update only matches a shop whose
 * `setup_completed_at` is still null, so pressing Finish setup twice completes
 * once and the second press reports `false` rather than moving the timestamp or
 * enqueueing a second round of initial work.
 */
export async function markSetupComplete(
  principal: Principal,
  now: Date,
): Promise<boolean> {
  const { count } = await prisma.shop.updateMany({
    where: { domain: shopDomainOf(principal), setupCompletedAt: null },
    data: { setupCompletedAt: now, setupStep: null },
  });

  return count > 0;
}

/**
 * Whether this shop has activated synchronization.
 *
 * Read by the two places that write into the merchant's ERP, so that opening
 * guided setup and getting as far as saving credentials never starts filing
 * documents on its own. Existing shops were back-filled by
 * `20260826080000_setup_state`, so nothing that was synchronizing before this
 * existed stops.
 */
export async function isSyncActivated(principal: Principal): Promise<boolean> {
  const row = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { setupCompletedAt: true },
  });

  return row?.setupCompletedAt != null;
}

/**
 * `shop/redact` must actually delete, not soft-delete (CLAUDE.md section 2.4).
 *
 * The event log cascades from the shop row. Sessions and idempotency keys are
 * keyed by shop domain rather than by foreign key, so they are removed
 * explicitly -- a table that does not cascade is a table that quietly survives
 * a redaction.
 *
 * Returns the number of shop rows removed so the caller can log an honest result
 * for a shop that was already gone.
 */
export async function purgeShop(principal: Principal): Promise<number> {
  const domain = shopDomainOf(principal);

  const [, , shops] = await prisma.$transaction([
    prisma.session.deleteMany({ where: { shop: domain } }),
    prisma.idempotencyKey.deleteMany({ where: { shopDomain: domain } }),
    prisma.shop.deleteMany({ where: { domain } }),
  ]);

  getLogger().info(
    { shop: domain, deletedShopRows: shops.count },
    "Shop data purged",
  );

  return shops.count;
}

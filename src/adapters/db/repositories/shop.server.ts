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

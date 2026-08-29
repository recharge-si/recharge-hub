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

/**
 * Everything this app holds about a shop, removed, leaving the shop installed.
 *
 * This is what Disconnect means. Deleting only the credential row left every
 * answer derived from the old MetaKocka company behind — warehouse marks and
 * their stock directions, profit centres, payment-type maps, the SKU registry,
 * cached registers — and left `setup_completed_at` set, so nothing asked the
 * merchant anything again. Reconnecting a *different* company then filed
 * documents against warehouse marks that company has never heard of, and
 * MetaKocka accepts an unknown mark silently and files against the company
 * default (docs/metakocka-verification.md). A stale mapping is worse than no
 * mapping.
 *
 * **Nothing is sent to MetaKocka and nothing is deleted there.** Documents
 * this app has already filed are the merchant's accounting records and stay
 * exactly as they are; what goes is this app's copy of them.
 *
 * Implemented as a delete of the shop row rather than a list of tables. Every
 * shop-scoped model cascades from it, so this cannot silently miss a table
 * that is added later — the failure mode a hand-written list has. Two things
 * are keyed by domain instead of by foreign key and so are handled by name:
 * `IdempotencyKey`, which goes, and `Session`, which stays, because the
 * merchant is looking at the page and the app is still installed.
 *
 * The new row is a fresh install with no `setup_completed_at`, which is
 * exactly what makes guided setup run again from the first step and both
 * MetaKocka writers refuse until it is finished.
 */
export async function resetShop(principal: Principal): Promise<void> {
  const domain = shopDomainOf(principal);

  await prisma.$transaction([
    // Cascades every shop-scoped table: credentials, cached registers,
    // supply sources and their levels, the SKU registry, payment maps,
    // settings, orders, documents, exceptions and the event log.
    prisma.shop.deleteMany({ where: { domain } }),
    // Keyed by domain, so it does not cascade. These guard webhook replays
    // for orders that no longer exist here; keeping them would suppress the
    // re-delivery that would otherwise rebuild them.
    prisma.idempotencyKey.deleteMany({ where: { shopDomain: domain } }),
    prisma.shop.create({ data: { domain, installState: "installed" } }),
  ]);

  getLogger().info({ shop: domain }, "Shop data reset; MetaKocka untouched");
}

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

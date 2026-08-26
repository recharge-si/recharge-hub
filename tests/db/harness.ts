import { randomUUID } from "node:crypto";

import { describe } from "vitest";

import { prisma } from "~/adapters/db/client.server";
import { serviceToken, type Principal } from "~/domain/types";

/**
 * A real PostgreSQL tenant, created and destroyed by one test file.
 *
 * These tests exist because the guarantees they check cannot be demonstrated
 * any other way. `claimOrderReconciliation` and `claimDocument` are conditional
 * updates with leases: whether two workers racing for one order end up with one
 * winner is a question about PostgreSQL's row locking, not about the TypeScript
 * around it, and a mock of the database would be a mock of the very thing under
 * test.
 *
 * Safety, because this runs against the developer's own Compose database:
 *
 *  - every test file gets its **own shop**, with a random domain, so nothing it
 *    does is visible to any other tenant's rows;
 *  - every table in this schema is tenant-scoped through `shop_id` with
 *    `ON DELETE CASCADE`, so deleting that one shop removes everything the test
 *    created and nothing else;
 *  - the teardown deletes by shop id, never by a broad predicate.
 *
 * Skips itself when no database is reachable, which is what happens in a
 * checkout with no Compose stack up. `tests/setup.ts` decides.
 */

export const databaseAvailable = process.env.TEST_DATABASE_AVAILABLE === "1";

/**
 * `describe`, unless there is no database — in which case the whole block is
 * skipped rather than failing, and the reason is in the title so a skipped run
 * is not mistaken for a passing one.
 */
export const describeDatabase: typeof describe | typeof describe.skip =
  databaseAvailable
    ? describe
    : ((name: string, fn: () => void) =>
        describe.skip(`${name} [skipped: no DATABASE_URL, start Compose to run]`, fn)) as typeof describe;

export interface TestTenant {
  shopId: string;
  domain: string;
  principal: Principal;
  supplySourceId: string;
}

/** Creates an isolated shop with one supply source. */
export async function createTenant(label: string): Promise<TestTenant> {
  const domain = `dbtest-${label}-${randomUUID().slice(0, 8)}.myshopify.test`;

  const shop = await prisma.shop.create({
    data: { domain },
    select: { id: true },
  });

  const source = await prisma.supplySource.create({
    data: {
      shopId: shop.id,
      code: "GLAVNO",
      name: "Main warehouse",
      kind: "own",
      metakockaWarehouse: "glavno",
    },
    select: { id: true },
  });

  return {
    shopId: shop.id,
    domain,
    principal: serviceToken(domain, "db-test"),
    supplySourceId: source.id,
  };
}

/** One order with one line, ready to be reconciled. */
export async function createOrder(
  tenant: TestTenant,
  input: { number: string; quantity?: number } = { number: "1050" },
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      shopId: tenant.shopId,
      shopifyOrderId: `shopify-${randomUUID().slice(0, 8)}`,
      shopifyOrderNumber: input.number,
      customerOrderRef: `SH-${input.number}-${randomUUID().slice(0, 4)}`,
      presentmentCurrency: "EUR",
      totalMinor: 20_900,
      receivedAt: new Date(),
      lines: {
        create: {
          sku: "SKU-A",
          title: "A product",
          quantity: input.quantity ?? 2,
          unitPriceWithTaxMinor: 10_450,
          shopifyLineItemId: `line-${randomUUID().slice(0, 8)}`,
        },
      },
    },
    select: { id: true },
  });

  return order.id;
}

/** Removes the tenant and, by cascade, everything the test created. */
export async function destroyTenant(tenant: TestTenant): Promise<void> {
  await prisma.shop.deleteMany({ where: { id: tenant.shopId } });
}

export { prisma };

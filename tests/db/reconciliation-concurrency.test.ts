import { afterAll, beforeAll, expect, it } from "vitest";

import {
  claimDocument,
  claimOrderReconciliation,
  releaseOrderReconciliation,
} from "~/adapters/db/repositories/order.server";
import {
  createOrder,
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * Two workers, one Shopify order, one winner — against a real PostgreSQL.
 *
 * The brief is explicit that sequential idempotency tests do not answer this,
 * and it is right. Every other test in this suite proves that reconciling an
 * unchanged order *decides* to do nothing; none of them can prove that two
 * reconciliations running at the same instant do not both decide to create the
 * first document. That difference lives entirely in `UPDATE ... WHERE` and in
 * a unique index, so it is only demonstrable where those actually run.
 *
 * The failure being excluded, stated concretely:
 *
 * ```text
 * worker 1: reads "no document for source A"   \
 * worker 2: reads "no document for source A"   |  both true, at the same moment
 * worker 1: creates MK-100                     |
 * worker 2: creates MK-101                     /  one Shopify order, two ERP documents
 * ```
 *
 * MetaKocka would accept both — it does not treat `count_code` as unique — so
 * the database is the only thing standing between a merchant and a duplicated
 * accounting document.
 */

let tenant: TestTenant;

beforeAll(async () => {
  tenant = await createTenant("concurrency");
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant);
  await prisma.$disconnect();
});

/** The lease in `order.server.ts`. Kept here as a literal on purpose: if the */
/** production value changes, the expiry test below should be made to think.  */
const RECONCILE_LEASE_MS = 10 * 60 * 1000;

describeDatabase("the per-order reconciliation lock", () => {
  it("gives exactly one of two simultaneous workers the order", async () => {
    const orderId = await createOrder(tenant, { number: "2001" });
    const now = new Date();

    // Started together and awaited together: no interleaving is imposed by the
    // test, so the database decides who wins.
    const results = await Promise.all([
      claimOrderReconciliation(tenant.principal, orderId, now),
      claimOrderReconciliation(tenant.principal, orderId, now),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("gives exactly one of eight simultaneous workers the order", async () => {
    const orderId = await createOrder(tenant, { number: "2002" });
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimOrderReconciliation(tenant.principal, orderId, now),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((won) => !won)).toHaveLength(7);
  });

  it("keeps two different orders independent", async () => {
    // The lock is per order, not a global mutex: a busy shop must be able to
    // reconcile many orders at once.
    const [first, second] = await Promise.all([
      createOrder(tenant, { number: "2003" }),
      createOrder(tenant, { number: "2004" }),
    ]);
    const now = new Date();

    const results = await Promise.all([
      claimOrderReconciliation(tenant.principal, first, now),
      claimOrderReconciliation(tenant.principal, second, now),
    ]);

    expect(results).toEqual([true, true]);
  });

  it("refuses a second claim while the lease is still running", async () => {
    const orderId = await createOrder(tenant, { number: "2005" });
    const now = new Date();

    expect(await claimOrderReconciliation(tenant.principal, orderId, now)).toBe(
      true,
    );

    // One second short of the lease.
    const almost = new Date(now.getTime() + RECONCILE_LEASE_MS - 1_000);
    expect(
      await claimOrderReconciliation(tenant.principal, orderId, almost),
    ).toBe(false);
  });

  it("lets another worker take over once the lease has run out", async () => {
    /*
     * The other half of the guarantee, and the one that stops an order being
     * stuck for ever. A worker killed mid-pass leaves its claim behind; the
     * lease is what makes that recoverable, and it is matched to the queue's
     * own `expireInSeconds` so nobody is still working by then.
     */
    const orderId = await createOrder(tenant, { number: "2006" });
    const now = new Date();

    expect(await claimOrderReconciliation(tenant.principal, orderId, now)).toBe(
      true,
    );

    const afterLease = new Date(now.getTime() + RECONCILE_LEASE_MS + 1_000);
    expect(
      await claimOrderReconciliation(tenant.principal, orderId, afterLease),
    ).toBe(true);
  });

  it("still gives only one winner among workers racing an expired lease", async () => {
    // The takeover is itself a conditional update, so a stampede of workers
    // arriving after a crash must not all conclude the order is theirs.
    const orderId = await createOrder(tenant, { number: "2007" });
    const now = new Date();

    await claimOrderReconciliation(tenant.principal, orderId, now);

    const afterLease = new Date(now.getTime() + RECONCILE_LEASE_MS + 1_000);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        claimOrderReconciliation(tenant.principal, orderId, afterLease),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("frees the order as soon as the holder releases it", async () => {
    const orderId = await createOrder(tenant, { number: "2008" });
    const now = new Date();

    expect(await claimOrderReconciliation(tenant.principal, orderId, now)).toBe(
      true,
    );
    await releaseOrderReconciliation(orderId);

    expect(await claimOrderReconciliation(tenant.principal, orderId, now)).toBe(
      true,
    );
  });

  it("does not let one shop claim another shop's order", async () => {
    // §9: an id is not an authorisation. The claim is tenant-scoped like every
    // other query, so a guessed id matches nothing.
    const other = await createTenant("intruder");
    try {
      const orderId = await createOrder(tenant, { number: "2009" });
      expect(
        await claimOrderReconciliation(other.principal, orderId, new Date()),
      ).toBe(false);
    } finally {
      await destroyTenant(other);
    }
  });
});

describeDatabase("no duplicate MetaKocka document under concurrency", () => {
  it("creates one document row when eight workers claim one count_code", async () => {
    /*
     * The guard that actually stands between a merchant and two sales orders,
     * exercised the way it fails in production: everyone reads "nothing there"
     * at once and everyone tries to create.
     */
    const orderId = await createOrder(tenant, { number: "3001" });
    const countCode = "SH-3001-GLAVNO";

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimDocument(tenant.principal, {
          orderId,
          supplySourceId: tenant.supplySourceId,
          countCode,
          isPrimary: true,
        }),
      ),
    );

    const rows = await prisma.metakockaDocument.count({
      where: { orderId, countCode },
    });

    // One row is the whole point. MetaKocka would have accepted eight.
    expect(rows).toBe(1);

    // Exactly one caller may treat the claim as "mine to write". The rest
    // either lost the insert (null) or found the row already claimed, and
    // `alreadyWritten` with no mk_id sends them down the update path, which
    // returns immediately.
    const fresh = claims.filter(
      (claim) => claim !== null && !claim.alreadyWritten && !claim.reclaimed,
    );
    expect(fresh).toHaveLength(1);
  });

  it("is exclusive across the whole loop: lock, then claim, eight workers", async () => {
    /*
     * The composed proof the brief asks for. Each worker does what
     * `reconcileOrder` does — take the order lock, and only then touch
     * documents — and the assertion is the end state a merchant would see.
     */
    const orderId = await createOrder(tenant, { number: "3002" });
    const now = new Date();

    const worker = async (): Promise<"worked" | "skipped"> => {
      if (!(await claimOrderReconciliation(tenant.principal, orderId, now))) {
        return "skipped";
      }
      try {
        await claimDocument(tenant.principal, {
          orderId,
          supplySourceId: tenant.supplySourceId,
          countCode: "SH-3002-GLAVNO",
          isPrimary: true,
        });
        return "worked";
      } finally {
        await releaseOrderReconciliation(orderId);
      }
    };

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => worker()),
    );

    expect(outcomes.filter((outcome) => outcome === "worked")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(7);

    expect(
      await prisma.metakockaDocument.count({ where: { orderId } }),
    ).toBe(1);
  });

  it("keeps two supply sources of one order as two documents, not four", async () => {
    // A split order genuinely needs two documents. The guard is per count_code,
    // so concurrency must not collapse them into one or double them.
    const orderId = await createOrder(tenant, { number: "3003" });

    const second = await prisma.supplySource.create({
      data: {
        shopId: tenant.shopId,
        code: "PARTNER",
        name: "Partner",
        kind: "partner",
        metakockaWarehouse: "partner",
      },
      select: { id: true },
    });

    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        claimDocument(tenant.principal, {
          orderId,
          supplySourceId: tenant.supplySourceId,
          countCode: "SH-3003-GLAVNO",
          isPrimary: true,
        }),
      ),
      ...Array.from({ length: 4 }, () =>
        claimDocument(tenant.principal, {
          orderId,
          supplySourceId: second.id,
          countCode: "SH-3003-PARTNER",
          isPrimary: false,
        }),
      ),
    ]);

    expect(
      await prisma.metakockaDocument.count({ where: { orderId } }),
    ).toBe(2);
  });
});

describeDatabase("the payment ledger under concurrency", () => {
  it("records one row when eight workers see the same transaction", async () => {
    /*
     * The unique index on (shop_id, shopify_transaction_id) is what makes a
     * redelivered `orders/paid` free. Under a race it is also the only thing
     * stopping the same money being recorded twice.
     */
    const orderId = await createOrder(tenant, { number: "4001" });
    const transactionId = "shopify-txn-4001";

    const write = () =>
      prisma.orderPayment.upsert({
        where: {
          shopId_shopifyTransactionId: {
            shopId: tenant.shopId,
            shopifyTransactionId: transactionId,
          },
        },
        create: {
          shopId: tenant.shopId,
          orderId,
          shopifyTransactionId: transactionId,
          kind: "capture",
          status: "success",
          amountMinor: 20_900,
          currency: "EUR",
        },
        update: { amountMinor: 20_900 },
      });

    // An upsert race in PostgreSQL can surface as a unique violation rather
    // than silently retrying, which is correct and is what the job's own retry
    // handles. What must never happen is two rows.
    await Promise.all(
      Array.from({ length: 8 }, () => write().catch(() => null)),
    );

    expect(
      await prisma.orderPayment.count({
        where: { shopId: tenant.shopId, shopifyTransactionId: transactionId },
      }),
    ).toBe(1);

    const total = await prisma.orderPayment.aggregate({
      where: { orderId },
      _sum: { amountMinor: true },
    });
    // The money is recorded once, whatever the queue did.
    expect(total._sum.amountMinor).toBe(20_900);
  });
});

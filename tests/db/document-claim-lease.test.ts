import { afterAll, beforeAll, expect, it } from "vitest";

import {
  applyPrimaryDocument,
  claimDocument,
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
 * A crashed write must be retryable — against a real PostgreSQL.
 *
 * The failure this pins down was found by killing a write mid-flight against
 * the live ERP, and it is the kind only a database can demonstrate.
 *
 * `claimDocument` decides whether a `pending` row was abandoned by asking how
 * long ago it was claimed. That used to be `updated_at`, which Prisma refreshes
 * on **every** write — and the reconciler sweeps `is_primary` across an order's
 * documents immediately before the write loop. The lease was therefore renewed
 * a moment before it was tested, so the row could never be reclaimed: the
 * ambiguous-write recovery never ran, the document MetaKocka already held was
 * never adopted, and the order stayed inconsistent for good with nothing able
 * to repair it.
 *
 * The fix is a `claimed_at` that only claiming moves. These tests fail against
 * the old behaviour and pass against the new one.
 */

let tenant: TestTenant;

beforeAll(async () => {
  tenant = await createTenant("claim-lease");
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant);
  await prisma.$disconnect();
});

/** Matches CLAIM_LEASE_MS in the order repository. */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

async function backdateClaim(countCode: string, ms: number): Promise<void> {
  // Raw SQL on purpose: Prisma's `@updatedAt` rewrites the column, so a
  // backdated timestamp set through the client silently becomes "now" — which
  // is the very mechanism this test exists to pin down.
  await prisma.$executeRawUnsafe(
    `UPDATE "metakocka_document"
        SET claimed_at = NOW() - make_interval(secs => $2),
            updated_at = NOW() - make_interval(secs => $2)
      WHERE count_code = $1`,
    countCode,
    Math.round(ms / 1000),
  );
}

describeDatabase("the count_code claim lease", () => {
  it("refuses a second claim while the lease is running", async () => {
    const orderId = await createOrder(tenant, { number: "5001" });
    const countCode = "SH-5001-GLAVNO";

    const first = await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: true,
    });
    expect(first?.reclaimed).toBe(false);

    // Still pending and still fresh: nobody else may treat it as abandoned.
    const second = await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: true,
    });
    expect(second?.reclaimed ?? false).toBe(false);
    expect(second?.alreadyWritten).toBe(true);
  });

  it("lets an abandoned claim be retaken once the lease has run out", async () => {
    const orderId = await createOrder(tenant, { number: "5002" });
    const countCode = "SH-5002-GLAVNO";

    await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: true,
    });
    await backdateClaim(countCode, CLAIM_LEASE_MS + 60_000);

    const retry = await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: true,
    });

    // Reclaimed, and *not* as a definitive rejection — so the caller looks in
    // MetaKocka before sending anything (§3: a blind resend makes two).
    expect(retry?.reclaimed).toBe(true);
    expect(retry?.previousRejection).toBe(false);
  });

  it("is not renewed by an unrelated write to the same row", async () => {
    /*
     * The defect itself. `applyPrimaryDocument` is the write that used to do
     * it, and it runs on every reconciliation immediately before the claim is
     * tested — so a crashed write became permanently unrecoverable.
     */
    const orderId = await createOrder(tenant, { number: "5003" });
    const countCode = "SH-5003-GLAVNO";

    await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: false,
    });
    await backdateClaim(countCode, CLAIM_LEASE_MS + 60_000);

    // Exactly what the reconciler does before writing.
    await applyPrimaryDocument(orderId, tenant.supplySourceId);

    const retry = await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: true,
    });

    expect(retry?.reclaimed).toBe(true);
  });

  it("does not rewrite a primary flag that is already correct", async () => {
    // Fewer needless writes, and one less thing that can renew a lease.
    const orderId = await createOrder(tenant, { number: "5004" });
    const countCode = "SH-5004-GLAVNO";

    await claimDocument(tenant.principal, {
      orderId,
      supplySourceId: tenant.supplySourceId,
      countCode,
      isPrimary: true,
    });
    await applyPrimaryDocument(orderId, tenant.supplySourceId);

    const before = await prisma.metakockaDocument.findFirstOrThrow({
      where: { countCode },
      select: { updatedAt: true },
    });

    await applyPrimaryDocument(orderId, tenant.supplySourceId);

    const after = await prisma.metakockaDocument.findFirstOrThrow({
      where: { countCode },
      select: { updatedAt: true },
    });

    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

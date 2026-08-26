-- A claim lease that only claiming can renew.
--
-- `claimDocument` decides whether a `pending` row was abandoned by a crashed
-- worker by asking how long ago it was touched, and it asked `updated_at`.
-- Prisma refreshes `updated_at` on every write, and the reconciler writes
-- `is_primary` across an order's documents immediately before the write loop —
-- so the lease was renewed a moment before it was tested. A row left `pending`
-- by a crash could therefore never be reclaimed by anything: the ambiguous-write
-- recovery never ran, the document was never adopted, and the order stayed
-- permanently inconsistent.
--
-- Backfilled from `updated_at` so existing rows keep the lease they appear to
-- have rather than all becoming instantly reclaimable.

ALTER TABLE "metakocka_document" ADD COLUMN "claimed_at" TIMESTAMP(3);

UPDATE "metakocka_document" SET "claimed_at" = "updated_at";

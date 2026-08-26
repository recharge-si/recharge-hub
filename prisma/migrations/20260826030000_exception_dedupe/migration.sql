-- Exception dedupe key (see raiseException in exception.server.ts).
--
-- raiseException only deduplicated a row carrying an orderId, and even that
-- was a racy findFirst-then-update with no constraint behind it. An orderless
-- condition -- a location's stock sync failing -- always inserted a fresh
-- row, which is how one warehouse MetaKocka kept rejecting produced thirteen
-- open "stock sync failed" rows for the same location instead of one.
--
-- dedupe_key gives every exception an identity beyond (shop, kind):
-- "order:<id>" for what orderId already meant, "source:<id>" for a stock
-- condition. A partial unique index enforces at most one *open* row per
-- (shop_id, kind, dedupe_key); resolved/ignored history is left alone.

-- AlterTable
ALTER TABLE "exception" ADD COLUMN "dedupe_key" TEXT;

-- Backfill the key the app now derives, for existing rows of both shapes.
UPDATE "exception"
SET "dedupe_key" = 'order:' || "order_id"
WHERE "order_id" IS NOT NULL;

UPDATE "exception"
SET "dedupe_key" = 'source:' || ("detail" ->> 'sourceId')
WHERE "order_id" IS NULL
  AND "kind" = 'stock_sync_failed'
  AND ("detail" ->> 'sourceId') IS NOT NULL;

-- Consolidate duplicate open rows that would violate the unique index below.
-- This is the exact shape of the bug being fixed (plus the same race for the
-- order-scoped case, which the old findFirst-then-update never closed): keep
-- the oldest row per (shop, kind, dedupe_key), copy the newest message/detail
-- onto it so the merchant still sees the latest information, and drop the
-- rest. Nothing outside an exact duplicate open condition is touched.
WITH ranked AS (
  SELECT
    id,
    shop_id,
    kind,
    dedupe_key,
    message,
    detail,
    ROW_NUMBER() OVER (
      PARTITION BY shop_id, kind, dedupe_key
      ORDER BY created_at ASC, id ASC
    ) AS rn_oldest,
    ROW_NUMBER() OVER (
      PARTITION BY shop_id, kind, dedupe_key
      ORDER BY created_at DESC, id DESC
    ) AS rn_newest
  FROM "exception"
  WHERE status = 'open' AND dedupe_key IS NOT NULL
),
survivors AS (
  SELECT oldest.id AS survivor_id, newest.message, newest.detail
  FROM ranked oldest
  JOIN ranked newest
    ON newest.shop_id = oldest.shop_id
   AND newest.kind = oldest.kind
   AND newest.dedupe_key = oldest.dedupe_key
   AND newest.rn_newest = 1
  WHERE oldest.rn_oldest = 1
)
UPDATE "exception" e
SET message = s.message, detail = s.detail
FROM survivors s
WHERE e.id = s.survivor_id;

DELETE FROM "exception" e
USING (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY shop_id, kind, dedupe_key
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM "exception"
  WHERE status = 'open' AND dedupe_key IS NOT NULL
) dupes
WHERE e.id = dupes.id AND dupes.rn > 1;

-- One open row per (shop, kind, condition). Resolved/ignored rows, and any
-- row with no dedupe_key, are unconstrained.
CREATE UNIQUE INDEX "exception_shop_id_kind_dedupe_key_open_key"
  ON "exception" ("shop_id", "kind", "dedupe_key")
  WHERE "status" = 'open' AND "dedupe_key" IS NOT NULL;

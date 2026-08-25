-- Shop-level stock and profit centre defaults, plus the profit centre register
-- that replaces the free text field on the warehouse screen (CLAUDE.md section 7).
--
-- The back-fill at the bottom is the point of this migration. Every supply
-- source that exists today was configured one warehouse at a time, so its
-- current values are deliberate choices. They are preserved as explicit
-- overrides: both inheritance flags default to false, and nothing already saved
-- is recomputed from a default the merchant has never seen.

-- CreateTable
CREATE TABLE "metakocka_profit_center" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "validated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_profit_center_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_profit_center_shop_id_value_key" ON "metakocka_profit_center"("shop_id", "value");

-- AddForeignKey
ALTER TABLE "metakocka_profit_center" ADD CONSTRAINT "metakocka_profit_center_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "supply_setting" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "default_stock_direction" "stock_direction" NOT NULL DEFAULT 'mk_to_shopify',
    "default_profit_center" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supply_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supply_setting_shop_id_key" ON "supply_setting"("shop_id");

-- AddForeignKey
ALTER TABLE "supply_setting" ADD CONSTRAINT "supply_setting_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- Both default to false on purpose: see the note at the top of this file.
ALTER TABLE "supply_source" ADD COLUMN "stock_direction_inherited" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "supply_source" ADD COLUMN "profit_center_inherited" BOOLEAN NOT NULL DEFAULT false;

-- Seed one settings row per shop.
--
-- The defaults are read back out of what the shop already does, so the new
-- "Sync defaults" card opens showing the merchant's own answer rather than ours.
-- A shop whose sources all say "none" gets mk_to_shopify, which is the value
-- section 7 calls the normal case, and no existing source is touched by it.
INSERT INTO "supply_setting" (
    "id", "shop_id", "default_stock_direction", "default_profit_center",
    "created_at", "updated_at"
)
SELECT
    gen_random_uuid()::text,
    shop."id",
    COALESCE(
        (
            SELECT mode() WITHIN GROUP (ORDER BY source."stock_direction")
            FROM "supply_source" source
            WHERE source."shop_id" = shop."id"
              AND source."stock_direction" <> 'none'
        ),
        'mk_to_shopify'::"stock_direction"
    ),
    (
        SELECT mode() WITHIN GROUP (ORDER BY source."metakocka_profit_center")
        FROM "supply_source" source
        WHERE source."shop_id" = shop."id"
          AND source."metakocka_profit_center" IS NOT NULL
          AND btrim(source."metakocka_profit_center") <> ''
    ),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "shop" shop;

-- Seed the register from every profit centre already in use.
--
-- `validated_at` stays null and `is_valid` stays true: these have never been
-- checked against MetaKocka, and the screen must not offer to remove a value an
-- order depends on merely because nobody has pressed Refresh yet. The first
-- refresh replaces both.
INSERT INTO "metakocka_profit_center" (
    "id", "shop_id", "value", "is_valid", "validated_at", "created_at", "updated_at"
)
SELECT
    gen_random_uuid()::text,
    used."shop_id",
    used."value",
    true,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT
        source."shop_id" AS "shop_id",
        btrim(source."metakocka_profit_center") AS "value"
    FROM "supply_source" source
    WHERE source."metakocka_profit_center" IS NOT NULL
      AND btrim(source."metakocka_profit_center") <> ''
) used;

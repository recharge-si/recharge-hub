-- CreateEnum
CREATE TYPE "sku_status" AS ENUM ('matched', 'unmatched', 'ignored');

-- CreateTable
CREATE TABLE "sku" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "shopify_variant_id" TEXT,
    "shopify_inventory_item_id" TEXT,
    "title" TEXT,
    "metakocka_code" TEXT,
    "metakocka_mk_id" TEXT,
    "status" "sku_status" NOT NULL DEFAULT 'unmatched',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supply_level" (
    "id" TEXT NOT NULL,
    "supply_source_id" TEXT NOT NULL,
    "sku_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_pushed_quantity" INTEGER,
    "last_pushed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supply_level_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sku_shop_id_status_idx" ON "sku"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sku_shop_id_sku_key" ON "sku"("shop_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "supply_level_supply_source_id_sku_id_key" ON "supply_level"("supply_source_id", "sku_id");

-- AddForeignKey
ALTER TABLE "sku" ADD CONSTRAINT "sku_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_level" ADD CONSTRAINT "supply_level_supply_source_id_fkey" FOREIGN KEY ("supply_source_id") REFERENCES "supply_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_level" ADD CONSTRAINT "supply_level_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE CASCADE ON UPDATE CASCADE;


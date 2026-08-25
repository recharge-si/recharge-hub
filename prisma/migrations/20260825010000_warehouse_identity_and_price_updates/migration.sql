-- DropIndex
DROP INDEX "metakocka_warehouse_shop_id_mark_key";

-- AlterTable
ALTER TABLE "product_sync_setting" ADD COLUMN     "update_pricing" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "supply_source" ADD COLUMN     "metakocka_warehouse_mk_id" TEXT;

-- CreateIndex
CREATE INDEX "metakocka_warehouse_shop_id_mark_idx" ON "metakocka_warehouse"("shop_id", "mark");

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_warehouse_shop_id_mk_id_key" ON "metakocka_warehouse"("shop_id", "mk_id");


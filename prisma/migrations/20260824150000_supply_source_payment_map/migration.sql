-- CreateEnum
CREATE TYPE "supply_source_kind" AS ENUM ('own', 'partner');

-- CreateEnum
CREATE TYPE "inventory_writer" AS ENUM ('metakocka', 'external', 'manual');

-- CreateTable
CREATE TABLE "supply_source" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "supply_source_kind" NOT NULL DEFAULT 'own',
    "shopify_location_id" TEXT,
    "inventory_writer" "inventory_writer" NOT NULL DEFAULT 'external',
    "metakocka_warehouse" TEXT,
    "metakocka_profit_center" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "lead_time_days" INTEGER NOT NULL DEFAULT 0,
    "default_delivery_type" TEXT,
    "can_split" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supply_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_type_map" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_gateway" TEXT NOT NULL,
    "metakocka_payment_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_type_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supply_source_shop_id_priority_idx" ON "supply_source"("shop_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "supply_source_shop_id_code_key" ON "supply_source"("shop_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_type_map_shop_id_shopify_gateway_key" ON "payment_type_map"("shop_id", "shopify_gateway");

-- AddForeignKey
ALTER TABLE "supply_source" ADD CONSTRAINT "supply_source_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_type_map" ADD CONSTRAINT "payment_type_map_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "product_name_policy" AS ENUM ('always', 'when_empty', 'never');

-- CreateTable
CREATE TABLE "product_sync_setting" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name_template" TEXT NOT NULL DEFAULT '{title}[ {options}]',
    "name_policy" "product_name_policy" NOT NULL DEFAULT 'always',
    "create_missing" BOOLEAN NOT NULL DEFAULT false,
    "send_pricing" BOOLEAN NOT NULL DEFAULT false,
    "pricelist_code" TEXT,
    "tax_percent" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'kos',
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_sync_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_sync_setting_shop_id_key" ON "product_sync_setting"("shop_id");

-- AddForeignKey
ALTER TABLE "product_sync_setting" ADD CONSTRAINT "product_sync_setting_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

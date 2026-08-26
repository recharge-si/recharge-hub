-- Whether a sales order MetaKocka already holds is rewritten when the Shopify
-- order changes. Section 8.8 made this a human's problem; in practice that left
-- the ERP holding quantities nobody agreed to, so it becomes the merchant's
-- choice instead of the app's.

-- CreateTable
CREATE TABLE "sales_order_setting" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "update_on_change" BOOLEAN NOT NULL DEFAULT true,
    "update_after_paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_order_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_setting_shop_id_key" ON "sales_order_setting"("shop_id");

-- AddForeignKey
ALTER TABLE "sales_order_setting" ADD CONSTRAINT "sales_order_setting_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

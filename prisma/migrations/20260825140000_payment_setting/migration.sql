-- CreateTable
CREATE TABLE "payment_setting" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "fallback_payment_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_setting_shop_id_key" ON "payment_setting"("shop_id");

-- AddForeignKey
ALTER TABLE "payment_setting" ADD CONSTRAINT "payment_setting_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

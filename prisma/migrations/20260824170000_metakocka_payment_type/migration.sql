-- CreateTable
CREATE TABLE "metakocka_payment_type" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_payment_type_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_payment_type_shop_id_value_key" ON "metakocka_payment_type"("shop_id", "value");

-- AddForeignKey
ALTER TABLE "metakocka_payment_type" ADD CONSTRAINT "metakocka_payment_type_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "metakocka_pricelist" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT,
    "includes_tax" BOOLEAN,
    "observed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_pricelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metakocka_tax_rate" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "percent" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_pricelist_shop_id_code_key" ON "metakocka_pricelist"("shop_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_tax_rate_shop_id_percent_key" ON "metakocka_tax_rate"("shop_id", "percent");

-- AddForeignKey
ALTER TABLE "metakocka_pricelist" ADD CONSTRAINT "metakocka_pricelist_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metakocka_tax_rate" ADD CONSTRAINT "metakocka_tax_rate_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


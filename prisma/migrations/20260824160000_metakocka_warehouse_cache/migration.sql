-- CreateTable
CREATE TABLE "metakocka_warehouse" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "mk_id" TEXT NOT NULL,
    "mark" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "include_in_stock_info" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_warehouse_shop_id_mark_key" ON "metakocka_warehouse"("shop_id", "mark");

-- AddForeignKey
ALTER TABLE "metakocka_warehouse" ADD CONSTRAINT "metakocka_warehouse_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


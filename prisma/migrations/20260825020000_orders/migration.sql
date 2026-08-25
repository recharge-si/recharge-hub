-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('received', 'allocated', 'written', 'needs_attention', 'cancelled');

-- CreateEnum
CREATE TYPE "order_financial_status" AS ENUM ('pending', 'authorized', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided', 'unknown');

-- CreateEnum
CREATE TYPE "allocation_status" AS ENUM ('planned', 'written_to_shopify', 'written_to_metakocka', 'failed', 'manual');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('pending', 'written', 'failed');

-- CreateEnum
CREATE TYPE "exception_kind" AS ENUM ('sku_not_in_metakocka', 'insufficient_stock', 'profit_center_rejected', 'warehouse_invalid', 'unmapped_payment_gateway', 'partially_paid', 'voided_payment', 'refund_received', 'order_cancelled', 'order_edited', 'metakocka_write_failed', 'fulfillment_split_failed', 'tax_undeterminable');

-- CreateEnum
CREATE TYPE "exception_status" AS ENUM ('open', 'resolved', 'ignored');

-- CreateTable
CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "shopify_order_number" TEXT NOT NULL,
    "customer_order_ref" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'received',
    "financial_status" "order_financial_status" NOT NULL DEFAULT 'unknown',
    "presentment_currency" TEXT NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "shipping_minor" INTEGER NOT NULL DEFAULT 0,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "raw_payload" JSONB,
    "redacted_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "sku_id" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_with_tax_minor" INTEGER NOT NULL,
    "tax_factor" TEXT,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "shopify_line_item_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation" (
    "id" TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "supply_source_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" "allocation_status" NOT NULL DEFAULT 'planned',
    "reason" JSONB,
    "shopify_fulfillment_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metakocka_document" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "supply_source_id" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "doc_type" TEXT NOT NULL DEFAULT 'sales_order',
    "count_code" TEXT NOT NULL,
    "mk_id" TEXT,
    "status" "document_status" NOT NULL DEFAULT 'pending',
    "payment_marked_at" TIMESTAMP(3),
    "request_body" JSONB,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT,
    "kind" "exception_kind" NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "status" "exception_status" NOT NULL DEFAULT 'open',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exception_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_shop_id_status_idx" ON "order"("shop_id", "status");

-- CreateIndex
CREATE INDEX "order_shop_id_received_at_idx" ON "order"("shop_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_shop_id_shopify_order_id_key" ON "order"("shop_id", "shopify_order_id");

-- CreateIndex
CREATE INDEX "order_line_order_id_idx" ON "order_line"("order_id");

-- CreateIndex
CREATE INDEX "allocation_order_line_id_idx" ON "allocation"("order_line_id");

-- CreateIndex
CREATE INDEX "allocation_supply_source_id_idx" ON "allocation"("supply_source_id");

-- CreateIndex
CREATE INDEX "metakocka_document_order_id_idx" ON "metakocka_document"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_document_shop_id_count_code_key" ON "metakocka_document"("shop_id", "count_code");

-- CreateIndex
CREATE INDEX "exception_shop_id_status_idx" ON "exception"("shop_id", "status");

-- CreateIndex
CREATE INDEX "exception_order_id_idx" ON "exception"("order_id");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_supply_source_id_fkey" FOREIGN KEY ("supply_source_id") REFERENCES "supply_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metakocka_document" ADD CONSTRAINT "metakocka_document_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metakocka_document" ADD CONSTRAINT "metakocka_document_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metakocka_document" ADD CONSTRAINT "metakocka_document_supply_source_id_fkey" FOREIGN KEY ("supply_source_id") REFERENCES "supply_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception" ADD CONSTRAINT "exception_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception" ADD CONSTRAINT "exception_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


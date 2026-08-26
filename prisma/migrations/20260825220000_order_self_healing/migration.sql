-- Self-healing exceptions, in-app fixes, a product list worth reading, and
-- polling MetaKocka for what it does with a document after we write it.

-- AlterTable
ALTER TABLE "exception" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
                        ADD COLUMN     "last_attempt_at" TIMESTAMP(3),
                        ADD COLUMN     "last_checked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "partner_override" JSONB,
                    ADD COLUMN     "allocation_locked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sku" ADD COLUMN     "shopify_product_id" TEXT,
                  ADD COLUMN     "image_url" TEXT,
                  ADD COLUMN     "price_minor" INTEGER,
                  ADD COLUMN     "currency" TEXT,
                  ADD COLUMN     "vendor" TEXT,
                  ADD COLUMN     "product_type" TEXT;

-- AlterTable
ALTER TABLE "product_sync_setting" ADD COLUMN     "schedule_enabled" BOOLEAN NOT NULL DEFAULT false,
                                   ADD COLUMN     "schedule_interval_minutes" INTEGER NOT NULL DEFAULT 720;

-- AlterTable
ALTER TABLE "metakocka_document" ADD COLUMN     "mk_status" TEXT,
                                 ADD COLUMN     "mk_doc_number" TEXT,
                                 ADD COLUMN     "mk_checked_at" TIMESTAMP(3),
                                 ADD COLUMN     "tracking_numbers" JSONB;

-- AlterTable
ALTER TABLE "shop" ADD COLUMN     "documents_polled_through" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "exception_shop_id_kind_status_idx" ON "exception"("shop_id", "kind", "status");

-- Order state sync (CLAUDE.md sections 8.7, 8.8, 8.10).
--
-- An order was written once, at orders/create, and never looked at again. These
-- columns are what lets the app hear the rest of the order's life: paid later,
-- edited the next morning, cancelled on Friday.

-- AlterEnum
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'order_diverged';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'payment_write_failed';

-- AlterTable
ALTER TABLE "shop" ADD COLUMN     "orders_reconciled_through" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "shopify_updated_at" TIMESTAMP(3),
                    ADD COLUMN     "last_synced_at" TIMESTAMP(3),
                    ADD COLUMN     "fulfillment_state" TEXT,
                    ADD COLUMN     "payment_gateway" TEXT,
                    ADD COLUMN     "cancelled_at" TIMESTAMP(3),
                    ADD COLUMN     "diverged_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "metakocka_document" ADD COLUMN     "payment_type" TEXT,
                                 ADD COLUMN     "payment_amount_minor" INTEGER,
                                 ADD COLUMN     "payment_claimed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "order_shop_id_financial_status_idx" ON "order"("shop_id", "financial_status");

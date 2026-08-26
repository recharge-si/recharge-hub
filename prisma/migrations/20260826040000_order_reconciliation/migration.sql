-- Order reconciliation and the payment ledger.
--
-- Three things this migration adds, and one it deliberately does not.
--
-- 1. **A payment ledger.** `order_payment` is one row per Shopify transaction
--    with UNIQUE (shop_id, shopify_transaction_id), which is what makes payment
--    synchronisation idempotent: a redelivered `orders/paid`, a reconciler pass
--    over a paid order and a retried job all resolve to the same rows.
--    `order_payment_application` records how much of each transaction each
--    MetaKocka document was told about, so a 300 payment on a 100/200 split
--    order can never become 600 in the merchant's books.
--
-- 2. **A reconciliation loop.** `order.reconcile_claimed_at` is the per-order
--    single-flight guard; `order.sync_state` and `order.sync_detail` record
--    whether MetaKocka actually agrees with Shopify and, when it does not, the
--    per-SKU difference. `metakocka_document.retired_at` marks a document this
--    order stopped taking anything from -- excluded from payment allocation,
--    still counted in the quantity invariant, never deleted for being retired.
--
-- 3. **Shopify-driven warehouse allocation.** `allocation.source` and
--    `allocation.shopify_location_id` record that a line's warehouse came from
--    Shopify's own fulfilment-order assignment rather than from this app's
--    stock rules, which is what makes a merchant moving a line between
--    locations reach the ERP at all.
--
-- What it does not do is touch a single existing row beyond adding columns with
-- defaults. No historical order is re-synchronised, no MetaKocka document is
-- created, changed or deleted, and no job is enqueued. Deploying this feature
-- must not suddenly write ERP documents for a shop's entire order history; the
-- existing order-import boundary (`shop.orders_reconciled_through`) stays the
-- only thing that decides which orders this app acts on.
--
-- Additive only, per AGENTS.md. The pre-existing exception_shop_id_kind_status_idx
-- is left in place: it is drift from 20260825220000 that predates this work and
-- dropping it here would be an unrelated change.

-- CreateEnum
CREATE TYPE "order_sync_state" AS ENUM ('pending', 'in_sync', 'inconsistent', 'blocked');

-- CreateEnum
CREATE TYPE "order_payment_state" AS ENUM ('unpaid', 'authorized', 'partially_paid', 'paid', 'overpaid', 'partially_refunded', 'refunded');

-- CreateEnum
CREATE TYPE "allocation_source" AS ENUM ('rules', 'shopify', 'manual');

-- CreateEnum
CREATE TYPE "allocation_mode" AS ENUM ('shopify_locations', 'stock_rules');

-- CreateEnum
CREATE TYPE "obsolete_document_policy" AS ENUM ('report', 'empty', 'delete_unpaid');

-- CreateEnum
CREATE TYPE "payment_allocation_strategy" AS ENUM ('proportional', 'primary');

-- CreateEnum
CREATE TYPE "payment_entry_mode" AS ENUM ('per_transaction', 'aggregate');

-- CreateEnum
CREATE TYPE "order_payment_kind" AS ENUM ('authorization', 'capture', 'sale', 'void', 'refund', 'change', 'other');

-- CreateEnum
CREATE TYPE "order_payment_status" AS ENUM ('success', 'pending', 'failure', 'error', 'awaiting_response', 'unknown');

-- AlterEnum
-- Three new exception kinds. Safe in one migration on PostgreSQL 12 and above,
-- which is what this app runs (16 in Compose): the values are added here and
-- first *used* by application code in a later transaction.

ALTER TYPE "exception_kind" ADD VALUE 'sync_inconsistent';
ALTER TYPE "exception_kind" ADD VALUE 'payment_unallocated';
ALTER TYPE "exception_kind" ADD VALUE 'unmapped_location';

-- AlterTable
ALTER TABLE "allocation" ADD COLUMN     "shopify_location_id" TEXT,
ADD COLUMN     "source" "allocation_source" NOT NULL DEFAULT 'rules';

-- AlterTable
ALTER TABLE "metakocka_document" ADD COLUMN     "last_reconciled_at" TIMESTAMP(3),
ADD COLUMN     "retired_at" TIMESTAMP(3),
ADD COLUMN     "retired_reason" TEXT;

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "gross_received_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "net_paid_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outstanding_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payment_state" "order_payment_state",
ADD COLUMN     "payments_read_at" TIMESTAMP(3),
ADD COLUMN     "reconcile_claimed_at" TIMESTAMP(3),
ADD COLUMN     "reconciled_at" TIMESTAMP(3),
ADD COLUMN     "refunded_minor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sync_detail" JSONB,
ADD COLUMN     "sync_state" "order_sync_state" NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "sales_order_setting" ADD COLUMN     "allocation_mode" "allocation_mode" NOT NULL DEFAULT 'shopify_locations',
ADD COLUMN     "customer_order_template" TEXT,
ADD COLUMN     "obsolete_document_policy" "obsolete_document_policy" NOT NULL DEFAULT 'empty',
ADD COLUMN     "payment_allocation" "payment_allocation_strategy" NOT NULL DEFAULT 'proportional',
ADD COLUMN     "payment_entry_mode" "payment_entry_mode" NOT NULL DEFAULT 'per_transaction',
ADD COLUMN     "sync_payments" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "order_payment" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shopify_transaction_id" TEXT NOT NULL,
    "kind" "order_payment_kind" NOT NULL,
    "status" "order_payment_status" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "gateway" TEXT,
    "processed_at" TIMESTAMP(3),
    "parent_transaction_id" TEXT,
    "metakocka_payment_type" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_payment_application" (
    "id" TEXT NOT NULL,
    "order_payment_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "payment_type" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_payment_application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_payment_order_id_idx" ON "order_payment"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_payment_shop_id_shopify_transaction_id_key" ON "order_payment"("shop_id", "shopify_transaction_id");

-- CreateIndex
CREATE INDEX "order_payment_application_document_id_idx" ON "order_payment_application"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_payment_application_order_payment_id_document_id_key" ON "order_payment_application"("order_payment_id", "document_id");

-- CreateIndex
CREATE INDEX "order_shop_id_sync_state_idx" ON "order"("shop_id", "sync_state");

-- AddForeignKey
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payment_application" ADD CONSTRAINT "order_payment_application_order_payment_id_fkey" FOREIGN KEY ("order_payment_id") REFERENCES "order_payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payment_application" ADD CONSTRAINT "order_payment_application_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "metakocka_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


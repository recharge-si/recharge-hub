-- Sale campaigns (docs/sale-campaigns.md).
--
-- A campaign changes what a variant sells for by writing Shopify's own
-- `price` and `compareAtPrice`, and keeps a snapshot of both so it can put
-- them back. Nothing here is a Shopify discount.
--
--   * `sale_campaign` is the campaign as the merchant edits it.
--   * `sale_campaign_variant` is the snapshot: one row per variant a campaign
--     has touched, with what Shopify held before, what was written, and where
--     the row is. Rows are never deleted while the campaign exists.
--   * `sale_run` is one batch job over those rows; the progress bar reads it.
--   * `catalog_product`, `catalog_variant` and `catalog_price_list` are the
--     catalogue snapshot the targeting rules are evaluated against, read by a
--     Shopify bulk operation, so a preview is a query and metafield rules —
--     which Shopify's search cannot express — are evaluated here.
--
-- Additive: nothing existing is changed or backfilled.

-- CreateEnum
CREATE TYPE "sale_campaign_status" AS ENUM ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "sale_discount_type" AS ENUM ('percentage', 'fixed_amount', 'fixed_price');

-- CreateEnum
CREATE TYPE "sale_rounding" AS ENUM ('none', 'nearest_whole', 'ending_99', 'ending_9', 'ending_99_99', 'increment');

-- CreateEnum
CREATE TYPE "sale_existing_sale_policy" AS ENUM ('skip', 'discount_selling_price', 'discount_compare_at', 'override');

-- CreateEnum
CREATE TYPE "sale_conflict_strategy" AS ENUM ('prevent', 'priority', 'largest_discount', 'newest');

-- CreateEnum
CREATE TYPE "sale_base_price_change_policy" AS ENUM ('preserve', 'recalculate', 'review');

-- CreateEnum
CREATE TYPE "sale_variant_state" AS ENUM ('pending', 'applying', 'applied', 'failed', 'skipped', 'review', 'restoring', 'restored', 'restore_failed', 'released');

-- CreateEnum
CREATE TYPE "sale_run_kind" AS ENUM ('apply', 'restore', 'retry', 'release');

-- CreateEnum
CREATE TYPE "sale_run_status" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- AlterEnum
-- The sale exceptions. They use the existing exception system (queue,
-- resolve, ignore) rather than a sale error system of their own.
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'sale_price_conflict';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'sale_apply_failed';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'sale_restore_failed';

-- AlterTable
ALTER TABLE "shop" ADD COLUMN     "catalogue_bulk_operation_id" TEXT,
ADD COLUMN     "catalogue_bulk_started_at" TIMESTAMP(3),
ADD COLUMN     "catalogue_snapshot_at" TIMESTAMP(3),
ADD COLUMN     "currency_code" TEXT,
ADD COLUMN     "iana_timezone" TEXT;

-- CreateTable
CREATE TABLE "sale_campaign" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "status" "sale_campaign_status" NOT NULL DEFAULT 'draft',
    "discount_type" "sale_discount_type" NOT NULL,
    "discount_value" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "rounding" "sale_rounding" NOT NULL DEFAULT 'none',
    "rounding_increment_minor" INTEGER,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "existing_sale_policy" "sale_existing_sale_policy" NOT NULL DEFAULT 'skip',
    "conflict_strategy" "sale_conflict_strategy" NOT NULL DEFAULT 'prevent',
    "base_price_change_policy" "sale_base_price_change_policy" NOT NULL DEFAULT 'review',
    "dynamic_membership" BOOLEAN NOT NULL DEFAULT false,
    "include_rules" JSONB NOT NULL,
    "exclude_rules" JSONB NOT NULL,
    "created_by" TEXT,
    "activated_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "evaluated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_campaign_variant" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT,
    "original_price_minor" INTEGER,
    "original_compare_at_minor" INTEGER,
    "base_price_minor" INTEGER,
    "sale_price_minor" INTEGER,
    "sale_compare_at_minor" INTEGER,
    "currency" TEXT NOT NULL,
    "state" "sale_variant_state" NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "review_reason" TEXT,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_observed_price_minor" INTEGER,
    "last_observed_compare_at_minor" INTEGER,
    "last_observed_at" TIMESTAMP(3),
    "snapshot_created_at" TIMESTAMP(3),
    "last_applied_at" TIMESTAMP(3),
    "restored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_campaign_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_run" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "kind" "sale_run_kind" NOT NULL,
    "status" "sale_run_status" NOT NULL DEFAULT 'queued',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "requested_by" TEXT,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_product" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "vendor" TEXT,
    "product_type" TEXT,
    "status" TEXT,
    "tags" TEXT[],
    "collection_ids" TEXT[],
    "category_id" TEXT,
    "category_name" TEXT,
    "metafields" JSONB,
    "image_url" TEXT,
    "shopify_updated_at" TIMESTAMP(3),
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_variant" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "shopify_variant_id" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "title" TEXT,
    "price_minor" INTEGER NOT NULL,
    "compare_at_minor" INTEGER,
    "currency" TEXT NOT NULL,
    "metafields" JSONB,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_price_list" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_price_list_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "fixed_prices_count" INTEGER NOT NULL,
    "adjustment_type" TEXT,
    "adjustment_value" TEXT,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_price_list_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_campaign_shop_id_status_idx" ON "sale_campaign"("shop_id", "status");

-- CreateIndex
CREATE INDEX "sale_campaign_shop_id_status_starts_at_idx" ON "sale_campaign"("shop_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "sale_campaign_shop_id_status_ends_at_idx" ON "sale_campaign"("shop_id", "status", "ends_at");

-- CreateIndex
CREATE INDEX "sale_campaign_variant_campaign_id_state_idx" ON "sale_campaign_variant"("campaign_id", "state");

-- CreateIndex
CREATE INDEX "sale_campaign_variant_shop_id_product_id_idx" ON "sale_campaign_variant"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "sale_campaign_variant_shop_id_variant_id_idx" ON "sale_campaign_variant"("shop_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_campaign_variant_campaign_id_variant_id_key" ON "sale_campaign_variant"("campaign_id", "variant_id");

-- CreateIndex
CREATE INDEX "sale_run_campaign_id_created_at_idx" ON "sale_run"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_product_shop_id_shopify_product_id_key" ON "catalog_product"("shop_id", "shopify_product_id");

-- CreateIndex
CREATE INDEX "catalog_variant_shop_id_sku_idx" ON "catalog_variant"("shop_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_variant_shop_id_shopify_variant_id_key" ON "catalog_variant"("shop_id", "shopify_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_price_list_shop_id_shopify_price_list_id_key" ON "catalog_price_list"("shop_id", "shopify_price_list_id");

-- AddForeignKey
ALTER TABLE "sale_campaign" ADD CONSTRAINT "sale_campaign_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_campaign_variant" ADD CONSTRAINT "sale_campaign_variant_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_campaign_variant" ADD CONSTRAINT "sale_campaign_variant_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sale_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_run" ADD CONSTRAINT "sale_run_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_run" ADD CONSTRAINT "sale_run_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sale_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_product" ADD CONSTRAINT "catalog_product_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_variant" ADD CONSTRAINT "catalog_variant_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_variant" ADD CONSTRAINT "catalog_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "catalog_product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_price_list" ADD CONSTRAINT "catalog_price_list_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live owner per (shop, variant).
--
-- Two campaigns must never both hold a variant's sale state, whatever the
-- jobs do: the second snapshot would be taken from an already discounted
-- price and the second restore would put a sale price back as the original.
-- Prisma's schema language cannot express a partial unique index, so it is
-- created here by hand. The states listed are exactly the ones in which the
-- campaign is responsible for what Shopify currently shows.
CREATE UNIQUE INDEX "sale_campaign_variant_live_owner_key"
    ON "sale_campaign_variant"("shop_id", "variant_id")
    WHERE "state" IN ('applying', 'applied', 'review', 'restoring', 'restore_failed');

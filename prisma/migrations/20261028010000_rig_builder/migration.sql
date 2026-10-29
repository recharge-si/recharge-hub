-- AlterTable
ALTER TABLE "shop" ADD COLUMN     "rig_builder_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "catalog_product" ADD COLUMN     "description" TEXT,
ADD COLUMN     "online_store_url" TEXT;

-- AlterTable
ALTER TABLE "catalog_variant" ADD COLUMN     "available_for_sale" BOOLEAN,
ADD COLUMN     "inventory_quantity" INTEGER,
ADD COLUMN     "options" JSONB;

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN     "latency_ms" INTEGER,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'openai';

-- CreateTable
CREATE TABLE "rig_request" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "explained_at" TIMESTAMP(3),
    "profile" JSONB NOT NULL,
    "rig_variant_ids" BIGINT[],
    "mode" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "ai_cost_micro_eur" INTEGER,

    CONSTRAINT "rig_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rig_request_shop_id_created_at_idx" ON "rig_request"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "rig_request_created_at_idx" ON "rig_request"("created_at");

-- CreateIndex
CREATE INDEX "ai_usage_shop_id_provider_created_at_idx" ON "ai_usage"("shop_id", "provider", "created_at");

-- AddForeignKey
ALTER TABLE "rig_request" ADD CONSTRAINT "rig_request_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


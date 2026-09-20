-- Translation intelligence (docs/translations.md § Translation intelligence).
--
-- The translation engine learns what kind of store it is translating and
-- how the store says things: a model-written store profile (one row per
-- shop, rebuilt when the store's vocabulary drifts), the terms the store's
-- own data supports with a classification and a confidence, and a memory
-- of how short strings were translated into each locale so the same term
-- is never translated two ways. A per-item trace records which prompt,
-- profile, terms and memory produced a translation; detection records how
-- sure it could be from the text it had.
--
-- Additive: new tables, new nullable columns, two new enums.

-- CreateEnum
CREATE TYPE "translation_term_origin" AS ENUM ('auto_inferred', 'translation_history', 'merchant', 'system');

-- CreateEnum
CREATE TYPE "translation_memory_origin" AS ENUM ('ai', 'manual');

-- AlterTable
ALTER TABLE "translation_source_override" ADD COLUMN     "detected_confidence" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "translation_sync_item" ADD COLUMN     "trace" JSONB;

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN     "prompt_version" TEXT;

-- CreateTable
CREATE TABLE "translation_store_profile" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "profile" JSONB,
    "summary" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "prompt_version" TEXT,
    "model" TEXT,
    "vocabulary" TEXT[],
    "sample_stats" JSONB,
    "use_store_context" BOOLEAN NOT NULL DEFAULT true,
    "learn_terminology" BOOLEAN NOT NULL DEFAULT true,
    "generated_at" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3),
    "generating_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_store_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_term" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "source_locale" TEXT NOT NULL,
    "normalised" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "origin" "translation_term_origin" NOT NULL DEFAULT 'auto_inferred',
    "evidence" JSONB,
    "occurrences" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_memory" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "source_locale" TEXT NOT NULL,
    "target_locale" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "source_text" TEXT NOT NULL,
    "target_text" TEXT NOT NULL,
    "origin" "translation_memory_origin" NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 1,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "resource_type" TEXT,
    "last_resource_id" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_store_profile_shop_id_key" ON "translation_store_profile"("shop_id");

-- CreateIndex
CREATE INDEX "translation_term_shop_id_source_locale_confidence_idx" ON "translation_term"("shop_id", "source_locale", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "translation_term_shop_id_source_locale_normalised_key" ON "translation_term"("shop_id", "source_locale", "normalised");

-- CreateIndex
CREATE INDEX "translation_memory_shop_id_target_locale_last_seen_at_idx" ON "translation_memory"("shop_id", "target_locale", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "translation_memory_shop_id_source_locale_target_locale_sour_key" ON "translation_memory"("shop_id", "source_locale", "target_locale", "source_key");

-- AddForeignKey
ALTER TABLE "translation_store_profile" ADD CONSTRAINT "translation_store_profile_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_term" ADD CONSTRAINT "translation_term_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_memory" ADD CONSTRAINT "translation_memory_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


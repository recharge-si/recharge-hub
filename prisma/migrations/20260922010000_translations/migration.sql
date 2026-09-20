-- Translations (docs/translations.md).
--
-- Shopify keeps the locales, their publication state, the original and
-- translated content and the outdated flag; none of that is copied here. These
-- tables hold the translation engine's settings per language, the glossary,
-- per-resource source-language overrides, what this app itself wrote (so a
-- person's correction is never overwritten), the syncs it ran and their items,
-- a derived coverage cache, and AI usage with an estimated cost per request.
--
-- Additive: one enum value on exception_kind and new tables only. The
-- pre-existing exception_shop_id_kind_status_idx index is deliberately left in
-- place, as 20260826040000_order_reconciliation explains.

-- CreateEnum
CREATE TYPE "translation_overwrite_policy" AS ENUM ('protect_existing', 'update_ai_managed', 'overwrite_all');

-- CreateEnum
CREATE TYPE "translation_glossary_kind" AS ENUM ('translate', 'protect');

-- CreateEnum
CREATE TYPE "translation_owner" AS ENUM ('ai', 'manual');

-- CreateEnum
CREATE TYPE "translation_sync_kind" AS ENUM ('translate_store', 'language', 'automatic', 'resource');

-- CreateEnum
CREATE TYPE "translation_sync_mode" AS ENUM ('missing', 'missing_outdated', 'force');

-- CreateEnum
CREATE TYPE "translation_sync_status" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "translation_item_status" AS ENUM ('translated', 'copied', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "ai_usage_result" AS ENUM ('ok', 'failed');

-- AlterEnum
ALTER TYPE "exception_kind" ADD VALUE 'translation_failed';

-- CreateTable
CREATE TABLE "translation_language" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_translate_new" BOOLEAN NOT NULL DEFAULT false,
    "auto_update_outdated" BOOLEAN NOT NULL DEFAULT false,
    "content_scope" TEXT[],
    "overwrite_policy" "translation_overwrite_policy" NOT NULL DEFAULT 'update_ai_managed',
    "last_sync_at" TIMESTAMP(3),
    "last_successful_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_language_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_coverage" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resources" INTEGER NOT NULL DEFAULT 0,
    "fields" INTEGER NOT NULL DEFAULT 0,
    "translated" INTEGER NOT NULL DEFAULT 0,
    "outdated" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "missing_chars" INTEGER NOT NULL DEFAULT 0,
    "outdated_chars" INTEGER NOT NULL DEFAULT 0,
    "read_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_glossary_term" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "kind" "translation_glossary_kind" NOT NULL,
    "target_locale" TEXT,
    "source_term" TEXT NOT NULL,
    "target_term" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_glossary_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_source_override" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "source_locale" TEXT NOT NULL,
    "detected_locale" TEXT,
    "set_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_source_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_ownership" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "owner" "translation_owner" NOT NULL,
    "value_hash" TEXT NOT NULL,
    "source_digest" TEXT,
    "sync_id" TEXT,
    "written_by" TEXT,
    "written_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_ownership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_sync" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "kind" "translation_sync_kind" NOT NULL,
    "mode" "translation_sync_mode" NOT NULL,
    "status" "translation_sync_status" NOT NULL DEFAULT 'queued',
    "source_locale" TEXT NOT NULL,
    "target_locales" TEXT[],
    "resource_types" TEXT[],
    "resource_ids" TEXT[],
    "estimate" JSONB,
    "cursor" JSONB,
    "total_resources" INTEGER NOT NULL DEFAULT 0,
    "done_resources" INTEGER NOT NULL DEFAULT 0,
    "translated_fields" INTEGER NOT NULL DEFAULT 0,
    "copied_fields" INTEGER NOT NULL DEFAULT 0,
    "skipped_fields" INTEGER NOT NULL DEFAULT 0,
    "failed_fields" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "requested_by" TEXT,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_sync_item" (
    "id" TEXT NOT NULL,
    "sync_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT,
    "status" "translation_item_status" NOT NULL,
    "fields" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_sync_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "sync_id" TEXT,
    "resource_id" TEXT,
    "resource_type" TEXT,
    "source_locale" TEXT NOT NULL,
    "target_locale" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "result" "ai_usage_result" NOT NULL,
    "error_message" TEXT,
    "pricing_version" TEXT,
    "estimated_cost_micros" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_language_shop_id_locale_key" ON "translation_language"("shop_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "translation_coverage_shop_id_locale_resource_type_key" ON "translation_coverage"("shop_id", "locale", "resource_type");

-- CreateIndex
CREATE INDEX "translation_glossary_term_shop_id_target_locale_idx" ON "translation_glossary_term"("shop_id", "target_locale");

-- CreateIndex
CREATE UNIQUE INDEX "translation_source_override_shop_id_resource_id_key" ON "translation_source_override"("shop_id", "resource_id");

-- CreateIndex
CREATE INDEX "translation_ownership_shop_id_locale_owner_idx" ON "translation_ownership"("shop_id", "locale", "owner");

-- CreateIndex
CREATE UNIQUE INDEX "translation_ownership_shop_id_resource_id_key_locale_key" ON "translation_ownership"("shop_id", "resource_id", "key", "locale");

-- CreateIndex
CREATE INDEX "translation_sync_shop_id_created_at_idx" ON "translation_sync"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "translation_sync_shop_id_status_idx" ON "translation_sync"("shop_id", "status");

-- CreateIndex
CREATE INDEX "translation_sync_item_sync_id_created_at_idx" ON "translation_sync_item"("sync_id", "created_at");

-- CreateIndex
CREATE INDEX "translation_sync_item_sync_id_status_idx" ON "translation_sync_item"("sync_id", "status");

-- CreateIndex
CREATE INDEX "ai_usage_shop_id_created_at_idx" ON "ai_usage"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_sync_id_idx" ON "ai_usage"("sync_id");

-- AddForeignKey
ALTER TABLE "translation_language" ADD CONSTRAINT "translation_language_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_coverage" ADD CONSTRAINT "translation_coverage_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_glossary_term" ADD CONSTRAINT "translation_glossary_term_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_source_override" ADD CONSTRAINT "translation_source_override_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_ownership" ADD CONSTRAINT "translation_ownership_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_sync" ADD CONSTRAINT "translation_sync_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_sync_item" ADD CONSTRAINT "translation_sync_item_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_sync_item" ADD CONSTRAINT "translation_sync_item_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "translation_sync"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "translation_sync"("id") ON DELETE SET NULL ON UPDATE CASCADE;


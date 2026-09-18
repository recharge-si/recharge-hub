-- Taxes and VAT (docs/architecture.md § Tax).
--
-- Until now the whole tax configuration was one field,
-- `product_sync_setting.tax_percent`: the rate sent on an order line when
-- Shopify gave none, and the rate written into a created article's pricelist.
-- Shopify's own transaction tax was read per line, sent as `tax_factor`, and
-- nothing recorded what kind of VAT event a line was, so a 0% reverse charge
-- and a 0% export looked the same and a refund had nothing to reverse against.
--
-- This adds the merchant's tax context (home country and rate, fallback
-- policy, OSS, registrations, country rates, MetaKocka mappings, overrides)
-- and a per-order snapshot of the decision each order was made under.
--
-- Migration of the existing setting, deterministic and without loss:
--
--   * A shop with a readable `tax_percent` gets a `tax_setting` row with that
--     rate as its home rate and `fallback_scope = 'eu'`, which is exactly what
--     the write job did before: the configured rate stood in for a missing
--     Shopify rate on every EU order. Outside the EU the old behaviour also
--     sent the home rate; that was an accounting error rather than a setting,
--     so non-EU orders with no Shopify tax now wait for the export policy
--     (`review`) instead of being filed with home VAT.
--   * OSS is NOT inferred. No registration is invented. Both stay for the
--     merchant to state.
--   * Mappings are seeded for every rate that was already being sent to
--     MetaKocka — 0%, the home rate, every `order_line.tax_factor` on record
--     and every rate observed on the company's own pricelists — so no order
--     that used to send stops sending. A rate never seen stays unmapped and
--     holds the first order that needs it, which is the point.
--   * `order.total_tax_minor` is filled from the stored payload where it can
--     be read; the per-line columns stay null until the order's next pass
--     decides it.

-- CreateEnum
CREATE TYPE "tax_fallback_scope" AS ENUM ('none', 'domestic', 'eu');

-- CreateEnum
CREATE TYPE "non_eu_no_tax_policy" AS ENUM ('review', 'export');

-- CreateEnum
CREATE TYPE "vat_registration_kind" AS ENUM ('domestic', 'oss', 'local');

-- CreateEnum
CREATE TYPE "country_vat_rate_kind" AS ENUM ('standard', 'reduced', 'super_reduced', 'parking', 'zero', 'other');

-- CreateEnum
CREATE TYPE "tax_override_scope" AS ENUM ('country', 'sku');

-- AlterEnum
-- The tax exceptions. They use the existing exception system (queue,
-- re-check, retry) rather than a VAT error system of their own.
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'tax_mapping_missing';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'tax_treatment_unknown';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'tax_reconciliation_failed';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'tax_data_insufficient';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'vat_registration_configuration_error';

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "total_tax_minor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "order_line" ADD COLUMN     "tax_minor" INTEGER,
ADD COLUMN     "tax_rate_key" TEXT,
ADD COLUMN     "tax_source" TEXT,
ADD COLUMN     "tax_treatment" TEXT,
ADD COLUMN     "taxable_minor" INTEGER;

-- CreateTable
CREATE TABLE "tax_setting" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "domestic_country" TEXT NOT NULL DEFAULT 'SI',
    "domestic_rate_key" TEXT,
    "fallback_scope" "tax_fallback_scope" NOT NULL DEFAULT 'domestic',
    "non_eu_no_tax_policy" "non_eu_no_tax_policy" NOT NULL DEFAULT 'review',
    "oss_enabled" BOOLEAN NOT NULL DEFAULT false,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_registration" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "kind" "vat_registration_kind" NOT NULL,
    "country" TEXT NOT NULL,
    "vat_number" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vat_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "country_vat_rate" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "kind" "country_vat_rate_kind" NOT NULL,
    "rate_key" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_vat_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_mapping" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "rate_key" TEXT NOT NULL,
    "metakocka_tax_factor" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_override" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scope" "tax_override_scope" NOT NULL,
    "match" TEXT NOT NULL,
    "treatment" TEXT,
    "rate_key" TEXT,
    "reason" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_tax_snapshot" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "config_version" INTEGER NOT NULL,
    "config_snapshot" JSONB NOT NULL,
    "currency" TEXT NOT NULL,
    "taxes_included" BOOLEAN NOT NULL,
    "destination_country" TEXT,
    "jurisdiction" TEXT NOT NULL,
    "customer_kind" TEXT NOT NULL,
    "vat_number" TEXT,
    "treatment" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "taxable_minor" INTEGER NOT NULL,
    "tax_minor" INTEGER NOT NULL,
    "shopify_tax_minor" INTEGER NOT NULL,
    "reconciled" BOOLEAN NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "rate_keys" TEXT[],
    "decision" JSONB NOT NULL,
    "refunds" JSONB,
    "frozen_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_tax_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_setting_shop_id_key" ON "tax_setting"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "vat_registration_shop_id_kind_country_key" ON "vat_registration"("shop_id", "kind", "country");

-- CreateIndex
CREATE UNIQUE INDEX "country_vat_rate_shop_id_country_kind_key" ON "country_vat_rate"("shop_id", "country", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "tax_mapping_shop_id_rate_key_key" ON "tax_mapping"("shop_id", "rate_key");

-- CreateIndex
CREATE UNIQUE INDEX "tax_override_shop_id_scope_match_key" ON "tax_override"("shop_id", "scope", "match");

-- CreateIndex
CREATE UNIQUE INDEX "order_tax_snapshot_order_id_key" ON "order_tax_snapshot"("order_id");

-- CreateIndex
CREATE INDEX "order_tax_snapshot_shop_id_decided_at_idx" ON "order_tax_snapshot"("shop_id", "decided_at");

-- CreateIndex
CREATE INDEX "order_tax_snapshot_shop_id_ok_idx" ON "order_tax_snapshot"("shop_id", "ok");

-- AddForeignKey
ALTER TABLE "tax_setting" ADD CONSTRAINT "tax_setting_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_registration" ADD CONSTRAINT "vat_registration_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "country_vat_rate" ADD CONSTRAINT "country_vat_rate_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_mapping" ADD CONSTRAINT "tax_mapping_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_override" ADD CONSTRAINT "tax_override_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_tax_snapshot" ADD CONSTRAINT "order_tax_snapshot_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_tax_snapshot" ADD CONSTRAINT "order_tax_snapshot_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Migrate the existing global tax setting
-- ---------------------------------------------------------------------------

-- Home rate from `tax_percent`, canonicalised ("22.0" → "22", "9,50" → "9.5").
INSERT INTO "tax_setting" ("id", "shop_id", "domestic_country", "domestic_rate_key", "fallback_scope", "non_eu_no_tax_policy", "oss_enabled", "config_version", "created_at", "updated_at")
SELECT
  'taxset_' || p."shop_id",
  p."shop_id",
  'SI',
  rtrim(rtrim(to_char(replace(trim(p."tax_percent"), ',', '.')::numeric, 'FM999999990.999999'), '0'), '.'),
  'eu',
  'review',
  false,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "product_sync_setting" p
WHERE p."tax_percent" IS NOT NULL
  AND trim(p."tax_percent") ~ '^[0-9]+([.,][0-9]+)?$'
  AND replace(trim(p."tax_percent"), ',', '.')::numeric BETWEEN 0 AND 100
ON CONFLICT ("shop_id") DO NOTHING;

-- 0% is always mapped: MetaKocka refuses a line without a tax attribute and
-- this app has always sent "0" for a non-taxable line (docs/BUILD_SPEC.md §3).
INSERT INTO "tax_mapping" ("id", "shop_id", "rate_key", "metakocka_tax_factor", "enabled", "created_at", "updated_at")
SELECT 'taxmap_' || s."id" || '_0', s."id", '0', '0', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "shop" s
ON CONFLICT ("shop_id", "rate_key") DO NOTHING;

-- The home rate.
INSERT INTO "tax_mapping" ("id", "shop_id", "rate_key", "metakocka_tax_factor", "enabled", "created_at", "updated_at")
SELECT
  'taxmap_' || t."shop_id" || '_' || t."domestic_rate_key",
  t."shop_id",
  t."domestic_rate_key",
  rtrim(rtrim(to_char(t."domestic_rate_key"::numeric / 100, 'FM999999990.999999'), '0'), '.'),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tax_setting" t
WHERE t."domestic_rate_key" IS NOT NULL
ON CONFLICT ("shop_id", "rate_key") DO NOTHING;

-- Every rate already sent on an order line, exactly as it was sent.
INSERT INTO "tax_mapping" ("id", "shop_id", "rate_key", "metakocka_tax_factor", "enabled", "created_at", "updated_at")
SELECT DISTINCT ON (o."shop_id", rk.rate_key)
  'taxmap_' || o."shop_id" || '_' || rk.rate_key,
  o."shop_id",
  rk.rate_key,
  rtrim(rtrim(to_char(replace(trim(l."tax_factor"), ',', '.')::numeric, 'FM999999990.999999'), '0'), '.'),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "order_line" l
JOIN "order" o ON o."id" = l."order_id"
CROSS JOIN LATERAL (
  SELECT rtrim(rtrim(to_char(replace(trim(l."tax_factor"), ',', '.')::numeric * 100, 'FM999999990.999999'), '0'), '.') AS rate_key
) rk
WHERE l."tax_factor" IS NOT NULL
  AND trim(l."tax_factor") ~ '^[0-9]+([.,][0-9]+)?$'
  AND replace(trim(l."tax_factor"), ',', '.')::numeric BETWEEN 0 AND 1
ON CONFLICT ("shop_id", "rate_key") DO NOTHING;

-- Every rate observed on the company's own MetaKocka pricelists: a rate the
-- ERP demonstrably has.
INSERT INTO "tax_mapping" ("id", "shop_id", "rate_key", "metakocka_tax_factor", "enabled", "created_at", "updated_at")
SELECT DISTINCT ON (r."shop_id", rk.rate_key)
  'taxmap_' || r."shop_id" || '_' || rk.rate_key,
  r."shop_id",
  rk.rate_key,
  rtrim(rtrim(to_char(replace(trim(r."percent"), ',', '.')::numeric / 100, 'FM999999990.999999'), '0'), '.'),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "metakocka_tax_rate" r
CROSS JOIN LATERAL (
  SELECT rtrim(rtrim(to_char(replace(trim(r."percent"), ',', '.')::numeric, 'FM999999990.999999'), '0'), '.') AS rate_key
) rk
WHERE trim(r."percent") ~ '^[0-9]+([.,][0-9]+)?$'
  AND replace(trim(r."percent"), ',', '.')::numeric BETWEEN 0 AND 100
ON CONFLICT ("shop_id", "rate_key") DO NOTHING;

-- Shopify's order tax total, from the stored payload, for orders that still
-- have one. Presentment money first, like every other amount (§8.6).
UPDATE "order" o
SET "total_tax_minor" = round(amount.value * 100)::integer
FROM (
  SELECT
    o2."id",
    COALESCE(
      o2."raw_payload" -> 'total_tax_set' -> 'presentment_money' ->> 'amount',
      o2."raw_payload" -> 'total_tax_set' -> 'shop_money' ->> 'amount',
      o2."raw_payload" ->> 'total_tax'
    ) AS raw
  FROM "order" o2
  WHERE o2."raw_payload" IS NOT NULL
) src
CROSS JOIN LATERAL (
  SELECT CASE WHEN src.raw ~ '^-?[0-9]+(\.[0-9]+)?$' THEN src.raw::numeric ELSE NULL END AS value
) amount
WHERE o."id" = src."id"
  AND amount.value IS NOT NULL;

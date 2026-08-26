-- Shipping and discount representation.
--
-- Verified against the designated test company on 2026-08-26
-- (docs/metakocka-verification.md, tests/fixtures/metakocka/shipping_discount_semantics.json):
--
--   * an extra positive product line adds to sum_all exactly, so shipping is a
--     line written against a product code the merchant supplies;
--   * the document-level `discount_value` is an ABSOLUTE amount, which is what
--     Shopify supplies, while the per-line `discount` is a PERCENTAGE and would
--     need a conversion this app has no authority to invent.
--
-- Both settings default to "not configured" on purpose. Until a merchant
-- chooses, an order carrying shipping or a discount raises
-- `commercial_representation_missing` and is not reported as commercially
-- reconciled - which is better than quietly sending a sales order that is short
-- of the postage the customer paid.

-- CreateEnum
CREATE TYPE "discount_representation" AS ENUM ('none', 'document_discount_value');

-- AlterEnum
ALTER TYPE "exception_kind" ADD VALUE 'commercial_representation_missing';

-- AlterTable
ALTER TABLE "sales_order_setting"
  ADD COLUMN "shipping_product_code" TEXT,
  ADD COLUMN "discount_representation" "discount_representation" NOT NULL DEFAULT 'none';

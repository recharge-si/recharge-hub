-- Who decides a sales order's number.
--
-- MetaKocka's `count_code` is what its screen labels "Sales ord. no.". This
-- connector has always sent one, derived from the customer's order reference,
-- so every document reads SH-1050 rather than the ERP's own 1/2026. That is
-- right for a merchant who wants the two systems to share a reference and wrong
-- for one whose accountant expects MetaKocka's own numbering.
--
-- Two things change, and the second is the important one:
--
--   * `sales_order_setting` gains the choice, plus a pattern of its own for
--     when the app numbers them. The pattern defaults to NULL, meaning "the
--     same as the customer's order reference" - which is exactly what every
--     existing document carries, so nothing renumbers.
--
--   * `metakocka_document.count_code` stops being "what MetaKocka was told" and
--     becomes only what it always had to be: this app's internal claim key, and
--     the sole duplicate guard, since section 3 verified MetaKocka does not
--     enforce uniqueness on it. What actually went on the wire - or what
--     MetaKocka answered with, when it numbered the document itself - is
--     recorded separately in `sent_count_code`.
--
-- The backfill is exact: every existing row sent its `count_code`, so that is
-- what it holds.

-- CreateEnum
CREATE TYPE "sales_order_numbering" AS ENUM ('app', 'metakocka');

-- AlterTable
ALTER TABLE "sales_order_setting"
  ADD COLUMN "sales_order_numbering" "sales_order_numbering" NOT NULL DEFAULT 'app',
  ADD COLUMN "sales_order_number_template" TEXT;

-- AlterTable
ALTER TABLE "metakocka_document"
  ADD COLUMN "sent_count_code" TEXT;

UPDATE "metakocka_document" SET "sent_count_code" = "count_code";

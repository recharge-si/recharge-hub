-- Product title and option values kept apart, so an order line can show what
-- it is and then which one of it.

-- AlterTable
ALTER TABLE "sku" ADD COLUMN     "variant_title" TEXT;

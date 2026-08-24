-- CreateEnum
CREATE TYPE "stock_direction" AS ENUM ('mk_to_shopify', 'shopify_to_mk', 'none');

-- AlterTable
ALTER TABLE "metakocka_credential" ADD COLUMN     "api_user_email" TEXT;

-- AlterTable
ALTER TABLE "supply_source" ADD COLUMN     "stock_direction" "stock_direction" NOT NULL DEFAULT 'none';


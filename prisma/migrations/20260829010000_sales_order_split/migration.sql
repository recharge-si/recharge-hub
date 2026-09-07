-- Whether one Shopify order becomes one MetaKocka sales order or several.
--
-- MetaKocka's `warehouse` is document-level (docs/BUILD_SPEC.md section 3), so
-- an order fulfilled from two warehouses can only be described as two
-- documents. That is what this connector has always done and it stays the
-- default: it is the only shape in which the ERP holds where goods actually
-- left from.
--
-- `single` is the other answer, and it is a real one. A shop that does not run
-- its warehouses in MetaKocka - or that simply wants the sales order to mirror
-- the Shopify order one for one - gets a single document carrying every line,
-- with NO warehouse mark on it, so MetaKocka files it against the company
-- default. Nothing is allocated to a warehouse under `single`, so
-- `allocation_mode` has no effect there.
--
-- Additive and defaulted, so every existing shop keeps the behaviour it has.

-- CreateEnum
CREATE TYPE "sales_order_split" AS ENUM ('per_warehouse', 'single');

-- AlterTable
ALTER TABLE "sales_order_setting"
  ADD COLUMN "sales_order_split" "sales_order_split" NOT NULL DEFAULT 'per_warehouse';

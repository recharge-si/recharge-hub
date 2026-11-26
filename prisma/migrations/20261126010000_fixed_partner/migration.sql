-- One MetaKocka partner for every sales order (docs/architecture.md § Order
-- partner). Additive: three nullable columns, null for every existing shop, so
-- nothing changes until a merchant sets one.
ALTER TABLE "sales_order_setting" ADD COLUMN "fixed_partner" JSONB;
ALTER TABLE "sales_order_setting" ADD COLUMN "fixed_partner_mk_id" TEXT;
ALTER TABLE "sales_order_setting" ADD COLUMN "fixed_partner_mk_address_id" TEXT;

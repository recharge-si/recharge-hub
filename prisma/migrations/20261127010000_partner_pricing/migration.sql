-- Partner pricing and the document title (docs/architecture.md § Who an order
-- is filed against). Additive: three nullable columns, null for every existing
-- shop, so nothing changes until a merchant sets them.
ALTER TABLE "sales_order_setting" ADD COLUMN "partner_pricelist_code" TEXT;
ALTER TABLE "sales_order_setting" ADD COLUMN "partner_discount_percent" TEXT;
ALTER TABLE "sales_order_setting" ADD COLUMN "document_title_template" TEXT;

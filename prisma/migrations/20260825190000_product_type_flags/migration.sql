-- What kind of article product sync creates in MetaKocka: Prodajni (sales),
-- Nabavni (purchasing), Storitev (service). Those three are the only flags
-- `product_add` accepts; the Delo and Osnovno sredstvo boxes in the MetaKocka
-- UI have no API field, so they are not stored.
--
-- The defaults are what the job already hardcoded, so an existing row keeps
-- behaving exactly as it did until the merchant changes it.
ALTER TABLE "product_sync_setting"
  ADD COLUMN "product_sales" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "product_purchasing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "product_service" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "update_product_type" BOOLEAN NOT NULL DEFAULT false;
